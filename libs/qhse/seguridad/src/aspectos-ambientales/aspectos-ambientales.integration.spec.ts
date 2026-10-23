/**
 * Integración real de QHSE: matriz de aspectos e impactos ambientales (control, seguimiento y baja), con las reglas de la base.
 *   RUN_INTEGRATION=1 npx jest aspectos-ambientales   (dentro de libs/qhse/seguridad; requiere `npm run db:seed:qhse`)
 */
import { Permission } from '@dyn/authz';
import { uuidv7 } from '@dyn/utils';
import { levantarAppDePrueba, type AppDePrueba } from '../testing/app-de-prueba';
import { quitarMaestros, sembrarMaestros, type MaestrosDePrueba } from '../testing/maestros';

const run = process.env['RUN_INTEGRATION'] ? describe : describe.skip;
const P = Permission;
const n = Date.now();

const TECNICO = { id: uuidv7(), nombre: 'Tania Técnica HSE' };
const RESPONSABLE = { id: uuidv7(), nombre: 'Rolando Responsable' };
const INACTIVO = { id: uuidv7(), nombre: 'Ines Inactiva', activo: false };
const MAESTROS: MaestrosDePrueba = {
  usuarios: [
    { ...TECNICO, rol: 'tecnico_hse' },
    { ...RESPONSABLE, rol: 'operador' },
    { ...INACTIVO, rol: 'operador' },
  ],
};

type Salida = { datos: { data: Record<string, unknown> } };
const fechaEn = (dias: number) =>
  new Date(Date.now() + dias * 86_400_000).toLocaleDateString('en-CA', {
    timeZone: 'America/Guayaquil',
  });

