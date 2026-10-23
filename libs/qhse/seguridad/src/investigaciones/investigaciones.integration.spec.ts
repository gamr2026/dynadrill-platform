/**
 * Integración real de QHSE: investigación de incidentes (rebanada 1: núcleo), con las reglas de la base.
 *   RUN_INTEGRATION=1 npx jest investigaciones   (dentro de libs/qhse/seguridad; requiere `npm run db:seed:qhse`)
 */
import { Permission } from '@dyn/authz';
import { uuidv7 } from '@dyn/utils';
import { levantarAppDePrueba, type AppDePrueba } from '../testing/app-de-prueba';
import { quitarMaestros, sembrarMaestros, type MaestrosDePrueba } from '../testing/maestros';

const run = process.env['RUN_INTEGRATION'] ? describe : describe.skip;
const P = Permission;
const H = 3_600_000;

const TECNICO = { id: uuidv7(), nombre: 'Tania Técnica HSE' };
const LIDER = { id: uuidv7(), nombre: 'Luis Líder HSE' };
const INACTIVO = { id: uuidv7(), nombre: 'Ines Inactiva', activo: false };
const OPERADOR = { id: uuidv7(), nombre: 'Oscar Operador' };
const MAESTROS: MaestrosDePrueba = {
  usuarios: [
    { ...TECNICO, rol: 'tecnico_hse' },
    { ...LIDER, rol: 'gerente_hse' },
    { ...INACTIVO, rol: 'tecnico_hse' },
    { ...OPERADOR, rol: 'operador' },
  ],
};

type Salida = { datos: { actor?: { userId: string }; data: Record<string, unknown> } };
const haceHoras = (h: number) => new Date(Date.now() - h * H).toISOString();

