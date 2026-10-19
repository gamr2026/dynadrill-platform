/**
 * Integración real de QHSE: tarjeta STOP e inspecciones de campo, con las reglas de la base.
 *   RUN_INTEGRATION=1 npx jest stop-inspecciones   (dentro de libs/qhse/seguridad; requiere `npm run db:seed:qhse`)
 */
import { Permission } from '@dyn/authz';
import { uuidv7 } from '@dyn/utils';
import { levantarAppDePrueba, type AppDePrueba } from '../testing/app-de-prueba';
import { quitarMaestros, sembrarMaestros, type MaestrosDePrueba } from '../testing/maestros';

const run = process.env['RUN_INTEGRATION'] ? describe : describe.skip;
const n = Date.now();
const P = Permission;

const TECNICO = { id: uuidv7(), nombre: 'Tania Técnica HSE' };
const OPERADOR = { id: uuidv7(), nombre: 'Oscar Operador' };
const OBSERVADO = { id: uuidv7(), nombre: 'Olga Observada' };
const MAESTROS: MaestrosDePrueba = {
  usuarios: [
    { ...TECNICO, rol: 'tecnico_hse' },
    { ...OPERADOR, rol: 'operador' },
    { ...OBSERVADO, rol: 'operador' },
  ],
};

type Salida = {
  datos: { source: string; actor?: { userId: string }; data: Record<string, unknown> };
};
const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Guayaquil' });