run('QHSE: aspectos ambientales (base de datos real)', () => {
  jest.setTimeout(240000);
  let t: AppDePrueba;
  let cat: {
    etapas: Array<{ id: string; codigo: string }>;
    factores: Array<{ id: string; codigo: string }>;
    frecuencias: Array<{ id: string; codigo: string }>;
  };
  const proceso = uuidv7();
  const sql = (texto: string, params: unknown[] = []) => t.admin.query(texto, params);
  const gestor = () =>
    t.token(
      'tecnico_hse',
      TECNICO.nombre,
      [P.ASPECTOS_AMBIENTALES_VER, P.ASPECTOS_AMBIENTALES_GESTIONAR],
      TECNICO.id,
    );
  const soloVer = () =>
    t.token('tecnico_hse', TECNICO.nombre, [P.ASPECTOS_AMBIENTALES_VER], TECNICO.id);
  const sinPermiso = () => t.token('operador', 'Oscar Operador', [P.QHSE_REPORTAR], uuidv7());
  const ruta = (id = '', resto = '') =>
    `/api/qhse/aspectos-ambientales${id ? `/${id}` : ''}${resto}`;
  const eventos = async (tipo: string, id: string) =>
    (
      await sql(
        "SELECT datos FROM msg_qhse.outbox WHERE tipo = $1 AND datos->'data'->>'aspectoId' = $2 ORDER BY ocurrido_at, id",
        [tipo, id],
      )
    ).rows as Salida[];

  const crear = (cuerpo: Record<string, unknown> = {}, quien = gestor()) =>
    t
      .http()
      .post(ruta())
      .set(quien)
      .send({
        etapaId: cat.etapas[0].id,
        procesoId: proceso,
        actividad: 'Perforación de pozos',
        aspecto: 'Generación de lodos de perforación',
        impacto: 'Contaminación del suelo',
        probabilidad: 3,
        consecuencia: 4,
        clasificacion: 'moderado',
        ...cuerpo,
      });
  const creado = async (cuerpo: Record<string, unknown> = {}) => {
    const r = await crear(cuerpo);
    expect(r.status).toBe(201);
    return r.body as { id: string; codigo: string };
  };
  const detalle = async (id: string) => (await t.http().get(ruta(id)).set(soloVer())).body;

  beforeAll(async () => {
    t = await levantarAppDePrueba('3181');
    await sembrarMaestros(t.admin, MAESTROS);
    await sql(
      "INSERT INTO qhse.iperc_proceso (id, codigo, nombre, orden, created_by) VALUES ($1, $2, 'Proceso de prueba de aspectos', $3, $4)",
      [proceso, `TA-${n}`, 700000 + (n % 90000), TECNICO.id],
    );
    cat = (await t.http().get(ruta('catalogos')).set(soloVer())).body;
  });

  afterAll(async () => {
    const mios = '(SELECT id FROM qhse.aspecto_ambiental WHERE created_by = ANY($1::uuid[]))';
    const ids = [TECNICO.id, RESPONSABLE.id];
    await sql(`DELETE FROM qhse.aspecto_ambiental_seguimiento WHERE aspecto_id IN ${mios}`, [ids]);
    await sql('DELETE FROM qhse.aspecto_ambiental WHERE created_by = ANY($1::uuid[])', [ids]);
    await sql('DELETE FROM qhse.aspecto_etapa_ciclo_vida WHERE created_by = $1', [TECNICO.id]);
    await sql('DELETE FROM qhse.aspecto_factor_ambiental WHERE created_by = $1', [TECNICO.id]);
    await sql('DELETE FROM qhse.iperc_proceso WHERE id = $1', [proceso]);
    await sql(
      "DELETE FROM msg_qhse.outbox WHERE tipo LIKE 'qhse.aspecto_ambiental.%' AND datos->'actor'->>'userId' = ANY($1::text[])",
      [ids],
    );
    await quitarMaestros(t.admin, MAESTROS);
    await t.cerrar();
  });

  describe('catálogos', () => {
    it('trae etapas, factores, frecuencias, procesos del IPERC y los conjuntos fijos', async () => {
      const r = (await t.http().get(ruta('catalogos')).set(soloVer())).body;
      expect(r.etapas.length).toBeGreaterThanOrEqual(7);
      expect(r.factores.map((f: { codigo: string }) => f.codigo)).toEqual(
        expect.arrayContaining(['agua', 'aire', 'suelo']),
      );
      expect(r.frecuencias).toHaveLength(4);
      expect(r.procesos.some((p: { id: string }) => p.id === proceso)).toBe(true);
      expect(r.clasificaciones).toEqual(['bajo', 'moderado', 'alto']);
      expect(r.condicionesOperacion).toEqual(['normal', 'anormal', 'emergencia']);
      expect(r.estadosControl).toEqual(['pendiente', 'en_ejecucion', 'implementado']);
    });

    it('QHSE amplía el catálogo: código estable a partir del nombre, sin duplicados', async () => {
      const nombre = `Prueba Ruido ${n}`;
      const r = await t
        .http()
        .post(ruta('', '/catalogos/factores-ambientales'))
        .set(gestor())
        .send({ nombre });
      expect(r.status).toBe(201);
      expect(r.body.codigo).toBe(`prueba_ruido_${n}`);
      expect(
        (
          await t
            .http()
            .post(ruta('', '/catalogos/factores-ambientales'))
            .set(gestor())
            .send({ nombre })
        ).status,
      ).toBe(409);
      const etapa = await t
        .http()
        .post(ruta('', '/catalogos/etapas-ciclo-vida'))
        .set(gestor())
        .send({ nombre: `Prueba Mantenimiento ${n}` });
      expect(etapa.status).toBe(201);
      const otra = (await t.http().get(ruta('catalogos')).set(soloVer())).body;
      expect(otra.factores.some((f: { id: string }) => f.id === r.body.id)).toBe(true);
      expect(otra.etapas.some((e: { id: string }) => e.id === etapa.body.id)).toBe(true);
      expect(
        (
          await t
            .http()
            .post(ruta('', '/catalogos/etapas-ciclo-vida'))
            .set(gestor())
            .send({ nombre: '  ' })
        ).status,
      ).toBe(400);
      expect(
        (
          await t
            .http()
            .post(ruta('', '/catalogos/etapas-ciclo-vida'))
            .set(gestor())
            .send({ nombre: '¿¡?!' })
        ).body.message,
      ).toMatch(/letras o números/);
      expect(
        (
          await t
            .http()
            .post(ruta('', '/catalogos/etapas-ciclo-vida'))
            .set(soloVer())
            .send({ nombre: 'x' })
        ).status,
      ).toBe(403);
    });
  });

  describe('registrar', () => {
    it('registra el aspecto completo: nivel de riesgo calculado, control y seguimiento, y publica el evento', async () => {
      const r = await crear({
        factorId: cat.factores[0].id,
        produccionDelAspecto: 'Operación del taladro',
        condicionOperacion: 'normal',
        tipoResponsabilidad: 'directa',
        tipoImpacto: 'negativo',
        fechaValoracion: fechaEn(-2),
        ncar: 'NC-2026-014',
        planAccionExistente: 'Piscinas de lodos impermeabilizadas',
        planTratamiento: 'Tratamiento y disposición con gestor autorizado',
        responsableId: RESPONSABLE.id,
        presupuesto: 2500.5,
        plazo: fechaEn(60),
        estadoControl: 'en_ejecucion',
        seguimientoIndicador: 'm3 de lodos dispuestos',
        seguimientoResponsableId: RESPONSABLE.id,
        seguimientoFrecuenciaId: cat.frecuencias[0].id,
      });
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({
        estado: 'vigente',
        probabilidad: 3,
        consecuencia: 4,
        nivelRiesgo: 12,
        clasificacion: 'moderado',
        proceso: { id: proceso, nombre: 'Proceso de prueba de aspectos' },
        tipoImpacto: 'negativo',
        control: {
          ncar: 'NC-2026-014',
          presupuesto: 2500.5,
          plazo: fechaEn(60),
          estadoControl: 'en_ejecucion',
          responsable: { id: RESPONSABLE.id, nombre: RESPONSABLE.nombre },
        },
        seguimiento: { indicador: 'm3 de lodos dispuestos', registros: [], ultimaEficacia: null },
        controlVencido: false,
        creadoPor: TECNICO.nombre,
      });
      expect(r.body.codigo).toMatch(/^ASP-\d{6}$/);
      expect(r.body.seguimiento.frecuencia).toMatchObject({ id: cat.frecuencias[0].id });
      const ev = await eventos('qhse.aspecto_ambiental.registrado', r.body.id);
      expect(ev).toHaveLength(1);
      expect(ev[0].datos.data).toMatchObject({
        clasificacion: 'moderado',
        nivelRiesgo: 12,
        procesoId: proceso,
      });
    });

    it('con lo mínimo: nace vigente, con el control pendiente y la fecha de hoy', async () => {
      const r = await crear();
      expect(r.body).toMatchObject({ fecha: fechaEn(0), estadoControl: 'pendiente', factor: null });
      expect(r.body.control).toMatchObject({ responsable: null, presupuesto: null, plazo: null });
    });

    it('rechaza lo inválido: textos, rangos 1 a 5, catálogos inexistentes, fecha futura, presupuesto, responsable inactivo, permisos', async () => {
      expect((await crear({ actividad: '  ' })).body.message).toMatch(
        /actividad, el aspecto y el impacto/,
      );
      expect((await crear({ probabilidad: 6 })).status).toBe(400);
      expect((await crear({ consecuencia: 0 })).status).toBe(400);
      expect((await crear({ probabilidad: 2.5 })).status).toBe(400);
      expect((await crear({ clasificacion: 'critico' })).status).toBe(400);
      expect((await crear({ etapaId: uuidv7() })).body.message).toMatch(/etapa/);
      expect((await crear({ procesoId: uuidv7() })).body.message).toMatch(/proceso/);
      expect((await crear({ factorId: uuidv7() })).body.message).toMatch(/factor/);
      expect((await crear({ seguimientoFrecuenciaId: uuidv7() })).body.message).toMatch(
        /frecuencia/,
      );
      expect((await crear({ fecha: fechaEn(2) })).body.message).toMatch(/futura/);
      expect((await crear({ fechaValoracion: fechaEn(2) })).body.message).toMatch(/futura/);
      expect((await crear({ presupuesto: -5 })).status).toBe(400);
      expect((await crear({ responsableId: INACTIVO.id })).body.message).toMatch(/inactivo/);
      expect((await crear({}, soloVer())).status).toBe(403);
      expect((await t.http().get(ruta()).set(sinPermiso())).status).toBe(403);
      expect((await t.http().get(ruta(uuidv7())).set(soloVer())).status).toBe(404);
    });
  });

  describe('editar', () => {
    it('cambia solo lo indicado y recalcula el nivel de riesgo', async () => {
      const a = await creado({ ncar: 'NC-1' });
      const r = await t.http().patch(ruta(a.id)).set(gestor()).send({
        probabilidad: 5,
        consecuencia: 5,
        clasificacion: 'alto',
        estadoControl: 'implementado',
      });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({
        nivelRiesgo: 25,
        clasificacion: 'alto',
        actividad: 'Perforación de pozos',
        control: { ncar: 'NC-1', estadoControl: 'implementado' },
      });
      const ev = await eventos('qhse.aspecto_ambiental.actualizado', a.id);
      expect(ev).toHaveLength(1);
      expect(ev[0].datos.data).toMatchObject({ nivelRiesgo: 25, clasificacion: 'alto' });
    });

    it('valida igual que al registrar y exige permiso', async () => {
      const a = await creado();
      const patch = (cuerpo: Record<string, unknown>, quien = gestor()) =>
        t.http().patch(ruta(a.id)).set(quien).send(cuerpo);
      expect((await patch({ probabilidad: 9 })).status).toBe(400);
      expect((await patch({ actividad: ' ' })).status).toBe(400);
      expect((await patch({ procesoId: uuidv7() })).body.message).toMatch(/proceso/);
      expect((await patch({ ncar: 'x' }, soloVer())).status).toBe(403);
      expect((await detalle(a.id)).control.ncar).toBeNull();
    });
  });

  describe('seguimiento y control vencido', () => {
    it('registra si los controles fueron eficaces; el último registro manda', async () => {
      const a = await creado();
      const seg = (cuerpo: Record<string, unknown>) =>
        t.http().post(ruta(a.id, '/seguimientos')).set(gestor()).send(cuerpo);
      await seg({ fecha: fechaEn(-30), eficaz: false, observacion: 'Fuga en la piscina' });
      const r = await seg({ eficaz: true, observacion: 'Piscina reparada' });
      expect(r.status).toBe(201);
      expect(r.body.seguimiento.ultimaEficacia).toBe(true);
      expect(r.body.seguimiento.registros.map((x: { eficaz: boolean }) => x.eficaz)).toEqual([
        true,
        false,
      ]);
      expect(r.body.seguimiento.registros[0]).toMatchObject({
        registradoPor: TECNICO.nombre,
        fecha: fechaEn(0),
      });
      expect(await eventos('qhse.aspecto_ambiental.seguimiento_registrado', a.id)).toHaveLength(2);
    });

    it('rechaza fecha futura y observación vacía', async () => {
      const a = await creado();
      const seg = (cuerpo: Record<string, unknown>) =>
        t.http().post(ruta(a.id, '/seguimientos')).set(gestor()).send(cuerpo);
      expect(
        (await seg({ fecha: fechaEn(2), eficaz: true, observacion: 'x' })).body.message,
      ).toMatch(/futura/);
      expect((await seg({ eficaz: true, observacion: ' ' })).status).toBe(400);
      expect((await seg({ observacion: 'x' })).status).toBe(400);
    });

    it('un control sin implementar con el plazo cumplido está vencido; implementado, no', async () => {
      const a = await creado({ plazo: fechaEn(5) });
      await sql('UPDATE qhse.aspecto_ambiental SET plazo = CURRENT_DATE - 3 WHERE id = $1', [a.id]);
      expect((await detalle(a.id)).controlVencido).toBe(true);
      const lista = (await t.http().get(ruta()).set(soloVer())).body;
      expect(lista.kpi.controlVencido).toBeGreaterThanOrEqual(1);
      await t.http().patch(ruta(a.id)).set(gestor()).send({ estadoControl: 'implementado' });
      expect((await detalle(a.id)).controlVencido).toBe(false);
    });
  });

  describe('matriz, filtros y baja', () => {
    it('filtra por clasificación, estado del control, proceso y texto, y cuenta por clasificación', async () => {
      const alto = await creado({
        probabilidad: 5,
        consecuencia: 4,
        clasificacion: 'alto',
        aspecto: `Derrame de combustible ${n}`,
      });
      const bajo = await creado({
        probabilidad: 1,
        consecuencia: 1,
        clasificacion: 'bajo',
        estadoControl: 'implementado',
      });
      const ids = (r: { body: { items: Array<{ id: string }> } }) => r.body.items.map((i) => i.id);
      const soloAltos = await t
        .http()
        .get(`${ruta()}?clasificacion=alto&procesoId=${proceso}`)
        .set(soloVer());
      expect(ids(soloAltos)).toContain(alto.id);
      expect(ids(soloAltos)).not.toContain(bajo.id);
      const implementados = await t
        .http()
        .get(`${ruta()}?estadoControl=implementado&procesoId=${proceso}`)
        .set(soloVer());
      expect(ids(implementados)).toContain(bajo.id);
      const buscado = await t
        .http()
        .get(`${ruta()}?q=Derrame%20de%20combustible%20${n}`)
        .set(soloVer());
      expect(ids(buscado)).toEqual([alto.id]);
      const todos = await t.http().get(`${ruta()}?procesoId=${proceso}`).set(soloVer());
      expect(todos.body.kpi.total).toBeGreaterThanOrEqual(2);
      expect(todos.body.kpi.alto).toBeGreaterThanOrEqual(1);
      expect(todos.body.kpi.bajo).toBeGreaterThanOrEqual(1);
      expect((await t.http().get(`${ruta()}?clasificacion=critico`).set(soloVer())).status).toBe(
        400,
      );
    });

    it('la baja pide motivo, publica el evento, congela el aspecto y lo saca de la matriz vigente', async () => {
      const a = await creado();
      expect(
        (await t.http().post(ruta(a.id, '/baja')).set(gestor()).send({ motivo: ' ' })).status,
      ).toBe(400);
      expect(
        (await t.http().post(ruta(a.id, '/baja')).set(soloVer()).send({ motivo: 'x' })).status,
      ).toBe(403);
      const r = await t
        .http()
        .post(ruta(a.id, '/baja'))
        .set(gestor())
        .send({ motivo: 'La actividad ya no se realiza' });
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({
        estado: 'dado_de_baja',
        baja: { motivo: 'La actividad ya no se realiza', por: TECNICO.nombre },
      });
      expect(await eventos('qhse.aspecto_ambiental.dado_de_baja', a.id)).toHaveLength(1);
      const bloqueos: Array<[string, () => Promise<{ status: number }>]> = [
        ['editar', () => t.http().patch(ruta(a.id)).set(gestor()).send({ ncar: 'x' })],
        [
          'seguimiento',
          () =>
            t
              .http()
              .post(ruta(a.id, '/seguimientos'))
              .set(gestor())
              .send({ eficaz: true, observacion: 'x' }),
        ],
        [
          'baja',
          () => t.http().post(ruta(a.id, '/baja')).set(gestor()).send({ motivo: 'otra vez' }),
        ],
      ];
      for (const [nombre, llamar] of bloqueos)
        expect([nombre, (await llamar()).status]).toEqual([nombre, 409]);
      const vigentes = await t.http().get(`${ruta()}?procesoId=${proceso}`).set(soloVer());
      expect(vigentes.body.items.some((i: { id: string }) => i.id === a.id)).toBe(false);
      const bajas = await t
        .http()
        .get(`${ruta()}?estado=dado_de_baja&procesoId=${proceso}`)
        .set(soloVer());
      expect(bajas.body.items.some((i: { id: string }) => i.id === a.id)).toBe(true);
    });
  });

  describe('reglas de la base', () => {
    const insertar = (cols: Record<string, unknown> = {}) => {
      const v: Record<string, unknown> = {
        id: uuidv7(),
        fecha: '2026-01-01',
        etapa_id: cat.etapas[0].id,
        proceso_id: proceso,
        actividad: 'a',
        aspecto: 'b',
        impacto: 'c',
        probabilidad: 2,
        consecuencia: 2,
        clasificacion: 'bajo',
        created_by: TECNICO.id,
        ...cols,
      };
      const nombres = Object.keys(v);
      return sql(
        `INSERT INTO qhse.aspecto_ambiental (${nombres.join(', ')}) VALUES (${nombres.map((_, i) => `$${i + 1}`).join(', ')})`,
        nombres.map((k) => v[k]),
      );
    };

    it('probabilidad y consecuencia de 1 a 5, textos y presupuesto válidos, y nace vigente', async () => {
      await expect(insertar({ probabilidad: 0 })).rejects.toThrow(
        /aspecto_ambiental_valoracion_check/,
      );
      await expect(insertar({ consecuencia: 6 })).rejects.toThrow(
        /aspecto_ambiental_valoracion_check/,
      );
      await expect(insertar({ actividad: ' ' })).rejects.toThrow(/aspecto_ambiental_texto_check/);
      await expect(insertar({ impacto: '' })).rejects.toThrow(/aspecto_ambiental_texto_check/);
      await expect(insertar({ presupuesto: -1 })).rejects.toThrow(
        /aspecto_ambiental_presupuesto_check/,
      );
      await expect(
        insertar({
          estado: 'dado_de_baja',
          baja_at: new Date(),
          baja_por: TECNICO.id,
          baja_motivo: 'x',
        }),
      ).rejects.toThrow(/nace vigente/);
      await expect(insertar({ baja_motivo: 'x' })).rejects.toThrow(/aspecto_ambiental_baja_check/);
    });

    it('integridad referencial: etapa, proceso, factor, responsable y frecuencia existen', async () => {
      await expect(insertar({ etapa_id: uuidv7() })).rejects.toThrow(
        /aspecto_ambiental_etapa_fkey/,
      );
      await expect(insertar({ proceso_id: uuidv7() })).rejects.toThrow(
        /aspecto_ambiental_proceso_fkey/,
      );
      await expect(insertar({ factor_id: uuidv7() })).rejects.toThrow(
        /aspecto_ambiental_factor_fkey/,
      );
      await expect(insertar({ responsable_id: uuidv7() })).rejects.toThrow(
        /aspecto_ambiental_responsable_fkey/,
      );
      await expect(insertar({ seguimiento_frecuencia_id: uuidv7() })).rejects.toThrow(
        /aspecto_ambiental_seg_frecuencia_fkey/,
      );
    });

    it('un aspecto dado de baja no cambia ni recibe seguimiento, ni con el rol migrador', async () => {
      const a = await creado();
      await t.http().post(ruta(a.id, '/baja')).set(gestor()).send({ motivo: 'Obsoleto' });
      await expect(
        sql("UPDATE qhse.aspecto_ambiental SET ncar = 'x' WHERE id = $1", [a.id]),
      ).rejects.toThrow(/dado de baja y no admite cambios/);
      await expect(
        sql(
          "UPDATE qhse.aspecto_ambiental SET estado = 'vigente', baja_at = NULL, baja_por = NULL, baja_motivo = NULL WHERE id = $1",
          [a.id],
        ),
      ).rejects.toThrow(/dado de baja y no admite cambios/);
      await expect(
        sql(
          "INSERT INTO qhse.aspecto_ambiental_seguimiento (id, aspecto_id, fecha, eficaz, observacion, created_by) VALUES ($1, $2, CURRENT_DATE, true, 'x', $3)",
          [uuidv7(), a.id, TECNICO.id],
        ),
      ).rejects.toThrow(/dado de baja y no admite cambios/);
    });

    it('la aplicación no borra aspectos ni reescribe el seguimiento, y no cambia lo que no le toca', async () => {
      const a = await creado();
      await t
        .http()
        .post(ruta(a.id, '/seguimientos'))
        .set(gestor())
        .send({ eficaz: true, observacion: 'ok' });
      await expect(t.prisma.aspectoAmbiental.deleteMany({ where: { id: a.id } })).rejects.toThrow(
        /permission denied|denegado/i,
      );
      await expect(
        t.prisma.aspectoAmbiental.updateMany({
          where: { id: a.id },
          data: { createdBy: RESPONSABLE.id },
        }),
      ).rejects.toThrow(/permission denied|denegado/i);
      await expect(
        t.prisma.aspectoAmbientalSeguimiento.updateMany({
          where: { aspectoId: a.id },
          data: { observacion: 'cambiada' },
        }),
      ).rejects.toThrow(/permission denied|denegado/i);
      await expect(
        t.prisma.aspectoAmbientalSeguimiento.deleteMany({ where: { aspectoId: a.id } }),
      ).rejects.toThrow(/permission denied|denegado/i);
      await expect(
        sql(
          "INSERT INTO qhse.aspecto_ambiental_seguimiento (id, aspecto_id, fecha, eficaz, observacion, created_by) VALUES ($1, $2, CURRENT_DATE, true, ' ', $3)",
          [uuidv7(), a.id, TECNICO.id],
        ),
      ).rejects.toThrow(/aspecto_ambiental_seguimiento_texto_check/);
    });
  });
});