run('QHSE: investigación de incidentes, núcleo (base de datos real)', () => {
  jest.setTimeout(180000);
  let t: AppDePrueba;
  let resultado: Record<string, { id: string }> = {};
  const sql = (texto: string, params: unknown[] = []) => t.admin.query(texto, params);

  const gestor = () =>
    t.token(
      'tecnico_hse',
      TECNICO.nombre,
      [P.QHSE_REPORTAR, P.INVESTIGACIONES_VER, P.INVESTIGACIONES_GESTIONAR],
      TECNICO.id,
    );
  const soloVer = () => t.token('tecnico_hse', TECNICO.nombre, [P.INVESTIGACIONES_VER], TECNICO.id);
  const operador = () => t.token('operador', OPERADOR.nombre, [P.QHSE_REPORTAR], OPERADOR.id);

  const eventos = async (tipo: string, id: string) =>
    (
      await sql(
        "SELECT datos FROM msg_qhse.outbox WHERE tipo = $1 AND datos->'data'->>'investigacionId' = $2 ORDER BY ocurrido_at, id",
        [tipo, id],
      )
    ).rows as Salida[];

  const abrir = (cuerpo: Record<string, unknown> = {}, quien = gestor()) =>
    t
      .http()
      .post('/api/qhse/investigaciones')
      .set(quien)
      .send({
        resultadoId: resultado['near_miss'].id,
        descripcionEvento: 'Se soltó una eslinga durante el izaje',
        fechaIncidente: haceHoras(2),
        ubicacion: 'Locación 4',
        ...cuerpo,
      });
  const abierta = async (cuerpo: Record<string, unknown> = {}) => {
    const r = await abrir(cuerpo);
    expect(r.status).toBe(201);
    return r.body as { id: string; codigo: string; estado: string };
  };

  beforeAll(async () => {
    t = await levantarAppDePrueba('3188');
    await sembrarMaestros(t.admin, MAESTROS);
    const r = await t.http().get('/api/qhse/investigaciones/resultados').set(soloVer());
    resultado = Object.fromEntries(
      r.body.map((x: { codigo: string; id: string }) => [x.codigo, x]),
    );
  });

  afterAll(async () => {
    const ids = [TECNICO.id, LIDER.id, OPERADOR.id];
    await sql('DELETE FROM qhse.investigacion_historial WHERE actor_id = ANY($1::uuid[])', [ids]);
    await sql('DELETE FROM qhse.investigacion WHERE created_by = ANY($1::uuid[])', [ids]);
    await sql('DELETE FROM qhse.emergencia WHERE created_by = ANY($1::uuid[])', [ids]);
    await sql(
      "DELETE FROM msg_qhse.outbox WHERE tipo LIKE 'qhse.investigacion.%' AND datos->'actor'->>'userId' = ANY($1::text[])",
      [ids],
    );
    await quitarMaestros(t.admin, MAESTROS);
    await t.cerrar();
  });

  describe('catálogo de resultados', () => {
    it('trae los siete resultados con los plazos de HSE-TRIAGE-002 y marca los supuestos', async () => {
      const r = await t.http().get('/api/qhse/investigaciones/resultados').set(soloVer());
      expect(r.status).toBe(200);
      expect(r.body.map((x: { codigo: string }) => x.codigo)).toEqual([
        'fatal',
        'grave',
        'leve',
        'primeros_auxilios',
        'dano_material',
        'near_miss',
        'incidente_ambiental',
      ]);
      const por = Object.fromEntries(r.body.map((x: { codigo: string }) => [x.codigo, x]));
      expect(por['near_miss']).toMatchObject({
        inicioHoras: 72,
        preliminarHoras: null,
        finalDias: 30,
        plazoSupuesto: false,
        involucraLesionado: false,
      });
      expect(por['fatal']).toMatchObject({ inicioHoras: 0, preliminarHoras: 24, finalDias: 15 });
      expect(por['dano_material'].plazoSupuesto).toBe(true);
    });
  });

  describe('abrir', () => {
    it('quien gestiona la abre: nace abierta, con consecutivo, historia y el evento para reportería', async () => {
      const a = await abierta();
      expect(a.estado).toBe('abierta');
      expect(a.codigo).toMatch(/^INV-\d{6}$/);
      const d = (await t.http().get(`/api/qhse/investigaciones/${a.id}`).set(soloVer())).body;
      expect(d).toMatchObject({
        estado: 'abierta',
        resultado: { codigo: 'near_miss', involucraLesionado: false },
        ubicacion: 'Locación 4',
        creadoPor: TECNICO.nombre,
        lider: null,
      });
      expect(d.historial).toHaveLength(1);
      expect(d.historial[0]).toMatchObject({ estadoAnterior: null, estadoNuevo: 'abierta' });
      const ev = await eventos('qhse.investigacion.abierta', a.id);
      expect(ev).toHaveLength(1);
      expect(ev[0].datos.data).toMatchObject({
        resultado: 'near_miss',
        involucraLesionado: false,
        estado: 'abierta',
      });
    });

    it('solo quien tiene el permiso entra: ver no basta para abrir y un trabajador no ve la bandeja', async () => {
      expect((await abrir({}, soloVer())).status).toBe(403);
      expect((await abrir({}, operador())).status).toBe(403);
      expect((await t.http().get('/api/qhse/investigaciones').set(operador())).status).toBe(403);
    });

    it('rechaza lo inválido con mensajes claros', async () => {
      expect(
        (await abrir({ fechaIncidente: new Date(Date.now() + 3 * H).toISOString() })).body.message,
      ).toMatch(/futura/);
      expect((await abrir({ descripcionEvento: '   ' })).status).toBe(400);
      expect((await abrir({ ubicacion: '' })).status).toBe(400);
      expect((await abrir({ resultadoId: uuidv7() })).body.message).toMatch(/resultado/);
      expect((await abrir({ resultadoId: 'no-es-uuid' })).status).toBe(400);
    });

    it('una emergencia origina a lo sumo una investigación', async () => {
      // la FK a emergencia es real: la emergencia de origen tiene que existir
      const emergencia = uuidv7();
      await sql(
        "INSERT INTO qhse.emergencia (id, tipo_id, descripcion, activado_por, created_by) SELECT $1, id, 'origen de investigación', $2, $2 FROM qhse.emergencia_tipo WHERE codigo = 'otro'",
        [emergencia, OPERADOR.id],
      );
      await abierta({ origenEmergenciaId: emergencia });
      const otra = await abrir({ origenEmergenciaId: emergencia });
      expect(otra.status).toBe(409);
      expect(otra.body.message).toMatch(/ya tiene una investigación/);
    });
  });

  describe('iniciar', () => {
    it('nombra al líder y registra la escena asegurada: pasa a en investigación, con historia y evento', async () => {
      const a = await abierta();
      const escena = haceHoras(1);
      const r = await t
        .http()
        .post(`/api/qhse/investigaciones/${a.id}/iniciar`)
        .set(gestor())
        .send({ liderId: LIDER.id, escenaAseguradaAt: escena });
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({
        estado: 'en_investigacion',
        lider: { id: LIDER.id, nombre: LIDER.nombre },
      });
      expect(new Date(r.body.escenaAseguradaAt).toISOString()).toBe(escena);
      expect(r.body.historial.map((h: { estadoNuevo: string }) => h.estadoNuevo)).toEqual([
        'abierta',
        'en_investigacion',
      ]);
      const ev = await eventos('qhse.investigacion.iniciada', a.id);
      expect(ev).toHaveLength(1);
      expect(ev[0].datos.data).toMatchObject({ liderId: LIDER.id, estado: 'en_investigacion' });
    });

    it('sin escena indicada se toma el momento actual; no se inicia dos veces', async () => {
      const a = await abierta();
      const ruta = `/api/qhse/investigaciones/${a.id}/iniciar`;
      const r = await t.http().post(ruta).set(gestor()).send({ liderId: LIDER.id });
      expect(r.status).toBe(201);
      expect(Date.now() - new Date(r.body.escenaAseguradaAt).getTime()).toBeLessThan(60_000);
      const otra = await t.http().post(ruta).set(gestor()).send({ liderId: LIDER.id });
      expect(otra.status).toBe(409);
      expect(await eventos('qhse.investigacion.iniciada', a.id)).toHaveLength(1);
    });

    it('rechaza escena futura o anterior al incidente, líder inexistente o inactivo, y a quien no gestiona', async () => {
      const a = await abierta({ fechaIncidente: haceHoras(5) });
      const iniciar = (cuerpo: Record<string, unknown>, quien = gestor()) =>
        t.http().post(`/api/qhse/investigaciones/${a.id}/iniciar`).set(quien).send(cuerpo);
      expect(
        (await iniciar({ liderId: LIDER.id, escenaAseguradaAt: new Date(Date.now() + 2 * H) })).body
          .message,
      ).toMatch(/futuro/);
      expect(
        (await iniciar({ liderId: LIDER.id, escenaAseguradaAt: haceHoras(9) })).body.message,
      ).toMatch(/antes del incidente/);
      expect((await iniciar({ liderId: uuidv7() })).status).toBe(400);
      expect((await iniciar({ liderId: INACTIVO.id })).status).toBe(400);
      expect((await iniciar({ liderId: LIDER.id }, soloVer())).status).toBe(403);
      const d = (await t.http().get(`/api/qhse/investigaciones/${a.id}`).set(soloVer())).body;
      expect(d.estado).toBe('abierta');
    });
  });

  describe('plazos y bandeja', () => {
    it('calcula los plazos del catálogo: Near Miss con inicio vencido y final vencido a los 30 días', async () => {
      const vieja = await abierta({ fechaIncidente: haceHoras(31 * 24) });
      const d = (await t.http().get(`/api/qhse/investigaciones/${vieja.id}`).set(soloVer())).body;
      expect(d.plazos).toMatchObject({
        inicioVencido: true,
        preliminarLimite: null,
        finalVencido: true,
      });
      const reciente = await abierta({ fechaIncidente: haceHoras(1) });
      const r = (await t.http().get(`/api/qhse/investigaciones/${reciente.id}`).set(soloVer()))
        .body;
      expect(r.plazos).toMatchObject({ inicioVencido: false, finalVencido: false });
    });

    it('la bandeja filtra por estado y por resultado, y cuenta lo vencido', async () => {
      const fatal = await abierta({
        resultadoId: resultado['fatal'].id,
        fechaIncidente: haceHoras(3),
      });
      const todas = (await t.http().get('/api/qhse/investigaciones').set(soloVer())).body;
      expect(todas.items.some((i: { id: string }) => i.id === fatal.id)).toBe(true);
      expect(todas.kpi.conPlazoVencido).toBeGreaterThan(0);
      const soloFatales = (
        await t
          .http()
          .get('/api/qhse/investigaciones?resultado=fatal&estado=abierta')
          .set(soloVer())
      ).body;
      expect(
        soloFatales.items.every(
          (i: { resultado: { codigo: string } }) => i.resultado.codigo === 'fatal',
        ),
      ).toBe(true);
      expect(soloFatales.items.some((i: { id: string }) => i.id === fatal.id)).toBe(true);
      expect(
        (await t.http().get('/api/qhse/investigaciones?estado=inventado').set(soloVer())).status,
      ).toBe(400);
    });
  });

  describe('reglas de la base', () => {
    const insertar = (extra: Partial<Record<string, unknown>> = {}) => {
      const v = {
        id: uuidv7(),
        resultado_id: resultado['near_miss'].id,
        descripcion_evento: 'x',
        fecha_incidente: new Date(),
        ubicacion: 'y',
        estado: 'abierta',
        lider_id: null,
        escena_asegurada_at: null,
        created_by: TECNICO.id,
        ...extra,
      };
      return sql(
        `INSERT INTO qhse.investigacion (id, resultado_id, descripcion_evento, fecha_incidente, ubicacion, estado, lider_id, escena_asegurada_at, created_by)
         VALUES ($1, $2, $3, $4, $5, $6::qhse.estado_investigacion, $7, $8, $9)`,
        [
          v.id,
          v.resultado_id,
          v.descripcion_evento,
          v.fecha_incidente,
          v.ubicacion,
          v.estado,
          v.lider_id,
          v.escena_asegurada_at,
          v.created_by,
        ],
      );
    };

    it('nace abierta y cada estado trae sus datos (CHECK y trigger)', async () => {
      await expect(insertar({ estado: 'cerrada' })).rejects.toThrow(/nace abierta/);
      await expect(insertar({ estado: 'abierta', lider_id: LIDER.id })).rejects.toThrow(
        /investigacion_estado_check/,
      );
      await expect(insertar({ descripcion_evento: '  ' })).rejects.toThrow(
        /investigacion_texto_check/,
      );
      await expect(insertar({ ubicacion: '' })).rejects.toThrow(/investigacion_texto_check/);
    });

    it('no se salta de estado, ni se pasa a en investigación sin líder y escena, ni se reescribe lo reportado', async () => {
      const a = await abierta();
      await expect(
        sql("UPDATE qhse.investigacion SET estado = 'cerrada' WHERE id = $1", [a.id]),
      ).rejects.toThrow(/Cambio de estado no permitido/);
      await expect(
        sql("UPDATE qhse.investigacion SET estado = 'en_revision' WHERE id = $1", [a.id]),
      ).rejects.toThrow(/Cambio de estado no permitido/);
      await expect(
        sql("UPDATE qhse.investigacion SET estado = 'en_investigacion' WHERE id = $1", [a.id]),
      ).rejects.toThrow(/investigacion_estado_check/);
      await expect(
        sql('UPDATE qhse.investigacion SET resultado_id = $2 WHERE id = $1', [
          a.id,
          resultado['fatal'].id,
        ]),
      ).rejects.toThrow(/no se cambian/);
      await expect(
        sql("UPDATE qhse.investigacion SET ubicacion = 'otra' WHERE id = $1", [a.id]),
      ).rejects.toThrow(/no se cambian/);
    });

    it('integridad: resultado y líder existen (FK) y los plazos del catálogo son coherentes', async () => {
      await expect(insertar({ resultado_id: uuidv7() })).rejects.toThrow(
        /investigacion_resultado_fkey/,
      );
      const a = await abierta();
      await expect(
        sql(
          "UPDATE qhse.investigacion SET estado = 'en_investigacion', lider_id = $2, escena_asegurada_at = now() WHERE id = $1",
          [a.id, uuidv7()],
        ),
      ).rejects.toThrow(/investigacion_lider_fkey/);
      await expect(
        sql('UPDATE qhse.investigacion_resultado SET inicio_horas = -1 WHERE codigo = $1', [
          'near_miss',
        ]),
      ).rejects.toThrow(/investigacion_resultado_plazos_check/);
      await expect(
        sql('UPDATE qhse.investigacion_resultado SET final_dias = 0 WHERE codigo = $1', [
          'near_miss',
        ]),
      ).rejects.toThrow(/investigacion_resultado_plazos_check/);
    });

    it('la aplicación no borra investigaciones ni historia, no reescribe el historial y solo cambia lo permitido', async () => {
      const a = await abierta();
      await expect(t.prisma.investigacion.deleteMany({ where: { id: a.id } })).rejects.toThrow(
        /permission denied|denegado/i,
      );
      await expect(
        t.prisma.investigacion.updateMany({ where: { id: a.id }, data: { ubicacion: 'otra' } }),
      ).rejects.toThrow(/permission denied|denegado/i);
      await expect(
        t.prisma.investigacion.updateMany({
          where: { id: a.id },
          data: { descripcionEvento: 'otra' },
        }),
      ).rejects.toThrow(/permission denied|denegado/i);
      await expect(
        t.prisma.investigacionHistorial.deleteMany({ where: { investigacionId: a.id } }),
      ).rejects.toThrow(/permission denied|denegado/i);
      await expect(
        t.prisma.investigacionHistorial.updateMany({
          where: { investigacionId: a.id },
          data: { observacion: 'cambiada' },
        }),
      ).rejects.toThrow(/permission denied|denegado/i);
    });
  });
});
