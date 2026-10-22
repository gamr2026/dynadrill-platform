/**
 * Integración real de QHSE: investigación de incidentes (rebanada 4: acciones correctivas y preventivas), con las reglas de la base.
 *   RUN_INTEGRATION=1 npx jest investigaciones-acciones   (dentro de libs/qhse/seguridad; requiere `npm run db:seed:qhse`)
 */
import { Permission } from '@dyn/authz';
import { uuidv7 } from '@dyn/utils';
import { levantarAppDePrueba, type AppDePrueba } from '../testing/app-de-prueba';
import { borrarInvestigacionesDe } from '../testing/limpieza-investigaciones';
import { quitarMaestros, sembrarMaestros, type MaestrosDePrueba } from '../testing/maestros';

const run = process.env['RUN_INTEGRATION'] ? describe : describe.skip;
const P = Permission;
const H = 3_600_000;

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
const dia = (dias: number) =>
  new Date(Date.now() + dias * 24 * H).toLocaleDateString('en-CA', {
    timeZone: 'America/Guayaquil',
  });

run('QHSE: investigación de incidentes, acciones (base de datos real)', () => {
  jest.setTimeout(180000);
  let t: AppDePrueba;
  let nearMiss = '';
  const sql = (texto: string, params: unknown[] = []) => t.admin.query(texto, params);
  const gestor = () =>
    t.token(
      'tecnico_hse',
      TECNICO.nombre,
      [P.INVESTIGACIONES_VER, P.INVESTIGACIONES_GESTIONAR],
      TECNICO.id,
    );
  const soloVer = () => t.token('tecnico_hse', TECNICO.nombre, [P.INVESTIGACIONES_VER], TECNICO.id);
  const eventos = async (tipo: string, accionId: string) =>
    (
      await sql(
        "SELECT datos FROM msg_qhse.outbox WHERE tipo = $1 AND datos->'data'->>'accionId' = $2 ORDER BY ocurrido_at, id",
        [tipo, accionId],
      )
    ).rows as Salida[];

  /** Investigación abierta (sin iniciar) o en curso. */
  const investigacion = async (enCurso = true) => {
    const r = await t
      .http()
      .post('/api/qhse/investigaciones')
      .set(gestor())
      .send({
        resultadoId: nearMiss,
        descripcionEvento: 'Atrapamiento leve en la cadena',
        fechaIncidente: new Date(Date.now() - 5 * H).toISOString(),
        ubicacion: 'Locación 2',
      });
    expect(r.status).toBe(201);
    if (enCurso)
      expect(
        (
          await t
            .http()
            .post(`/api/qhse/investigaciones/${r.body.id}/iniciar`)
            .set(gestor())
            .send({ liderId: TECNICO.id })
        ).status,
      ).toBe(201);
    return r.body.id as string;
  };
  const ruta = (id: string, resto = '') => `/api/qhse/investigaciones/${id}/acciones${resto}`;
  const registrar = (id: string, cuerpo: Record<string, unknown> = {}, quien = gestor()) =>
    t
      .http()
      .post(ruta(id))
      .set(quien)
      .send({
        descripcion: 'Instalar guarda en la cadena',
        tipo: 'correctiva',
        responsableId: RESPONSABLE.id,
        plazo: dia(10),
        controles: ['fuente', 'medio'],
        ...cuerpo,
      });
  const accionDe = async (id: string, cuerpo: Record<string, unknown> = {}) => {
    const r = await registrar(id, cuerpo);
    expect(r.status).toBe(201);
    return r.body.acciones[r.body.acciones.length - 1] as { id: string; orden: number };
  };
  const paso = (
    id: string,
    accionId: string,
    nombre: string,
    cuerpo: Record<string, unknown> = {},
  ) =>
    t
      .http()
      .post(ruta(id, `/${accionId}/${nombre}`))
      .set(gestor())
      .send(cuerpo);

  beforeAll(async () => {
    t = await levantarAppDePrueba('3185');
    await sembrarMaestros(t.admin, MAESTROS);
    const res = await t.http().get('/api/qhse/investigaciones/resultados').set(soloVer());
    nearMiss = res.body.find((x: { codigo: string }) => x.codigo === 'near_miss').id;
  });

  afterAll(async () => {
    await borrarInvestigacionesDe(t.admin, [TECNICO.id, RESPONSABLE.id]);
    await quitarMaestros(t.admin, MAESTROS);
    await t.cerrar();
  });

  describe('registrar y editar', () => {
    it('registra una acción numerada, con sus niveles de control, historia y evento', async () => {
      const id = await investigacion();
      const a1 = await accionDe(id);
      const a2 = await accionDe(id, {
        descripcion: 'Capacitar al personal',
        tipo: 'preventiva',
        controles: [],
      });
      expect([a1.orden, a2.orden]).toEqual([1, 2]);
      const d = (await t.http().get(`/api/qhse/investigaciones/${id}`).set(soloVer())).body;
      expect(d.acciones[0]).toMatchObject({
        tipo: 'correctiva',
        estado: 'pendiente',
        responsable: { id: RESPONSABLE.id, nombre: RESPONSABLE.nombre },
        vencida: false,
      });
      expect([...d.acciones[0].controles].sort()).toEqual(['fuente', 'medio']);
      expect(d.acciones[1]).toMatchObject({ tipo: 'preventiva', controles: [] });
      const ev = await eventos('qhse.investigacion.accion_registrada', a1.id);
      expect(ev).toHaveLength(1);
      expect(ev[0].datos.data).toMatchObject({
        estado: 'pendiente',
        responsableId: RESPONSABLE.id,
      });
      expect(
        (
          await sql(
            'SELECT count(*)::int n FROM qhse.investigacion_accion_historial WHERE accion_id = $1',
            [a1.id],
          )
        ).rows[0].n,
      ).toBe(1);
    });

    it('rechaza lo inválido: sin investigación en curso, plazo pasado, responsable inexistente o inactivo, y a quien solo ve', async () => {
      const abierta = await investigacion(false);
      expect((await registrar(abierta)).body.message).toMatch(/investigación en curso/);
      const id = await investigacion();
      expect((await registrar(id, { plazo: dia(-1) })).body.message).toMatch(/fecha pasada/);
      expect((await registrar(id, { responsableId: uuidv7() })).body.message).toMatch(
        /responsable/,
      );
      expect((await registrar(id, { responsableId: INACTIVO.id })).body.message).toMatch(
        /inactivo/,
      );
      expect((await registrar(id, { descripcion: '  ' })).status).toBe(400);
      expect((await registrar(id, { tipo: 'otra' })).status).toBe(400);
      expect((await registrar(id, { controles: ['inventado'] })).status).toBe(400);
      expect((await registrar(id, {}, soloVer())).status).toBe(403);
      expect((await registrar(uuidv7())).status).toBe(404);
    });

    it('edita el contenido y reemplaza los niveles mientras está pendiente; deja de editarse al implementarla', async () => {
      const id = await investigacion();
      const a = await accionDe(id);
      const r = await t
        .http()
        .patch(ruta(id, `/${a.id}`))
        .set(gestor())
        .send({
          descripcion: 'Instalar guarda y señalizar',
          plazo: dia(20),
          controles: ['trabajador'],
        });
      expect(r.status).toBe(200);
      expect(r.body.acciones[0]).toMatchObject({
        descripcion: 'Instalar guarda y señalizar',
        plazo: dia(20),
        controles: ['trabajador'],
      });
      await paso(id, a.id, 'implementar');
      const otra = await t
        .http()
        .patch(ruta(id, `/${a.id}`))
        .set(gestor())
        .send({ descripcion: 'x' });
      expect(otra.status).toBe(409);
      expect(otra.body.message).toMatch(/ya no se edita/);
    });
  });

  describe('implementar, verificar y cancelar', () => {
    it('ciclo completo: implementada, verificada como eficaz; deja historia y eventos, e indica desde cuándo verificar (3 meses)', async () => {
      const id = await investigacion();
      const a = await accionDe(id);
      const impl = await paso(id, a.id, 'implementar', { observacion: 'Guarda instalada' });
      expect(impl.status).toBe(201);
      const hecha = impl.body.acciones[0];
      expect(hecha.estado).toBe('implementada');
      const hoy = dia(0);
      const [y, m, d] = hoy.split('-').map(Number);
      const esperado = new Date(Date.UTC(y, m - 1 + 3, d));
      if (esperado.getUTCDate() !== d) esperado.setUTCDate(0);
      expect(hecha.verificableDesde).toBe(esperado.toISOString().slice(0, 10));
      const ver = await paso(id, a.id, 'verificar', { fueEficaz: true });
      expect(ver.body.acciones[0]).toMatchObject({ estado: 'verificada', fueEficaz: true });
      expect(await eventos('qhse.investigacion.accion_implementada', a.id)).toHaveLength(1);
      const ev = await eventos('qhse.investigacion.accion_verificada', a.id);
      expect(ev).toHaveLength(1);
      expect(ev[0].datos.data).toMatchObject({ estado: 'verificada', fueEficaz: true });
      const hist = (
        await sql(
          'SELECT estado_nuevo FROM qhse.investigacion_accion_historial WHERE accion_id = $1 ORDER BY created_at',
          [a.id],
        )
      ).rows.map((r: { estado_nuevo: string }) => r.estado_nuevo);
      expect(hist).toEqual(['pendiente', 'implementada', 'verificada']);
    });

    it('una acción que no resultó eficaz exige explicarlo', async () => {
      const id = await investigacion();
      const a = await accionDe(id);
      await paso(id, a.id, 'implementar');
      expect((await paso(id, a.id, 'verificar', { fueEficaz: false })).body.message).toMatch(
        /explique por qué/,
      );
      const r = await paso(id, a.id, 'verificar', {
        fueEficaz: false,
        observacion: 'Volvió a ocurrir',
      });
      expect(r.body.acciones[0]).toMatchObject({ estado: 'verificada', fueEficaz: false });
    });

    it('no se saltan pasos ni se repiten: verificar sin implementar, implementar dos veces, cancelar una implementada', async () => {
      const id = await investigacion();
      const a = await accionDe(id);
      expect((await paso(id, a.id, 'verificar', { fueEficaz: true })).status).toBe(409);
      await paso(id, a.id, 'implementar');
      expect((await paso(id, a.id, 'implementar')).status).toBe(409);
      expect((await paso(id, a.id, 'cancelar', { motivo: 'ya no aplica' })).status).toBe(409);
      expect((await paso(uuidv7(), a.id, 'implementar')).status).toBe(404);
      expect(await eventos('qhse.investigacion.accion_implementada', a.id)).toHaveLength(1);
    });

    it('cancela una acción pendiente con motivo y no se borra', async () => {
      const id = await investigacion();
      const a = await accionDe(id);
      expect((await paso(id, a.id, 'cancelar', { motivo: ' ' })).status).toBe(400);
      const r = await paso(id, a.id, 'cancelar', { motivo: 'Se resolvió con otra medida' });
      expect(r.body.acciones[0]).toMatchObject({
        estado: 'cancelada',
        cancelacionMotivo: 'Se resolvió con otra medida',
      });
      expect(await eventos('qhse.investigacion.accion_cancelada', a.id)).toHaveLength(1);
    });

    it('solo quien gestiona avanza una acción', async () => {
      const id = await investigacion();
      const a = await accionDe(id);
      const r = await t
        .http()
        .post(ruta(id, `/${a.id}/implementar`))
        .set(soloVer())
        .send({});
      expect(r.status).toBe(403);
    });

    it('una acción pendiente con el plazo cumplido se muestra vencida', async () => {
      const id = await investigacion();
      const a = await accionDe(id);
      await sql('UPDATE qhse.investigacion_accion SET plazo = CURRENT_DATE - 3 WHERE id = $1', [
        a.id,
      ]);
      const d = (await t.http().get(`/api/qhse/investigaciones/${id}`).set(soloVer())).body;
      expect(d.acciones[0].vencida).toBe(true);
    });
  });

  describe('reglas de la base', () => {
    const insertar = (id: string, extra = '', valores: unknown[] = []) =>
      sql(
        `INSERT INTO qhse.investigacion_accion (id, investigacion_id, orden, descripcion, tipo, responsable_id, plazo, created_by${extra ? ', ' + extra.split('=')[0] : ''})
         VALUES ($1, $2, $3, 'x', 'correctiva', $4, CURRENT_DATE + 5, $5${valores.length ? ', ' + valores.map((_, i) => `$${i + 6}`).join(', ') : ''})`,
        [
          uuidv7(),
          id,
          Math.floor(Math.random() * 1e6) + 100,
          RESPONSABLE.id,
          TECNICO.id,
          ...valores,
        ],
      );

    it('solo nacen acciones pendientes y con la investigación en curso', async () => {
      const abierta = await investigacion(false);
      await expect(insertar(abierta)).rejects.toThrow(/investigación en curso/);
      const id = await investigacion();
      await expect(insertar(id, 'estado=1', ['implementada'])).rejects.toThrow(/nace pendiente/);
    });

    it('no se saltan estados ni se cambia el contenido de una acción que ya no está pendiente', async () => {
      const id = await investigacion();
      const a = await accionDe(id);
      await expect(
        sql(
          "UPDATE qhse.investigacion_accion SET estado = 'verificada', implementada_at = now(), implementada_por = $2, fue_eficaz = true, verificada_at = now(), verificada_por = $2 WHERE id = $1",
          [a.id, TECNICO.id],
        ),
      ).rejects.toThrow(/Cambio de estado no permitido/);
      await paso(id, a.id, 'implementar');
      await expect(
        sql("UPDATE qhse.investigacion_accion SET descripcion = 'cambiada' WHERE id = $1", [a.id]),
      ).rejects.toThrow(/ya no se edita/);
      await expect(
        sql(
          "UPDATE qhse.investigacion_accion SET estado = 'pendiente', implementada_at = NULL, implementada_por = NULL WHERE id = $1",
          [a.id],
        ),
      ).rejects.toThrow(/Cambio de estado no permitido/);
      await expect(
        sql('UPDATE qhse.investigacion_accion SET orden = 99 WHERE id = $1', [a.id]),
      ).rejects.toThrow(/no se cambian/);
    });

    it('cada estado trae sus datos (CHECK)', async () => {
      const id = await investigacion();
      const a = await accionDe(id);
      await expect(
        sql("UPDATE qhse.investigacion_accion SET estado = 'implementada' WHERE id = $1", [a.id]),
      ).rejects.toThrow(/investigacion_accion_estado_check/);
      await expect(
        sql(
          "UPDATE qhse.investigacion_accion SET estado = 'cancelada', cancelada_at = now(), cancelada_por = $2 WHERE id = $1",
          [a.id, TECNICO.id],
        ),
      ).rejects.toThrow(/investigacion_accion_estado_check/);
      await paso(id, a.id, 'implementar');
      await expect(
        sql(
          "UPDATE qhse.investigacion_accion SET estado = 'verificada', fue_eficaz = false, verificada_at = now(), verificada_por = $2 WHERE id = $1",
          [a.id, TECNICO.id],
        ),
      ).rejects.toThrow(/investigacion_accion_estado_check/);
    });

    it('los niveles de control solo cambian con la acción pendiente', async () => {
      const id = await investigacion();
      const a = await accionDe(id);
      await paso(id, a.id, 'implementar');
      await expect(
        sql(
          "INSERT INTO qhse.investigacion_accion_control (accion_id, nivel, created_by) VALUES ($1, 'trabajador', $2)",
          [a.id, TECNICO.id],
        ),
      ).rejects.toThrow(/ya no se edita/);
      await expect(
        sql('DELETE FROM qhse.investigacion_accion_control WHERE accion_id = $1', [a.id]),
      ).rejects.toThrow(/ya no se edita/);
    });

    it('la aplicación no borra acciones ni reescribe su historia ni cambia quién creó o la investigación', async () => {
      const id = await investigacion();
      const a = await accionDe(id);
      await expect(
        t.prisma.investigacionAccion.deleteMany({ where: { id: a.id } }),
      ).rejects.toThrow(/permission denied|denegado/i);
      await expect(
        t.prisma.investigacionAccion.updateMany({
          where: { id: a.id },
          data: { createdBy: RESPONSABLE.id },
        }),
      ).rejects.toThrow(/permission denied|denegado/i);
      await expect(
        t.prisma.investigacionAccionHistorial.deleteMany({ where: { accionId: a.id } }),
      ).rejects.toThrow(/permission denied|denegado/i);
      await expect(
        t.prisma.investigacionAccionHistorial.updateMany({
          where: { accionId: a.id },
          data: { observacion: 'x' },
        }),
      ).rejects.toThrow(/permission denied|denegado/i);
    });

    it('integridad: FK del responsable, orden positivo y orden único por investigación', async () => {
      const id = await investigacion();
      const a = await accionDe(id);
      await expect(
        sql('UPDATE qhse.investigacion_accion SET responsable_id = $2 WHERE id = $1', [
          a.id,
          uuidv7(),
        ]),
      ).rejects.toThrow(/investigacion_accion_responsable_fkey/);
      await expect(
        sql(
          "INSERT INTO qhse.investigacion_accion (id, investigacion_id, orden, descripcion, tipo, responsable_id, plazo, created_by) VALUES ($1, $2, 1, 'dup', 'correctiva', $3, CURRENT_DATE, $4)",
          [uuidv7(), id, RESPONSABLE.id, TECNICO.id],
        ),
      ).rejects.toThrow(/investigacion_accion_orden_key/);
      await expect(
        sql(
          "INSERT INTO qhse.investigacion_accion (id, investigacion_id, orden, descripcion, tipo, responsable_id, plazo, created_by) VALUES ($1, $2, 0, 'x', 'correctiva', $3, CURRENT_DATE, $4)",
          [uuidv7(), id, RESPONSABLE.id, TECNICO.id],
        ),
      ).rejects.toThrow(/investigacion_accion_orden_check/);
    });
  });
});
