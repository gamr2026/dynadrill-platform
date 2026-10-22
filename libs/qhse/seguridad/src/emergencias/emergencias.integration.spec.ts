/**
 * Integración real de QHSE: Emergencias / MEDEVAC (HSE-TRIAGE-001), con las reglas de la base.
 *   RUN_INTEGRATION=1 npx jest emergencias   (dentro de libs/qhse/seguridad)
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
const MAESTROS: MaestrosDePrueba = {
  usuarios: [
    { ...TECNICO, rol: 'tecnico_hse' },
    { ...OPERADOR, rol: 'operador' },
  ],
};

type Catalogos = { tipos: Array<{ id: string; codigo: string }> };
type Evento = {
  datos: { source: string; actor?: { userId: string }; data: Record<string, unknown> };
};

run('QHSE: Emergencias (base de datos real)', () => {
  jest.setTimeout(120000);
  let t: AppDePrueba;
  let cat: Catalogos;
  let ubicacionSuelo = '';
  let ubicacionAgua = '';
  let bandaMenor = '';
  let bandaMayor = '';
  const emergencias: string[] = [];
  const derrames: string[] = [];
  const swas: string[] = [];
  const tickets: string[] = [];

  const operador = () => t.token('operador', OPERADOR.nombre, [P.QHSE_REPORTAR], OPERADOR.id);
  const tecnico = () =>
    t.token('tecnico_hse', TECNICO.nombre, [P.QHSE_REPORTAR, P.EMERGENCIAS_VER], TECNICO.id);
  const gestor = () =>
    t.token(
      'tecnico_hse',
      TECNICO.nombre,
      [P.QHSE_REPORTAR, P.EMERGENCIAS_VER, P.EMERGENCIAS_GESTIONAR],
      TECNICO.id,
    );

  const tipo = (codigo: string): string => {
    const x = cat.tipos.find((c) => c.codigo === codigo);
    if (!x) throw new Error(`Falta el tipo ${codigo} en la semilla`);
    return x.id;
  };
  const sql = (texto: string, params: unknown[] = []) => t.admin.query(texto, params);
  const ticketNuevo = async () => {
    const ticketId = uuidv7();
    tickets.push(ticketId);
    await t.prisma.ticketRef.create({
      data: {
        ticketId,
        pedidoId: uuidv7(),
        pedidoCodigo: `PED-EME${n}`,
        ticketNumero: 950_000 + tickets.length,
        supervisorId: null,
        cliente: 'Cliente Emergencias',
      },
    });
    return ticketId;
  };
  const activar = async (cuerpo: Record<string, unknown> = {}, quien = operador()) => {
    const r = await t
      .http()
      .post('/api/qhse/emergencias')
      .set(quien)
      .send({
        tipoId: tipo('incendio'),
        descripcion: 'Incendio en el generador de la locación',
        ubicacion: 'Locación 3',
        ...cuerpo,
      });
    if (r.status === 201) emergencias.push(r.body.id);
    return r;
  };
  const detalle = async (id: string) =>
    (await t.http().get(`/api/qhse/emergencias/${id}`).set(tecnico())).body;
  const eventos = async (tipoEvento: string, id: string) =>
    (
      await sql(
        "SELECT datos FROM msg_qhse.outbox WHERE tipo = $1 AND datos->'data'->>'emergenciaId' = $2 ORDER BY ocurrido_at, id",
        [tipoEvento, id],
      )
    ).rows as Evento[];
  /** Un derrame y una SWA reales (con la base), para probar la escalada. */
  const derrameNuevo = async (ubicacionId: string, bandaId: string) => {
    const r = await t
      .http()
      .post('/api/qhse/derrames')
      .set(operador())
      .send({ ubicacionId, bandaId, descripcion: 'Derrame para escalar' });
    derrames.push(r.body.id);
    return r.body.id as string;
  };
  const swaNueva = async (ticketId?: string) => {
    const tipoPeligro = (await sql("SELECT id FROM qhse.swa_tipo_peligro WHERE codigo = 'quimico'"))
      .rows[0].id;
    const r = await t
      .http()
      .post('/api/qhse/swa')
      .set(operador())
      .send({
        tipoPeligroId: tipoPeligro,
        descripcion: 'Fuga química',
        ...(ticketId ? { ticketId } : {}),
      });
    swas.push(r.body.id);
    return r.body.id as string;
  };

  beforeAll(async () => {
    t = await levantarAppDePrueba('3183');
    await sembrarMaestros(t.admin, MAESTROS);
    cat = (await t.http().get('/api/qhse/emergencias/catalogos').set(operador())).body;
    const dc = (await t.http().get('/api/qhse/derrames/catalogos').set(operador())).body as {
      ubicaciones: Array<{ id: string; codigo: string }>;
      bandas: Array<{ id: string; codigo: string }>;
    };
    ubicacionSuelo = dc.ubicaciones.find((u) => u.codigo === 'suelo')?.id ?? '';
    ubicacionAgua = dc.ubicaciones.find((u) => u.codigo === 'cuerpo_agua')?.id ?? '';
    bandaMenor = dc.bandas.find((b) => b.codigo === 'menor')?.id ?? '';
    bandaMayor = dc.bandas.find((b) => b.codigo === 'mayor')?.id ?? '';
  });

  afterAll(async () => {
    await sql('DELETE FROM qhse.emergencia WHERE id = ANY($1::uuid[])', [emergencias]);
    await sql('DELETE FROM qhse.derrame WHERE id = ANY($1::uuid[])', [derrames]);
    await sql('DELETE FROM qhse.swa WHERE id = ANY($1::uuid[])', [swas]);
    await sql('DELETE FROM qhse.ticket_ref WHERE ticket_id = ANY($1::uuid[])', [tickets]);
    await sql(
      "DELETE FROM msg_qhse.outbox WHERE datos->'data'->>'emergenciaId' = ANY($1::text[])",
      [emergencias],
    );
    await sql(
      "DELETE FROM msg_qhse.outbox WHERE datos->'data'->>'derrameId' = ANY($1::text[]) OR datos->'data'->>'swaId' = ANY($2::text[])",
      [derrames, swas],
    );
    await quitarMaestros(t.admin, MAESTROS);
    await t.cerrar();
  });

  it('el catálogo de tipos sale sembrado', () => {
    expect(cat.tipos.map((c) => c.codigo)).toEqual([
      'derrame_mayor',
      'incendio',
      'explosion',
      'accidente_heridos',
      'fuga_gas',
      'otro',
    ]);
  });

  it('cualquier trabajador activa la emergencia; el equipo HSE la ve con el cronómetro, el ticket y el evento', async () => {
    const ticketId = await ticketNuevo();
    const r = await activar({ ticketId });
    expect(r.status).toBe(201);
    expect(r.body).toEqual({
      id: expect.any(String),
      codigo: expect.stringMatching(/^EME-\d{6}$/),
      estado: 'activa',
    });
    // quien activa no ve la bandeja ni el detalle
    expect((await t.http().get('/api/qhse/emergencias').set(operador())).status).toBe(403);
    expect((await t.http().get(`/api/qhse/emergencias/${r.body.id}`).set(operador())).status).toBe(
      403,
    );

    const d = await detalle(r.body.id);
    expect(d).toMatchObject({
      estado: 'activa',
      tipo: { codigo: 'incendio' },
      ubicacion: 'Locación 3',
      origen: null,
      ticketId,
      pedidoCodigo: `PED-EME${n}`,
      cliente: 'Cliente Emergencias',
      activadoPor: OPERADOR.nombre,
    });
    expect(d.cronometro).toHaveLength(1);
    expect(d.cronometro[0]).toMatchObject({
      texto: 'Emergencia activada (Incendio)',
      automatica: true,
      minutos: 0,
      actor: OPERADOR.nombre,
    });
    expect(d.historial).toHaveLength(1);

    const ev = await eventos('qhse.emergencia.activada', r.body.id);
    expect(ev).toHaveLength(1);
    expect(ev[0].datos.source).toBe('qhse');
    expect(ev[0].datos.actor?.userId).toBe(OPERADOR.id);
    expect(ev[0].datos.data).toMatchObject({
      emergenciaId: r.body.id,
      tipoEmergencia: 'incendio',
      ticketId,
      swaId: null,
      derrameId: null,
      activadoPor: OPERADOR.nombre,
    });
  });

  it('el cronómetro admite líneas del equipo HSE, con los minutos desde la activación, hasta que se cierra', async () => {
    const id = (await activar()).body.id as string;
    // la emergencia se activó hace 12 minutos (se atrasa directo en la base)
    await sql(
      "UPDATE qhse.emergencia SET activado_at = now() - interval '12 minutes' WHERE id = $1",
      [id],
    );
    expect(
      (
        await t
          .http()
          .post(`/api/qhse/emergencias/${id}/cronometro`)
          .set(tecnico())
          .send({ texto: 'x' })
      ).status,
    ).toBe(403);
    const r = await t
      .http()
      .post(`/api/qhse/emergencias/${id}/cronometro`)
      .set(gestor())
      .send({ texto: 'Llegó la brigada contra incendio' });
    expect(r.status).toBe(201);
    const ultima = r.body.cronometro.at(-1);
    expect(ultima).toMatchObject({
      texto: 'Llegó la brigada contra incendio',
      automatica: false,
      actor: TECNICO.nombre,
    });
    expect(ultima.minutos).toBeGreaterThanOrEqual(11);
    expect(
      (
        await t
          .http()
          .post(`/api/qhse/emergencias/${id}/cronometro`)
          .set(gestor())
          .send({ texto: '   ' })
      ).status,
    ).toBe(400);
    expect(
      (
        await t
          .http()
          .post(`/api/qhse/emergencias/${uuidv7()}/cronometro`)
          .set(gestor())
          .send({ texto: 'algo' })
      ).status,
    ).toBe(404);
  });

  it('el servicio rechaza lo incompleto con mensajes claros', async () => {
    const sinDescripcion = await activar({ descripcion: '   ' });
    expect(sinDescripcion.status).toBe(400);
    expect(sinDescripcion.body.detail).toMatch(/Describa qué ocurrió/);
    expect((await activar({ tipoId: uuidv7() })).status).toBe(400);
    expect((await activar({ tipoId: 'no-es-uuid' })).status).toBe(400);
    const sinTicket = await activar({ ticketId: uuidv7() });
    expect(sinTicket.status).toBe(400);
    expect(sinTicket.body.detail).toMatch(/no conoce ese ticket/);
    const dosOrigenes = await activar({ origenSwaId: uuidv7(), origenDerrameId: uuidv7() });
    expect(dosOrigenes.status).toBe(400);
    expect(dosOrigenes.body.detail).toMatch(/de una SWA o de un derrame, no de los dos/);
    expect((await activar({ origenSwaId: uuidv7() })).status).toBe(400);
    expect((await activar({ origenDerrameId: uuidv7() })).status).toBe(400);
    // sin permiso de reportar no se activa
    const sinPermiso = t.token('operador', OPERADOR.nombre, [], OPERADOR.id);
    expect((await activar({}, sinPermiso)).status).toBe(403);
  });

  it('escala desde un derrame mayor o en agua (hereda el ticket) y no desde uno menor; un derrame escala una sola vez', async () => {
    const ticketId = await ticketNuevo();
    const menor = await derrameNuevo(ubicacionSuelo, bandaMenor);
    const noEscala = await activar({ origenDerrameId: menor });
    expect(noEscala.status).toBe(409);
    expect(noEscala.body.detail).toMatch(/no escala a emergencia/);

    const agua = await t.http().post('/api/qhse/derrames').set(operador()).send({
      ubicacionId: ubicacionAgua,
      bandaId: bandaMenor,
      descripcion: 'Derrame en el río',
      ticketId,
    });
    derrames.push(agua.body.id);
    const r = await activar({ tipoId: tipo('derrame_mayor'), origenDerrameId: agua.body.id });
    expect(r.status).toBe(201);
    const d = await detalle(r.body.id);
    expect(d.origen).toMatchObject({ tipo: 'derrame', id: agua.body.id, estado: 'activo' });
    expect(d.origen.codigo).toMatch(/^DER-\d{6}$/);
    expect(d.ticketId).toBe(ticketId); // hereda el servicio del derrame
    expect(d.cronometro[0].texto).toMatch(/escalada desde DER-\d{6}/);
    expect((await eventos('qhse.emergencia.activada', r.body.id))[0].datos.data).toMatchObject({
      derrameId: agua.body.id,
      swaId: null,
    });
    const repetida = await activar({ origenDerrameId: agua.body.id });
    expect(repetida.status).toBe(409);
    expect(repetida.body.detail).toMatch(/ya escaló a la emergencia EME-\d{6}/);

    // un derrame mayor (por banda) también escala
    const mayor = await derrameNuevo(ubicacionSuelo, bandaMayor);
    expect((await activar({ origenDerrameId: mayor })).status).toBe(201);
  });

  it('escala desde una SWA que no esté cerrada (hereda el ticket) y una SWA escala una sola vez', async () => {
    const ticketId = await ticketNuevo();
    const swa = await swaNueva(ticketId);
    const r = await activar({ origenSwaId: swa });
    expect(r.status).toBe(201);
    const d = await detalle(r.body.id);
    expect(d.origen).toMatchObject({ tipo: 'swa', id: swa, estado: 'activo' });
    expect(d.origen.codigo).toMatch(/^SWA-\d{6}$/);
    expect(d.ticketId).toBe(ticketId);
    expect(d.cronometro[0].texto).toMatch(/escalada desde SWA-\d{6}/);
    expect((await activar({ origenSwaId: swa })).status).toBe(409);

    // una SWA cerrada ya no escala (se cierra directo en la base para no recorrer todo su ciclo)
    const cerrada = await swaNueva();
    await sql('ALTER TABLE qhse.swa DISABLE TRIGGER swa_validar_trg');
    try {
      await sql(
        "UPDATE qhse.swa SET estado = 'cerrado', riesgo_real = false, evaluado_por = $2, evaluado_at = now(), reanudado_por = $2, reanudado_at = now() WHERE id = $1",
        [cerrada, TECNICO.id],
      );
    } finally {
      await sql('ALTER TABLE qhse.swa ENABLE TRIGGER swa_validar_trg');
    }
    const cerradaR = await activar({ origenSwaId: cerrada });
    expect(cerradaR.status).toBe(409);
    expect(cerradaR.body.detail).toMatch(/SWA cerrada ya no escala/);
  });

  it('la bandeja filtra por estado, ticket y texto', async () => {
    const ticketId = await ticketNuevo();
    const a = await activar({ ticketId, descripcion: 'Emergencia distintiva OMEGA' });
    const lista = (await t.http().get('/api/qhse/emergencias').set(tecnico())).body as Array<{
      id: string;
      ticketNumero: number | null;
      origen: string | null;
    }>;
    const fila = lista.find((x) => x.id === a.body.id);
    expect(fila?.ticketNumero).toEqual(expect.any(Number));
    expect(fila?.origen).toBeNull();
    const porTicket = (
      await t.http().get(`/api/qhse/emergencias?ticketId=${ticketId}`).set(tecnico())
    ).body as Array<{ id: string }>;
    expect(porTicket.map((x) => x.id)).toEqual([a.body.id]);
    const porTexto = (await t.http().get('/api/qhse/emergencias?q=distintiva omega').set(tecnico()))
      .body as Array<{ id: string }>;
    expect(porTexto.map((x) => x.id)).toEqual([a.body.id]);
    const cerradas = (await t.http().get('/api/qhse/emergencias?estado=cerrada').set(tecnico()))
      .body as Array<{ id: string }>;
    expect(cerradas.some((x) => x.id === a.body.id)).toBe(false);
    expect((await t.http().get('/api/qhse/emergencias?estado=otra').set(tecnico())).status).toBe(
      400,
    );
  });

  describe('nivel, conteo de personal y cascada de notificación', () => {
    const post = (id: string, ruta: string, cuerpo: Record<string, unknown>, quien = gestor()) =>
      t.http().post(`/api/qhse/emergencias/${id}/${ruta}`).set(quien).send(cuerpo);

    it('Base HSE declara el nivel (1 a 3), lo puede cambiar y cada declaración queda con su línea, su historial y su evento', async () => {
      const id = (await activar()).body.id as string;
      expect((await detalle(id)).nivel).toBeNull();
      expect((await post(id, 'nivel', { nivel: 2 }, tecnico())).status).toBe(403);
      for (const malo of [0, 4, '2', null])
        expect((await post(id, 'nivel', { nivel: malo })).status).toBe(400);

      const r = await post(id, 'nivel', { nivel: 2 });
      expect(r.status).toBe(201);
      expect(r.body.nivel).toMatchObject({ valor: 2, declaradoPor: TECNICO.nombre });
      expect(r.body.cronometro.at(-1)).toMatchObject({
        automatica: true,
        texto: expect.stringMatching(/^Nivel declarado: Nivel 2/),
      });
      expect((await post(id, 'nivel', { nivel: 2 })).status).toBe(409); // ya tiene ese nivel
      const sube = await post(id, 'nivel', { nivel: 3 });
      expect(sube.body.nivel.valor).toBe(3);
      expect(sube.body.niveles.map((x: { nivel: number }) => x.nivel)).toEqual([2, 3]);
      expect(sube.body.cronometro.at(-1).texto).toMatch(/^Nivel cambiado de 2 a 3/);
      const ev = await eventos('qhse.emergencia.nivel_declarado', id);
      expect(ev.map((e) => e.datos.data['nivel'])).toEqual([2, 3]);
      expect(ev[1].datos.data['nivelAnterior']).toBe(2);
    });

    it('el conteo de personal calcula los faltantes, se puede repetir y no admite más evacuados que personas', async () => {
      const id = (await activar()).body.id as string;
      expect((await detalle(id)).conteo).toBeNull();
      expect(
        (await post(id, 'conteo', { totalEnLocacion: 20, evacuados: 15 }, tecnico())).status,
      ).toBe(403);
      for (const malo of [
        { totalEnLocacion: 5, evacuados: 6 },
        { totalEnLocacion: -1, evacuados: 0 },
        { totalEnLocacion: 5, evacuados: -2 },
        { totalEnLocacion: 5.5, evacuados: 2 },
        { totalEnLocacion: 'cinco', evacuados: 2 },
      ])
        expect((await post(id, 'conteo', malo)).status).toBe(400);

      const r = await post(id, 'conteo', { totalEnLocacion: 20, evacuados: 15 });
      expect(r.status).toBe(201);
      expect(r.body.conteo).toMatchObject({
        totalEnLocacion: 20,
        evacuados: 15,
        faltantes: 5,
        por: TECNICO.nombre,
      });
      expect(r.body.cronometro.at(-1).texto).toBe(
        'Conteo de personal: 20 en la locación, 15 evacuados, 5 faltantes',
      );
      const segundo = await post(id, 'conteo', { totalEnLocacion: 20, evacuados: 20 });
      expect(segundo.body.conteo.faltantes).toBe(0);
      expect(segundo.body.conteos.map((c: { faltantes: number }) => c.faltantes)).toEqual([5, 0]);
      const ev = await eventos('qhse.emergencia.conteo_completado', id);
      expect(ev).toHaveLength(2);
      expect(ev[0].datos.data).toMatchObject({ totalEnLocacion: 20, evacuados: 15, faltantes: 5 });
    });

    it('la cascada trae los 4 pasos con su plazo; cada notificación informa si fue en plazo y marca los vencidos', async () => {
      const id = (await activar()).body.id as string;
      // la emergencia se activó hace 7 minutos (se atrasa directo en la base)
      await sql(
        "UPDATE qhse.emergencia SET activado_at = now() - interval '7 minutes' WHERE id = $1",
        [id],
      );
      const d0 = await detalle(id);
      expect(
        d0.cascada.map((c: { desde: string; hacia: string; plazoMinutos: number }) => [
          c.desde,
          c.hacia,
          c.plazoMinutos,
        ]),
      ).toEqual([
        ['Supervisor', 'Company Man', 2],
        ['Company Man', 'Base HSE', 5],
        ['Base HSE', 'Gerencia', 10],
        ['Company Man', 'Base Operadora (Cliente)', 5],
      ]);
      expect(d0.notificacionCompleta).toBe(false);
      // a los 7 minutos, los pasos de 2 y 5 minutos ya están vencidos; el de 10, no
      expect(d0.cascada.map((c: { vencido: boolean }) => c.vencido)).toEqual([
        true,
        true,
        false,
        true,
      ]);

      const [p1, , p3] = d0.cascada as Array<{ pasoId: string }>;
      expect((await post(id, 'notificaciones', { pasoId: p1.pasoId }, tecnico())).status).toBe(403);
      expect((await post(id, 'notificaciones', { pasoId: uuidv7() })).status).toBe(400);
      expect((await post(id, 'notificaciones', { pasoId: 'x' })).status).toBe(400);

      const tarde = await post(id, 'notificaciones', { pasoId: p1.pasoId });
      expect(tarde.status).toBe(201);
      expect(tarde.body.cascada[0]).toMatchObject({
        notificadoPor: TECNICO.nombre,
        enPlazo: false,
        vencido: false,
      });
      expect(tarde.body.cascada[0].minutos).toBeGreaterThanOrEqual(7);
      expect(tarde.body.cronometro.at(-1).texto).toMatch(
        /^Notificación 1: Supervisor → Company Man \(.* min; plazo 2 min, fuera de plazo\)$/,
      );
      const ok = await post(id, 'notificaciones', { pasoId: p3.pasoId });
      expect(ok.body.cascada[2]).toMatchObject({ enPlazo: true, hacia: 'Gerencia' });
      expect((await post(id, 'notificaciones', { pasoId: p3.pasoId })).status).toBe(409); // ya notificado
      const ev = await eventos('qhse.emergencia.notificacion_realizada', id);
      expect(ev.map((e) => [e.datos.data['paso'], e.datos.data['enPlazo']])).toEqual([
        [1, false],
        [3, true],
      ]);
      // completar el resto
      for (const c of d0.cascada as Array<{ pasoId: string }>)
        if (![p1.pasoId, p3.pasoId].includes(c.pasoId))
          expect((await post(id, 'notificaciones', { pasoId: c.pasoId })).status).toBe(201);
      expect((await detalle(id)).notificacionCompleta).toBe(true);
    });

    it('una emergencia cerrada ya no recibe nivel, conteo ni notificaciones', async () => {
      const id = (await activar()).body.id as string;
      const paso = ((await detalle(id)).cascada as Array<{ pasoId: string }>)[0].pasoId;
      await sql("UPDATE qhse.emergencia SET estado = 'controlada' WHERE id = $1", [id]);
      await sql("UPDATE qhse.emergencia SET estado = 'cerrada' WHERE id = $1", [id]);
      for (const [ruta, cuerpo] of [
        ['nivel', { nivel: 1 }],
        ['conteo', { totalEnLocacion: 1, evacuados: 1 }],
        ['notificaciones', { pasoId: paso }],
        ['cronometro', { texto: 'algo' }],
      ] as Array<[string, Record<string, unknown>]>)
        expect((await post(id, ruta, cuerpo)).status).toBe(409);
      expect((await post(uuidv7(), 'nivel', { nivel: 1 })).status).toBe(404);
    });
  });

  describe('reglas de la base', () => {
    const insertar = (
      extra: { estado?: string; swa?: string | null; derrame?: string | null } = {},
    ) => {
      const id = uuidv7();
      return {
        id,
        texto: `INSERT INTO qhse.emergencia (id, estado, tipo_id, descripcion, swa_id, derrame_id, activado_por, created_by)
                VALUES ($1, $2::qhse.estado_emergencia, $3, 'Prueba', $4, $5, $6, $6)`,
        params: [
          id,
          extra.estado ?? 'activa',
          tipo('incendio'),
          extra.swa ?? null,
          extra.derrame ?? null,
          OPERADOR.id,
        ],
      };
    };

    it('nace activa, no se salta de estado y lo reportado no se reescribe ni se borra', async () => {
      const nace = insertar({ estado: 'cerrada' });
      await expect(sql(nace.texto, nace.params)).rejects.toThrow(/nace activa/);
      const id = (await activar()).body.id as string;
      await expect(
        sql("UPDATE qhse.emergencia SET estado = 'cerrada' WHERE id = $1", [id]),
      ).rejects.toThrow(/Cambio de estado no permitido/);
      await sql("UPDATE qhse.emergencia SET estado = 'controlada' WHERE id = $1", [id]);
      await expect(
        sql("UPDATE qhse.emergencia SET estado = 'activa' WHERE id = $1", [id]),
      ).rejects.toThrow(/Cambio de estado no permitido/);
      await expect(
        t.prisma.emergencia.update({ where: { id }, data: { descripcion: 'otra cosa' } }),
      ).rejects.toThrow(/permission denied|denegado/i);
      await expect(
        t.prisma.emergencia.update({ where: { id }, data: { swaId: uuidv7() } }),
      ).rejects.toThrow(/permission denied|denegado/i);
      await expect(t.prisma.emergencia.delete({ where: { id } })).rejects.toThrow(
        /permission denied|denegado/i,
      );
    });

    it('el cronómetro y el historial no se editan ni se borran', async () => {
      const id = (await activar()).body.id as string;
      await expect(
        t.prisma.emergenciaLinea.deleteMany({ where: { emergenciaId: id } }),
      ).rejects.toThrow(/permission denied|denegado/i);
      await expect(
        t.prisma.emergenciaLinea.updateMany({
          where: { emergenciaId: id },
          data: { texto: 'otra' },
        }),
      ).rejects.toThrow(/permission denied|denegado/i);
      await expect(
        t.prisma.emergenciaHistorial.deleteMany({ where: { emergenciaId: id } }),
      ).rejects.toThrow(/permission denied|denegado/i);
      await expect(
        sql(
          "INSERT INTO qhse.emergencia_linea (id, emergencia_id, texto, actor_id) VALUES ($1, $2, '   ', $3)",
          [uuidv7(), id, OPERADOR.id],
        ),
      ).rejects.toThrow(/emergencia_linea_texto_check/);
    });

    it('el origen es una SWA o un derrame (no los dos), se valida en la base y una sola emergencia por origen', async () => {
      const swa = await swaNueva();
      const dos = await derrameNuevo(ubicacionAgua, bandaMenor);
      const ambos = insertar({ swa, derrame: dos });
      await expect(sql(ambos.texto, ambos.params)).rejects.toThrow(/emergencia_origen_check/);

      const menor = await derrameNuevo(ubicacionSuelo, bandaMenor);
      const noEscala = insertar({ derrame: menor });
      await expect(sql(noEscala.texto, noEscala.params)).rejects.toThrow(/no escala a emergencia/);
      expect(
        (await sql('SELECT qhse.derrame_escala_a_emergencia($1) AS r', [menor])).rows[0].r,
      ).toBe(false);
      expect((await sql('SELECT qhse.derrame_escala_a_emergencia($1) AS r', [dos])).rows[0].r).toBe(
        true,
      );

      const ok = insertar({ derrame: dos });
      await sql(ok.texto, ok.params);
      emergencias.push(ok.id);
      const repetido = insertar({ derrame: dos });
      await expect(sql(repetido.texto, repetido.params)).rejects.toThrow(/emergencia_derrame_key/);
      const swaOk = insertar({ swa });
      await sql(swaOk.texto, swaOk.params);
      emergencias.push(swaOk.id);
      const swaRepetida = insertar({ swa });
      await expect(sql(swaRepetida.texto, swaRepetida.params)).rejects.toThrow(
        /emergencia_swa_key/,
      );
      // el origen no se cambia (ni siquiera el dueño de la base)
      await expect(
        sql('UPDATE qhse.emergencia SET derrame_id = NULL WHERE id = $1', [ok.id]),
      ).rejects.toThrow(/origen de la emergencia no se cambia/);
    });

    it('el nivel y el conteo se registran completos y válidos, y su historial es inmutable', async () => {
      const id = (await activar()).body.id as string;
      const actualizar = (set: string, params: unknown[] = []) =>
        sql(`UPDATE qhse.emergencia SET ${set} WHERE id = $1`, [id, ...params]);
      // nivel fuera de 1 a 3, o sin quién y cuándo
      await expect(
        actualizar('nivel = 4, nivel_declarado_por = $2, nivel_declarado_at = now()', [
          OPERADOR.id,
        ]),
      ).rejects.toThrow(/emergencia_nivel_check/);
      await expect(actualizar('nivel = 2')).rejects.toThrow(/emergencia_nivel_check/);
      // conteo incompleto, con negativos, o con más evacuados que personas
      await expect(actualizar('total_en_locacion = 5, evacuados = 2')).rejects.toThrow(
        /emergencia_conteo_check/,
      );
      await expect(
        actualizar('total_en_locacion = 5, evacuados = 6, conteo_por = $2, conteo_at = now()', [
          OPERADOR.id,
        ]),
      ).rejects.toThrow(/emergencia_conteo_check/);
      await expect(
        actualizar('total_en_locacion = -1, evacuados = 0, conteo_por = $2, conteo_at = now()', [
          OPERADOR.id,
        ]),
      ).rejects.toThrow(/emergencia_conteo_check/);
      await expect(
        sql(
          'INSERT INTO qhse.emergencia_nivel_historial (id, emergencia_id, nivel, actor_id) VALUES ($1, $2, 7, $3)',
          [uuidv7(), id, OPERADOR.id],
        ),
      ).rejects.toThrow(/emergencia_nivel_historial_nivel_check/);
      await expect(
        sql(
          'INSERT INTO qhse.emergencia_conteo_historial (id, emergencia_id, total_en_locacion, evacuados, actor_id) VALUES ($1, $2, 1, 5, $3)',
          [uuidv7(), id, OPERADOR.id],
        ),
      ).rejects.toThrow(/emergencia_conteo_historial_check/);
      await sql(
        'INSERT INTO qhse.emergencia_nivel_historial (id, emergencia_id, nivel, actor_id) VALUES ($1, $2, 1, $3)',
        [uuidv7(), id, OPERADOR.id],
      );
      await expect(
        t.prisma.emergenciaNivelHistorial.deleteMany({ where: { emergenciaId: id } }),
      ).rejects.toThrow(/permission denied|denegado/i);
      await expect(
        t.prisma.emergenciaConteoHistorial.updateMany({
          where: { emergenciaId: id },
          data: { evacuados: 0 },
        }),
      ).rejects.toThrow(/permission denied|denegado/i);
    });

    it('la cascada: pasos válidos, una notificación por paso, inmutable, y nada se registra en una emergencia cerrada', async () => {
      const id = (await activar()).body.id as string;
      const paso = (
        await sql('SELECT id FROM qhse.emergencia_paso_notificacion ORDER BY orden LIMIT 1')
      ).rows[0].id;
      const notificar = () =>
        sql(
          'INSERT INTO qhse.emergencia_notificacion (emergencia_id, paso_id, notificado_por) VALUES ($1, $2, $3)',
          [id, paso, OPERADOR.id],
        );
      await notificar();
      await expect(notificar()).rejects.toThrow(/emergencia_notificacion_pkey/);
      await expect(
        sql(
          'INSERT INTO qhse.emergencia_notificacion (emergencia_id, paso_id, notificado_por) VALUES ($1, $2, $3)',
          [id, uuidv7(), OPERADOR.id],
        ),
      ).rejects.toThrow(/emergencia_notificacion_paso_fkey/);
      await expect(
        t.prisma.emergenciaNotificacion.deleteMany({ where: { emergenciaId: id } }),
      ).rejects.toThrow(/permission denied|denegado/i);
      await expect(
        t.prisma.emergenciaNotificacion.updateMany({
          where: { emergenciaId: id },
          data: { notificadoPor: TECNICO.id },
        }),
      ).rejects.toThrow(/permission denied|denegado/i);
      // los pasos son un catálogo: plazo positivo, texto no vacío, y no se borran
      await expect(
        sql(
          "INSERT INTO qhse.emergencia_paso_notificacion (id, orden, desde, hacia, plazo_minutos) VALUES ($1, 9000, 'A', 'B', 0)",
          [uuidv7()],
        ),
      ).rejects.toThrow(/emergencia_paso_notificacion_plazo_check/);
      await expect(
        sql(
          "INSERT INTO qhse.emergencia_paso_notificacion (id, orden, desde, hacia, plazo_minutos) VALUES ($1, 9001, '  ', 'B', 5)",
          [uuidv7()],
        ),
      ).rejects.toThrow(/emergencia_paso_notificacion_texto_check/);
      await expect(
        t.prisma.emergenciaPasoNotificacion.deleteMany({ where: { orden: 1 } }),
      ).rejects.toThrow(/permission denied|denegado/i);
      // una emergencia cerrada no se modifica ni recibe registros nuevos
      await sql("UPDATE qhse.emergencia SET estado = 'controlada' WHERE id = $1", [id]);
      await sql("UPDATE qhse.emergencia SET estado = 'cerrada' WHERE id = $1", [id]);
      await expect(
        sql(
          'UPDATE qhse.emergencia SET nivel = 1, nivel_declarado_por = $2, nivel_declarado_at = now() WHERE id = $1',
          [id, OPERADOR.id],
        ),
      ).rejects.toThrow(/cerrada ya no se modifica/);
      const otroPaso = (
        await sql(
          'SELECT id FROM qhse.emergencia_paso_notificacion ORDER BY orden OFFSET 1 LIMIT 1',
        )
      ).rows[0].id;
      await expect(
        sql(
          'INSERT INTO qhse.emergencia_notificacion (emergencia_id, paso_id, notificado_por) VALUES ($1, $2, $3)',
          [id, otroPaso, OPERADOR.id],
        ),
      ).rejects.toThrow(/está cerrada y ya no recibe registros/);
    });

    it('la descripción no puede estar vacía y el tipo, el ticket y los orígenes deben existir (FK)', async () => {
      const vacia = insertar();
      vacia.params[2] = tipo('otro');
      await expect(sql(vacia.texto.replace("'Prueba'", "'   '"), vacia.params)).rejects.toThrow(
        /emergencia_descripcion_check/,
      );
      const tipoMalo = insertar();
      tipoMalo.params[2] = uuidv7();
      await expect(sql(tipoMalo.texto, tipoMalo.params)).rejects.toThrow(/emergencia_tipo_fkey/);
      const swaMala = insertar({ swa: uuidv7() });
      await expect(sql(swaMala.texto, swaMala.params)).rejects.toThrow(/emergencia_swa_fkey/);
      const derrameMalo = insertar({ derrame: uuidv7() });
      await expect(sql(derrameMalo.texto, derrameMalo.params)).rejects.toThrow(
        /emergencia_derrame_fkey|no escala/,
      );
      await expect(
        sql(
          "INSERT INTO qhse.emergencia (id, tipo_id, descripcion, ticket_id, activado_por, created_by) VALUES ($1, $2, 'x', $3, $4, $4)",
          [uuidv7(), tipo('otro'), uuidv7(), OPERADOR.id],
        ),
      ).rejects.toThrow(/emergencia_ticket_fkey/);
    });
  });
});