run('QHSE: tarjeta STOP e inspecciones de campo (base de datos real)', () => {
  jest.setTimeout(180000);
  let t: AppDePrueba;
  const sql = (texto: string, params: unknown[] = []) => t.admin.query(texto, params);

  const operador = () => t.token('operador', OPERADOR.nombre, [P.QHSE_REPORTAR], OPERADOR.id);
  const tecnico = () =>
    t.token(
      'tecnico_hse',
      TECNICO.nombre,
      [P.QHSE_REPORTAR, P.STOP_VER, P.STOP_GESTIONAR, P.QHSE_INSPECCIONES_VER],
      TECNICO.id,
    );
  const eventos = async (tipo: string, llave: string, valor: string) =>
    (
      await sql(
        `SELECT datos FROM msg_qhse.outbox WHERE tipo = $1 AND datos->'data'->>'${llave}' = $2 ORDER BY ocurrido_at, id`,
        [tipo, valor],
      )
    ).rows as Salida[];

  // ----------------------------------------------------------------------------------------------------------- STOP
  let items: Array<{ id: string; nombre: string }> = [];
  const registrarStop = (cuerpo: Record<string, unknown>, quien = operador()) =>
    t.http().post('/api/qhse/stop').set(quien).send(cuerpo);
  const stop = async (extra: Record<string, unknown> = {}) => {
    const r = await registrarStop({
      items: [
        { itemId: items[0].id, estado: 'inseguro' },
        { itemId: items[1].id, estado: 'seguro' },
      ],
      lugar: 'Locación 4',
      ...extra,
    });
    expect(r.status).toBe(201);
    return r.body as { id: string; codigo: string; estado: string };
  };
  const accionStop = (
    id: string,
    ruta: string,
    cuerpo: Record<string, unknown> = {},
    quien = tecnico(),
  ) => t.http().post(`/api/qhse/stop/${id}/${ruta}`).set(quien).send(cuerpo);

  // ----------------------------------------------------------------------------------------------- inspecciones
  type Tipo = {
    id: string;
    codigo: string;
    requiereBumpTest: boolean;
    requiereUnidad: boolean;
    criterios: Array<{ id: string; nombre: string }>;
  };
  let tipos: Record<string, Tipo> = {};
  const inspeccionar = (
    codigo: string,
    cuerpo: Record<string, unknown> = {},
    fallan: number[] = [],
    quien = operador(),
  ) => {
    const tp = tipos[codigo];
    return t
      .http()
      .post('/api/qhse/inspecciones')
      .set(quien)
      .send({
        tipoId: tp.id,
        equipoCodigo: `EQ-${n}-${codigo}`,
        resultados: tp.criterios.map((c, i) => ({ criterioId: c.id, cumple: !fallan.includes(i) })),
        ...(tp.requiereBumpTest ? { bumpTestRealizado: true } : {}),
        ...(tp.requiereUnidad ? { unidadId: uuidv7(), unidadCodigo: `PUM-${n}` } : {}),
        ...cuerpo,
      });
  };

  beforeAll(async () => {
    t = await levantarAppDePrueba('3199');
    await sembrarMaestros(t.admin, MAESTROS);
    const f = await t.http().get('/api/qhse/stop/formato').set(operador());
    items = [...f.body.acciones, ...f.body.condiciones].flatMap(
      (s: { items: Array<{ id: string; nombre: string }> }) => s.items,
    );
    const ts = (await t.http().get('/api/qhse/inspecciones/tipos').set(operador())).body as Tipo[];
    tipos = Object.fromEntries(ts.map((x) => [x.codigo, x]));
  });

  afterAll(async () => {
    await sql(
      'DELETE FROM qhse.stop_tarjeta WHERE observador_id = ANY($1::uuid[]) OR created_by = ANY($1::uuid[])',
      [[OPERADOR.id, TECNICO.id, OBSERVADO.id]],
    );
    await sql('DELETE FROM qhse.inspeccion WHERE inspector_id = ANY($1::uuid[])', [
      [OPERADOR.id, TECNICO.id],
    ]);
    await sql(
      "DELETE FROM msg_qhse.outbox WHERE datos->'data'->>'equipoCodigo' LIKE $1 OR datos->'data'->>'observador' = $2 OR datos->'data'->>'lugar' LIKE $3",
      [`EQ-${n}-%`, OPERADOR.nombre, 'Locación 4%'],
    );
    await quitarMaestros(t.admin, MAESTROS);
    await t.cerrar();
  });

  describe('tarjeta STOP', () => {
    it('el formato del DYN-SGI-RE-008 trae los dos bloques con sus subcategorías e ítems', async () => {
      const f = (await t.http().get('/api/qhse/stop/formato').set(operador())).body;
      expect(f.acciones.map((s: { nombre: string }) => s.nombre)).toEqual([
        'Uso de EPP',
        'Herramientas y equipos',
        'Manejo de cargas',
        'Posiciones de trabajo',
        'Comportamiento en oficina',
      ]);
      expect(f.condiciones).toHaveLength(5);
      expect(items.length).toBeGreaterThanOrEqual(47);
    });

    it('cualquier trabajador registra; el observador es quien tiene la sesión; no ve la bandeja y se publica qhse.stop.registrada', async () => {
      const r = await registrarStop({
        observadoId: OBSERVADO.id,
        lugar: `Locación 4 ${n}`,
        accionesQueObserva: 'No usaba casco',
        items: [
          { itemId: items[0].id, estado: 'inseguro' },
          { itemId: items[1].id, estado: 'seguro' },
          { itemId: items[0].id, estado: 'seguro' },
        ],
      });
      expect(r.status).toBe(201);
      expect(r.body).toEqual({
        id: expect.any(String),
        codigo: expect.stringMatching(/^STOP-\d{6}$/),
        estado: 'abierto',
      });
      expect((await t.http().get('/api/qhse/stop').set(operador())).status).toBe(403);
      const d = (await t.http().get(`/api/qhse/stop/${r.body.id}`).set(tecnico())).body;
      expect(d).toMatchObject({
        estado: 'abierto',
        observador: { id: OPERADOR.id },
        observado: { id: OBSERVADO.id },
        fecha: hoy,
        accionesQueObserva: 'No usaba casco',
      });
      // el ítem repetido se deduplica (queda el primero)
      expect(d.items).toHaveLength(2);
      expect(d.historial.map((h: { estadoNuevo: string }) => h.estadoNuevo)).toEqual(['abierto']);
      const ev = await eventos('qhse.stop.registrada', 'tarjetaId', r.body.id);
      expect(ev).toHaveLength(1);
      expect(ev[0].datos.actor?.userId).toBe(OPERADOR.id);
      expect(ev[0].datos.data).toMatchObject({ inseguros: 1, observador: OPERADOR.nombre });
      // con un ítem inseguro se publica además el hecho que avisa al Técnico HSE; con solo ítems seguros, no
      expect(await eventos('qhse.stop.con_hallazgos', 'tarjetaId', r.body.id)).toHaveLength(1);
      const soloSeguros = await registrarStop({
        lugar: 'Locación 4 seguros',
        items: [{ itemId: items[2].id, estado: 'seguro' }],
      });
      expect(
        await eventos('qhse.stop.con_hallazgos', 'tarjetaId', soloSeguros.body.id),
      ).toHaveLength(0);
    });

    it('valida la tarjeta: al menos un ítem, ítems del formato, no observarse a uno mismo y datos que existan', async () => {
      expect((await registrarStop({ items: [] })).status).toBe(400);
      expect(
        (await registrarStop({ items: [{ itemId: uuidv7(), estado: 'seguro' }] })).status,
      ).toBe(400);
      expect(
        (await registrarStop({ items: [{ itemId: items[0].id, estado: 'regular' }] })).status,
      ).toBe(400);
      const prop = { items: [{ itemId: items[0].id, estado: 'inseguro' }] };
      expect((await registrarStop({ ...prop, observadoId: OPERADOR.id })).status).toBe(400);
      expect((await registrarStop({ ...prop, observadoId: uuidv7() })).status).toBe(400);
      expect((await registrarStop({ ...prop, campoId: uuidv7() })).status).toBe(400);
      expect((await registrarStop({ ...prop, ticketId: uuidv7() })).status).toBe(400);
      expect((await registrarStop({ ...prop, fotoArchivoId: uuidv7() })).status).toBe(400);
    });

    it('QHSE la deriva a Mantenimiento con su observación y la cierra; las transiciones inválidas se rechazan', async () => {
      const a = await stop();
      expect(
        (await accionStop(a.id, 'derivar', { destino: 'mantenimiento', observacion: '  ' })).status,
      ).toBe(400);
      expect(
        (
          await accionStop(
            a.id,
            'derivar',
            { destino: 'mantenimiento', observacion: 'X' },
            operador(),
          )
        ).status,
      ).toBe(403);
      expect((await accionStop(a.id, 'cerrar')).status).toBe(409); // aún abierta
      const der = await accionStop(a.id, 'derivar', {
        destino: 'mantenimiento',
        observacion: 'Revisar el equipo de la locación',
      });
      expect(der.status).toBe(201);
      expect(der.body).toMatchObject({
        estado: 'derivado_mantenimiento',
        atendidoPor: TECNICO.nombre,
        atendidoObservacion: 'Revisar el equipo de la locación',
      });
      expect((await eventos('qhse.stop.derivada', 'tarjetaId', a.id))[0].datos.data).toMatchObject({
        estado: 'derivado_mantenimiento',
      });
      expect((await accionStop(a.id, 'resolver', { observacion: 'x' })).status).toBe(409);
      const cerrada = await accionStop(a.id, 'cerrar');
      expect(cerrada.status).toBe(201);
      expect(cerrada.body).toMatchObject({ estado: 'cerrado', cerradoPor: TECNICO.nombre });
      expect(await eventos('qhse.stop.cerrada', 'tarjetaId', a.id)).toHaveLength(1);
      expect(cerrada.body.historial.map((h: { estadoNuevo: string }) => h.estadoNuevo)).toEqual([
        'abierto',
        'derivado_mantenimiento',
        'cerrado',
      ]);
      expect((await accionStop(a.id, 'cerrar')).status).toBe(409);
    });

    it('QHSE la resuelve por sí misma y queda terminada', async () => {
      const a = await stop();
      const r = await accionStop(a.id, 'resolver', {
        observacion: 'Se habló con el equipo y se corrigió',
      });
      expect(r.status).toBe(201);
      expect(r.body.estado).toBe('resuelto_qhse');
      expect(await eventos('qhse.stop.resuelta', 'tarjetaId', a.id)).toHaveLength(1);
      expect((await accionStop(a.id, 'cerrar')).status).toBe(409);
      expect(
        (await accionStop(a.id, 'derivar', { destino: 'otro', observacion: 'x' })).status,
      ).toBe(409);
    });

    it('las tendencias cuentan los ítems inseguros por subcategoría (Pareto) y las tarjetas por mes', async () => {
      const sub = (
        await sql(
          'SELECT s.nombre FROM qhse.stop_item i JOIN qhse.stop_subcategoria s ON s.id = i.subcategoria_id WHERE i.id = $1',
          [items[0].id],
        )
      ).rows[0].nombre as string;
      await stop();
      await stop();
      const tr = (await t.http().get('/api/qhse/stop/tendencias').set(tecnico())).body;
      expect(tr.totalTarjetas).toBeGreaterThanOrEqual(2);
      const fila = tr.porSubcategoria.find((x: { subcategoria: string }) => x.subcategoria === sub);
      expect(fila.inseguros).toBeGreaterThanOrEqual(2);
      // ordenado de mayor a menor
      const cuentas = tr.porSubcategoria.map((x: { inseguros: number }) => x.inseguros);
      expect([...cuentas].sort((a: number, b: number) => b - a)).toEqual(cuentas);
      expect(tr.porMes.some((m: { mes: string }) => m.mes === hoy.slice(0, 7))).toBe(true);
      expect((await t.http().get('/api/qhse/stop/tendencias').set(operador())).status).toBe(403);
    });

    describe('reglas de la base', () => {
      const cabecera = (conObservado = false): [string, unknown[]] => [
        `INSERT INTO qhse.stop_tarjeta (id, observador_id, fecha, created_by${conObservado ? ', observado_id' : ''}) VALUES ($1, $2, CURRENT_DATE, $2${conObservado ? ', $2' : ''})`,
        [uuidv7(), OPERADOR.id],
      ];

      it('una tarjeta sin ítems no se confirma, y observador y observado no pueden ser la misma persona', async () => {
        const c = await t.admin.connect();
        try {
          await c.query('BEGIN');
          const [texto, params] = cabecera();
          await c.query(texto, params);
          await expect(c.query('COMMIT')).rejects.toThrow(/al menos un ítem marcado/);
        } finally {
          await c.query('ROLLBACK').catch(() => undefined);
          c.release();
        }
        const [conObservado, paramsObservado] = cabecera(true);
        await expect(sql(conObservado, paramsObservado)).rejects.toThrow(
          /stop_tarjeta_observado_check/,
        );
      });

      it('cada estado trae sus datos, no se salta de estado y lo observado no se reescribe ni se borra', async () => {
        const a = await stop();
        await expect(
          sql("UPDATE qhse.stop_tarjeta SET estado = 'cerrado' WHERE id = $1", [a.id]),
        ).rejects.toThrow(/Cambio de estado no permitido/);
        await expect(
          sql("UPDATE qhse.stop_tarjeta SET estado = 'resuelto_qhse' WHERE id = $1", [a.id]),
        ).rejects.toThrow(/stop_tarjeta_estado_check/);
        await expect(
          t.prisma.stopTarjeta.update({ where: { id: a.id }, data: { lugar: 'otro sitio' } }),
        ).rejects.toThrow(/permission denied|denegado/i);
        await expect(
          t.prisma.stopTarjeta.update({ where: { id: a.id }, data: { observadorId: TECNICO.id } }),
        ).rejects.toThrow(/permission denied|denegado/i);
        await expect(t.prisma.stopTarjeta.delete({ where: { id: a.id } })).rejects.toThrow(
          /permission denied|denegado/i,
        );
        await expect(
          t.prisma.stopTarjetaItem.updateMany({
            where: { tarjetaId: a.id },
            data: { estado: 'seguro' },
          }),
        ).rejects.toThrow(/permission denied|denegado/i);
        await expect(
          t.prisma.stopTarjetaItem.deleteMany({ where: { tarjetaId: a.id } }),
        ).rejects.toThrow(/permission denied|denegado/i);
        await expect(
          t.prisma.stopHistorial.deleteMany({ where: { tarjetaId: a.id } }),
        ).rejects.toThrow(/permission denied|denegado/i);
        await expect(
          sql(
            "INSERT INTO qhse.stop_tarjeta (id, observador_id, fecha, created_by, estado) VALUES ($1, $2, CURRENT_DATE, $2, 'cerrado')",
            [uuidv7(), OPERADOR.id],
          ),
        ).rejects.toThrow(/nace abierta|stop_tarjeta_estado_check/);
      });
    });
  });

  describe('inspecciones de campo', () => {
    it('los tipos traen sus criterios de rechazo y el comportamiento sale de columnas (frecuencia, bump test, unidad, caso de Mantenimiento)', () => {
      expect(Object.keys(tipos).sort()).toEqual(['detector_gas', 'eslinga_cable', 'vehiculo_grua']);
      expect(tipos['eslinga_cable'].criterios).toHaveLength(4);
      expect(tipos['detector_gas']).toMatchObject({
        requiereBumpTest: true,
        requiereUnidad: false,
      });
      expect(tipos['vehiculo_grua']).toMatchObject({
        requiereBumpTest: false,
        requiereUnidad: true,
      });
    });

    it('aprobada con todos los criterios: vigencia trimestral, el equipo no queda en cuarentena y quien inspecciona no ve la bandeja', async () => {
      const r = await inspeccionar('eslinga_cable');
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({ resultado: 'aprobado', enCuarentena: false });
      const d = (await t.http().get(`/api/qhse/inspecciones/${r.body.id}`).set(tecnico())).body;
      const [a, m, dia] = hoy.split('-').map(Number);
      const esperado = new Date(Date.UTC(a, m - 1 + 3, dia));
      if (esperado.getUTCDate() !== dia) esperado.setUTCDate(0);
      expect(d).toMatchObject({
        resultado: 'aprobado',
        fecha: hoy,
        vigenteHasta: esperado.toISOString().slice(0, 10),
        inspector: OPERADOR.nombre,
      });
      expect(d.criterios.every((c: { cumple: boolean }) => c.cumple)).toBe(true);
      expect((await t.http().get('/api/qhse/inspecciones').set(operador())).status).toBe(403);
      const ev = await eventos('qhse.inspeccion.registrada', 'inspeccionId', r.body.id);
      expect(ev).toHaveLength(1);
      expect(ev[0].datos.data).toMatchObject({ tipo: 'eslinga_cable', resultado: 'aprobado' });
      expect(await eventos('qhse.reporte_unidad.generado', 'inspeccionId', r.body.id)).toHaveLength(
        0,
      );
      // aprobada: no hay aviso de cuarentena
      expect(await eventos('qhse.inspeccion.rechazada', 'inspeccionId', r.body.id)).toHaveLength(0);
    });

    it('con un solo criterio que falla se rechaza y el equipo queda en cuarentena hasta una inspección nueva aprobada', async () => {
      const eq = `EQ-${n}-cuarentena`;
      const rechaza = await inspeccionar('eslinga_cable', { equipoCodigo: eq }, [1]);
      expect(rechaza.body).toMatchObject({ resultado: 'rechazado', enCuarentena: true });
      expect(
        await eventos('qhse.inspeccion.rechazada', 'inspeccionId', rechaza.body.id),
      ).toHaveLength(1);
      const lista = (await t.http().get('/api/qhse/inspecciones/equipos').set(tecnico())).body;
      expect(lista.find((e: { equipoCodigo: string }) => e.equipoCodigo === eq)).toMatchObject({
        enCuarentena: true,
        ultimaInspeccion: { resultado: 'rechazado' },
      });
      // una eslinga rechazada no genera caso de Mantenimiento (no es una unidad)
      expect(
        await eventos('qhse.reporte_unidad.generado', 'inspeccionId', rechaza.body.id),
      ).toHaveLength(0);
      const aprueba = await inspeccionar('eslinga_cable', { equipoCodigo: eq.toUpperCase() });
      expect(aprueba.body.resultado).toBe('aprobado');
      const despues = (
        await t.http().get('/api/qhse/inspecciones/equipos').set(tecnico())
      ).body.filter(
        (e: { equipoCodigo: string }) => e.equipoCodigo.toLowerCase() === eq.toLowerCase(),
      );
      expect(despues).toHaveLength(1);
      expect(despues[0].enCuarentena).toBe(false);
      // próxima inspección debida: la eslinga es trimestral (90 días)
      expect(despues[0].diasParaProxima).toBe(90);
      expect(despues[0].atrasada).toBe(false);
    });

    it('un vehículo-grúa rechazado origina el reporte de unidad para Mantenimiento (qhse.reporte_unidad.generado)', async () => {
      const unidadId = uuidv7();
      const r = await inspeccionar(
        'vehiculo_grua',
        { unidadId, unidadCodigo: `GRU-${n}`, observaciones: 'Fuga en el estabilizador' },
        [1, 2],
      );
      expect(r.body).toMatchObject({ resultado: 'rechazado', enCuarentena: true });
      const ev = await eventos('qhse.reporte_unidad.generado', 'inspeccionId', r.body.id);
      expect(ev).toHaveLength(1);
      expect(ev[0].datos.source).toBe('qhse');
      expect(ev[0].datos.actor?.userId).toBe(OPERADOR.id);
      const d = ev[0].datos.data;
      expect(d).toMatchObject({ casoId: r.body.id, unidadId, unidadCodigo: `GRU-${n}` });
      expect(String(d['novedad'])).toMatch(
        /Estabilizadores y niveles sin fugas; Cable\/pluma sin daño visible/,
      );
      expect(String(d['novedad'])).toMatch(/Fuga en el estabilizador/);
      // una grúa aprobada no genera caso
      const ok = await inspeccionar('vehiculo_grua');
      expect(
        await eventos('qhse.reporte_unidad.generado', 'inspeccionId', ok.body.id),
      ).toHaveLength(0);
    });

    it('valida la inspección: todos los criterios, la unidad, el bump test y que el criterio sea del tipo', async () => {
      const eslinga = tipos['eslinga_cable'];
      expect(
        (
          await inspeccionar('eslinga_cable', {
            resultados: eslinga.criterios.slice(1).map((c) => ({ criterioId: c.id, cumple: true })),
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await inspeccionar('eslinga_cable', {
            resultados: [
              ...eslinga.criterios.map((c) => ({ criterioId: c.id, cumple: true })),
              { criterioId: tipos['detector_gas'].criterios[0].id, cumple: true },
            ],
          })
        ).status,
      ).toBe(400);
      expect((await inspeccionar('eslinga_cable', { equipoCodigo: '  ' })).status).toBe(400);
      expect((await inspeccionar('eslinga_cable', { unidadId: uuidv7() })).status).toBe(400);
      expect((await inspeccionar('eslinga_cable', { bumpTestRealizado: true })).status).toBe(400);
      expect(
        (await inspeccionar('vehiculo_grua', { unidadId: undefined, unidadCodigo: undefined }))
          .status,
      ).toBe(400);
      expect((await inspeccionar('detector_gas', { bumpTestRealizado: undefined })).status).toBe(
        400,
      );
      expect((await inspeccionar('detector_gas')).status).toBe(201);
      expect(
        (
          await t
            .http()
            .post('/api/qhse/inspecciones')
            .set(operador())
            .send({ tipoId: uuidv7(), equipoCodigo: 'x', resultados: [] })
        ).status,
      ).toBe(400);
    });

    describe('reglas de la base', () => {
      const idEslinga = () => tipos['eslinga_cable'].id;
      const cab = (
        id: string,
        resultado: string,
        fecha = hoy,
        vigente = "(CURRENT_DATE + INTERVAL '3 months')::date",
      ) =>
        sql(
          `INSERT INTO qhse.inspeccion (id, tipo_id, equipo_codigo, inspector_id, fecha, resultado, vigente_hasta, created_by) VALUES ($1, $2, 'EQ-${n}-raw', $3, '${fecha}', $4, ${vigente}, $3)`,
          [id, idEslinga(), OPERADOR.id, resultado],
        );

      it('el resultado debe corresponder a los criterios y se evalúan todos (se comprueba al confirmar)', async () => {
        const c = await t.admin.connect();
        try {
          await c.query('BEGIN');
          const id = uuidv7();
          await c.query(
            `INSERT INTO qhse.inspeccion (id, tipo_id, equipo_codigo, inspector_id, fecha, resultado, vigente_hasta, created_by) VALUES ($1, $2, 'EQ-${n}-raw', $3, CURRENT_DATE, 'aprobado', (CURRENT_DATE + INTERVAL '3 months')::date, $3)`,
            [id, idEslinga(), OPERADOR.id],
          );
          // aprobada pero con un criterio que falla
          for (const [i, cr] of tipos['eslinga_cable'].criterios.entries())
            await c.query(
              'INSERT INTO qhse.inspeccion_resultado (inspeccion_id, criterio_id, cumple) VALUES ($1, $2, $3)',
              [id, cr.id, i !== 0],
            );
          await expect(c.query('COMMIT')).rejects.toThrow(
            /El resultado no corresponde a los criterios/,
          );
        } finally {
          await c.query('ROLLBACK').catch(() => undefined);
          c.release();
        }
        const c2 = await t.admin.connect();
        try {
          await c2.query('BEGIN');
          const id = uuidv7();
          await c2.query(
            `INSERT INTO qhse.inspeccion (id, tipo_id, equipo_codigo, inspector_id, fecha, resultado, vigente_hasta, created_by) VALUES ($1, $2, 'EQ-${n}-raw', $3, CURRENT_DATE, 'aprobado', (CURRENT_DATE + INTERVAL '3 months')::date, $3)`,
            [id, idEslinga(), OPERADOR.id],
          );
          await c2.query(
            'INSERT INTO qhse.inspeccion_resultado (inspeccion_id, criterio_id, cumple) VALUES ($1, $2, true)',
            [id, tipos['eslinga_cable'].criterios[0].id],
          );
          await expect(c2.query('COMMIT')).rejects.toThrow(/Falta evaluar 3 criterio/);
        } finally {
          await c2.query('ROLLBACK').catch(() => undefined);
          c2.release();
        }
      });

      it('la vigencia es trimestral, las reglas del tipo salen de sus columnas y el criterio debe ser del tipo', async () => {
        await expect(
          cab(uuidv7(), 'aprobado', hoy, "(CURRENT_DATE + INTERVAL '4 months')::date"),
        ).rejects.toThrow(/inspeccion_vigencia_check/);
        // un tipo que exige unidad no admite inspección sin ella, y uno que no la exige no admite una unidad
        await expect(
          sql(
            `INSERT INTO qhse.inspeccion (id, tipo_id, equipo_codigo, inspector_id, fecha, resultado, vigente_hasta, created_by) VALUES ($1, $2, 'G', $3, CURRENT_DATE, 'aprobado', (CURRENT_DATE + INTERVAL '3 months')::date, $3)`,
            [uuidv7(), tipos['vehiculo_grua'].id, OPERADOR.id],
          ),
        ).rejects.toThrow(/es de una unidad/);
        await expect(
          sql(
            `INSERT INTO qhse.inspeccion (id, tipo_id, equipo_codigo, unidad_id, unidad_codigo, inspector_id, fecha, resultado, vigente_hasta, created_by) VALUES ($1, $2, 'E', $3, 'U', $4, CURRENT_DATE, 'aprobado', (CURRENT_DATE + INTERVAL '3 months')::date, $4)`,
            [uuidv7(), idEslinga(), uuidv7(), OPERADOR.id],
          ),
        ).rejects.toThrow(/no es de una unidad/);
        await expect(
          sql(
            `INSERT INTO qhse.inspeccion (id, tipo_id, equipo_codigo, inspector_id, fecha, resultado, vigente_hasta, created_by) VALUES ($1, $2, 'D', $3, CURRENT_DATE, 'aprobado', (CURRENT_DATE + INTERVAL '3 months')::date, $3)`,
            [uuidv7(), tipos['detector_gas'].id, OPERADOR.id],
          ),
        ).rejects.toThrow(/bump test/);
        await expect(
          sql(
            `INSERT INTO qhse.inspeccion (id, tipo_id, equipo_codigo, unidad_id, inspector_id, fecha, resultado, vigente_hasta, created_by) VALUES ($1, $2, 'G', $3, $4, CURRENT_DATE, 'aprobado', (CURRENT_DATE + INTERVAL '3 months')::date, $4)`,
            [uuidv7(), tipos['vehiculo_grua'].id, uuidv7(), OPERADOR.id],
          ),
        ).rejects.toThrow(/inspeccion_unidad_check/);
        const ok = await inspeccionar('eslinga_cable');
        await expect(
          sql(
            'INSERT INTO qhse.inspeccion_resultado (inspeccion_id, criterio_id, cumple) VALUES ($1, $2, true)',
            [ok.body.id, tipos['detector_gas'].criterios[0].id],
          ),
        ).rejects.toThrow(/no es del tipo de inspección/);
      });

      it('una inspección es historia: la aplicación no la edita ni la borra', async () => {
        const ok = await inspeccionar('eslinga_cable');
        await expect(
          t.prisma.inspeccion.update({
            where: { id: ok.body.id },
            data: { resultado: 'rechazado' },
          }),
        ).rejects.toThrow(/permission denied|denegado/i);
        await expect(t.prisma.inspeccion.delete({ where: { id: ok.body.id } })).rejects.toThrow(
          /permission denied|denegado/i,
        );
        await expect(
          t.prisma.inspeccionResultado.updateMany({
            where: { inspeccionId: ok.body.id },
            data: { cumple: false },
          }),
        ).rejects.toThrow(/permission denied|denegado/i);
        await expect(
          t.prisma.inspeccionResultado.deleteMany({ where: { inspeccionId: ok.body.id } }),
        ).rejects.toThrow(/permission denied|denegado/i);
      });
    });
  });
});
