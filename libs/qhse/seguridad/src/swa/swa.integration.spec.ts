/**
 * Integración real de QHSE: Stop Work Authority (SWA), con las reglas de la base.
 *   RUN_INTEGRATION=1 npx jest swa   (dentro de libs/qhse/seguridad)
 */
import { Permission } from '@dyn/authz';
import { uuidv7 } from '@dyn/utils';
import { levantarAppDePrueba, type AppDePrueba } from '../testing/app-de-prueba';
import { quitarMaestros, sembrarMaestros, type MaestrosDePrueba } from '../testing/maestros';

const run = process.env['RUN_INTEGRATION'] ? describe : describe.skip;
const n = Date.now();
const P = Permission;

const TECNICO = { id: uuidv7(), nombre: 'Tania Técnica HSE' };
const SUPERVISOR = { id: uuidv7(), nombre: 'Sara Supervisora' };
const OPERADOR = { id: uuidv7(), nombre: 'Oscar Operador' };
const MAESTROS: MaestrosDePrueba = {
  usuarios: [
    { ...TECNICO, rol: 'tecnico_hse' },
    { ...SUPERVISOR, rol: 'supervisor' },
    { ...OPERADOR, rol: 'operador' },
  ],
};

type Salida = {
  datos: { source: string; actor?: { userId: string }; data: Record<string, unknown> };
};
type Detalle = {
  id: string;
  estado: string;
  cadena: Array<{ rolCadenaId: string; rolCodigo: string; notificadoAt: string | null }>;
  criterios: Array<{ criterioId: string; confirmadoAt: string | null }>;
  notificacionCompleta: boolean;
  reinicioCompleto: boolean;
};

run('QHSE: Stop Work Authority (base de datos real)', () => {
  jest.setTimeout(120000);
  let t: AppDePrueba;
  let tipoId = '';
  const tickets: string[] = [];
  const swas: string[] = [];

  /** El Operador activa (cualquier trabajador tiene `qhse.eventos.reportar`); el Técnico HSE gestiona; el Supervisor no ve la bandeja. */
  const operador = () => t.token('operador', OPERADOR.nombre, [P.QHSE_REPORTAR], OPERADOR.id);
  const tecnico = () =>
    t.token(
      'tecnico_hse',
      TECNICO.nombre,
      [P.QHSE_REPORTAR, P.SWA_VER, P.SWA_GESTIONAR],
      TECNICO.id,
    );
  const supervisor = () =>
    t.token('supervisor', SUPERVISOR.nombre, [P.QHSE_REPORTAR], SUPERVISOR.id);

  const ticketNuevo = async () => {
    const ticketId = uuidv7();
    tickets.push(ticketId);
    await t.prisma.ticketRef.create({
      data: {
        ticketId,
        pedidoId: uuidv7(),
        pedidoCodigo: `PED-SWA${n}`,
        ticketNumero: 970_000 + tickets.length,
        supervisorId: SUPERVISOR.id,
        cliente: 'Cliente SWA',
      },
    });
    return ticketId;
  };
  const activar = async (cuerpo: Record<string, unknown> = {}, quien = operador()) => {
    const r = await t
      .http()
      .post('/api/qhse/swa')
      .set(quien)
      .send({
        tipoPeligroId: tipoId,
        descripcion: 'Fuga en la línea de alta presión',
        ubicacion: 'Locación 3',
        ...cuerpo,
      });
    if (r.status === 201) swas.push(r.body.id);
    return r;
  };
  const detalle = async (id: string) =>
    (await t.http().get(`/api/qhse/swa/${id}`).set(tecnico())).body as Detalle;
  const post = (
    id: string,
    ruta: string,
    cuerpo: Record<string, unknown> = {},
    quien = tecnico(),
  ) => t.http().post(`/api/qhse/swa/${id}/${ruta}`).set(quien).send(cuerpo);
  const eventos = async (tipo: string, swaId: string) =>
    (
      await t.admin.query(
        "SELECT datos FROM msg_qhse.outbox WHERE tipo = $1 AND datos->'data'->>'swaId' = $2 ORDER BY ocurrido_at, id",
        [tipo, swaId],
      )
    ).rows as Salida[];
  const notificarTodos = async (id: string) => {
    for (const c of (await detalle(id)).cadena)
      expect((await post(id, 'notificaciones', { rolCadenaId: c.rolCadenaId })).status).toBe(201);
  };
  const confirmarTodos = async (id: string) => {
    for (const c of (await detalle(id)).criterios)
      expect((await post(id, 'reinicio', { criterioId: c.criterioId })).status).toBe(201);
  };

  beforeAll(async () => {
    t = await levantarAppDePrueba('3197');
    await sembrarMaestros(t.admin, MAESTROS);
    tipoId = (await t.admin.query("SELECT id FROM qhse.swa_tipo_peligro WHERE codigo = 'quimico'"))
      .rows[0].id; // sembrado por db:seed:qhse
  });

  afterAll(async () => {
    await t.admin.query('DELETE FROM qhse.swa WHERE id = ANY($1::uuid[])', [swas]);
    await t.admin.query('DELETE FROM qhse.ticket_ref WHERE ticket_id = ANY($1::uuid[])', [tickets]);
    await t.admin.query(
      "DELETE FROM msg_qhse.outbox WHERE datos->'data'->>'swaId' = ANY($1::text[])",
      [swas],
    );
    await quitarMaestros(t.admin, MAESTROS);
    await t.cerrar();
  });

  it('cualquier trabajador la activa y se publica qhse.swa.activado con el ticket bloqueado y los avisos al supervisor y al equipo HSE', async () => {
    const ticketId = await ticketNuevo();
    const r = await activar({ ticketId });
    expect(r.status).toBe(201);
    expect(r.body).toEqual({
      id: expect.any(String),
      codigo: expect.stringMatching(/^SWA-\d{6}$/),
      estado: 'activo',
    });
    // quien activa no ve la bandeja ni el detalle
    expect((await t.http().get('/api/qhse/swa').set(operador())).status).toBe(403);
    expect((await t.http().get(`/api/qhse/swa/${r.body.id}`).set(supervisor())).status).toBe(403);

    const ev = await eventos('qhse.swa.activado', r.body.id);
    expect(ev).toHaveLength(1);
    expect(ev[0].datos.source).toBe('qhse');
    expect(ev[0].datos.actor?.userId).toBe(OPERADOR.id);
    const d = ev[0].datos.data;
    expect(d).toMatchObject({
      swaId: r.body.id,
      ticketId,
      swaActivasEnTicket: 1,
      sinSwaActivas: false,
      tipoPeligro: 'quimico',
      activadoPor: OPERADOR.nombre,
    });
    const asignados = d['asignados'] as Array<{ usuarioId: string; rolCodigo: string }>;
    expect(asignados).toEqual(
      expect.arrayContaining([
        { usuarioId: SUPERVISOR.id, rolCodigo: 'supervisor' },
        { usuarioId: TECNICO.id, rolCodigo: 'tecnico_hse' },
      ]),
    );

    // una segunda SWA en el mismo ticket suma
    const otra = await activar({ ticketId });
    expect(
      (await eventos('qhse.swa.activado', otra.body.id))[0].datos.data['swaActivasEnTicket'],
    ).toBe(2);
  });

  it('la evaluación queda bloqueada hasta notificar a los tres roles; luego el checklist y la reanudación liberan el ticket', async () => {
    const ticketId = await ticketNuevo();
    const id = (await activar({ ticketId })).body.id as string;
    const d0 = await detalle(id);
    expect(d0.cadena.map((c) => c.rolCodigo)).toEqual(['supervisor', 'tecnico_hse', 'gerente_hse']);
    expect(d0.notificacionCompleta).toBe(false);

    // sin notificar a todos no se evalúa (y lo dice el servicio)
    const antes = await post(id, 'evaluar', { riesgoReal: true });
    expect(antes.status).toBe(409);
    expect(antes.body.detail).toMatch(
      /bloqueada hasta notificar.*Supervisor.*Técnico HSE.*Gerente HSE/s,
    );
    expect(
      (await post(id, 'notificaciones', { rolCadenaId: d0.cadena[0].rolCadenaId })).status,
    ).toBe(201);
    expect(
      (await post(id, 'notificaciones', { rolCadenaId: d0.cadena[0].rolCadenaId })).status,
    ).toBe(409);
    expect((await post(id, 'evaluar', { riesgoReal: true })).status).toBe(409);
    for (const c of d0.cadena.slice(1))
      await post(id, 'notificaciones', { rolCadenaId: c.rolCadenaId });
    expect((await detalle(id)).notificacionCompleta).toBe(true);

    // el checklist de reinicio y la reanudación aún no
    expect((await post(id, 'reanudar')).status).toBe(409);
    expect((await post(id, 'reinicio', { criterioId: d0.criterios[0].criterioId })).status).toBe(
      409,
    );

    const evaluada = await post(id, 'evaluar', {
      riesgoReal: false,
      nota: 'Falsa alarma: era vapor de agua',
    });
    expect(evaluada.status).toBe(201);
    expect(evaluada.body).toMatchObject({
      estado: 'evaluado',
      riesgoReal: false,
      evaluadoPor: TECNICO.nombre,
    });
    expect((await eventos('qhse.swa.evaluado', id))[0].datos.data).toMatchObject({
      riesgoReal: false,
      swaActivasEnTicket: 1,
    });
    expect((await post(id, 'evaluar', { riesgoReal: true })).status).toBe(409);
    expect(
      (await post(id, 'notificaciones', { rolCadenaId: d0.cadena[0].rolCadenaId })).status,
    ).toBe(409);

    // reanudar exige TODO el checklist
    expect((await post(id, 'reinicio', { criterioId: d0.criterios[0].criterioId })).status).toBe(
      201,
    );
    const incompleto = await post(id, 'reanudar');
    expect(incompleto.status).toBe(409);
    expect(incompleto.body.detail).toMatch(/Falta:/);
    for (const c of d0.criterios.slice(1)) await post(id, 'reinicio', { criterioId: c.criterioId });
    expect((await detalle(id)).reinicioCompleto).toBe(true);
    const cerrada = await post(id, 'reanudar', { heroeSeguridad: true });
    expect(cerrada.status).toBe(201);
    expect(cerrada.body).toMatchObject({
      estado: 'cerrado',
      heroeSeguridad: true,
      reanudadoPor: TECNICO.nombre,
    });
    const cerrado = await eventos('qhse.swa.cerrado', id);
    expect(cerrado).toHaveLength(1);
    expect(cerrado[0].datos.data).toMatchObject({
      ticketId,
      swaActivasEnTicket: 0,
      sinSwaActivas: true,
    });
    expect(cerrada.body.historial.map((h: { estadoNuevo: string }) => h.estadoNuevo)).toEqual([
      'activo',
      'evaluado',
      'cerrado',
    ]);
    expect((await post(id, 'reanudar')).status).toBe(409);
  });

  it('con dos SWA abiertas en el ticket, cerrar una no lo libera', async () => {
    const ticketId = await ticketNuevo();
    const a = (await activar({ ticketId })).body.id as string;
    const b = (await activar({ ticketId })).body.id as string;
    for (const id of [a]) {
      await notificarTodos(id);
      expect((await post(id, 'evaluar', { riesgoReal: true })).status).toBe(201);
      await confirmarTodos(id);
      expect((await post(id, 'reanudar')).status).toBe(201);
    }
    expect((await eventos('qhse.swa.cerrado', a))[0].datos.data).toMatchObject({
      swaActivasEnTicket: 1,
      sinSwaActivas: false,
    });
    expect((await detalle(b)).estado).toBe('activo');
  });

  it('valida la activación: tipo, descripción y ticket conocido; los permisos de gestión no los tiene quien solo reporta', async () => {
    expect((await activar({ tipoPeligroId: uuidv7() })).status).toBe(400);
    expect((await activar({ descripcion: '   ' })).status).toBe(400);
    expect((await activar({ ticketId: uuidv7() })).status).toBe(400);
    const tipos = await t.http().get('/api/qhse/swa/tipos-peligro').set(operador());
    expect(tipos.status).toBe(200);
    expect(tipos.body.map((x: { codigo: string }) => x.codigo)).toEqual(
      expect.arrayContaining(['mecanico', 'electrico', 'quimico']),
    );
    const id = (await activar()).body.id as string;
    expect((await post(id, 'evaluar', { riesgoReal: true }, operador())).status).toBe(403);
    expect((await post(id, 'notificaciones', { rolCadenaId: uuidv7() })).status).toBe(400);
    const lista = await t.http().get('/api/qhse/swa').query({ estado: 'activo' }).set(tecnico());
    expect(lista.body.some((s: { id: string }) => s.id === id)).toBe(true);
  });

  describe('reglas de la base', () => {
    const sql = (texto: string, params: unknown[] = []) => t.admin.query(texto, params);
    const nueva = async () => (await activar()).body.id as string;

    it('no se salta de estado ni se evalúa sin la cadena notificada, aunque se salte el servicio', async () => {
      const id = await nueva();
      await expect(
        sql("UPDATE qhse.swa SET estado = 'cerrado' WHERE id = $1", [id]),
      ).rejects.toThrow(/swa_estado_check|Cambio de estado no permitido/);
      await expect(
        sql(
          "UPDATE qhse.swa SET estado = 'evaluado', riesgo_real = true, evaluado_por = $2, evaluado_at = now() WHERE id = $1",
          [id, TECNICO.id],
        ),
      ).rejects.toThrow(/bloqueada hasta notificar/);
    });

    it('cada estado trae sus datos completos y el héroe de seguridad solo se da al cerrar', async () => {
      const id = await nueva();
      await expect(
        sql('UPDATE qhse.swa SET riesgo_real = true WHERE id = $1', [id]),
      ).rejects.toThrow(/swa_estado_check/);
      await expect(
        sql('UPDATE qhse.swa SET heroe_seguridad = true WHERE id = $1', [id]),
      ).rejects.toThrow(/swa_heroe_check/);
      await expect(
        sql(
          "INSERT INTO qhse.swa (id, tipo_peligro_id, descripcion, activado_por, created_by, estado) VALUES ($1, $2, 'x', $3, $3, 'evaluado')",
          [uuidv7(), tipoId, TECNICO.id],
        ),
      ).rejects.toThrow(/swa_estado_check|nace activa/);
      await expect(
        sql(
          "INSERT INTO qhse.swa (id, tipo_peligro_id, descripcion, activado_por, created_by) VALUES ($1, $2, '  ', $3, $3)",
          [uuidv7(), tipoId, TECNICO.id],
        ),
      ).rejects.toThrow(/swa_descripcion_check/);
      await expect(
        sql(
          "INSERT INTO qhse.swa (id, tipo_peligro_id, descripcion, activado_por, created_by, ticket_id) VALUES ($1, $2, 'x', $3, $3, $4)",
          [uuidv7(), tipoId, TECNICO.id, uuidv7()],
        ),
      ).rejects.toThrow(/swa_ticket_fkey/);
    });

    it('las notificaciones y el reinicio solo caben en su estado y la historia no se edita ni se borra', async () => {
      const id = await nueva();
      const d = await detalle(id);
      await expect(
        t.prisma.swaReinicio.create({
          data: {
            id: uuidv7(),
            swaId: id,
            criterioId: d.criterios[0].criterioId,
            confirmadoPor: TECNICO.id,
          },
        }),
      ).rejects.toThrow(/con la SWA evaluada/);
      const nt = await t.prisma.swaNotificacion.create({
        data: {
          id: uuidv7(),
          swaId: id,
          rolCadenaId: d.cadena[0].rolCadenaId,
          notificadoPor: TECNICO.id,
        },
      });
      await expect(
        t.prisma.swaNotificacion.create({
          data: {
            id: uuidv7(),
            swaId: id,
            rolCadenaId: d.cadena[0].rolCadenaId,
            notificadoPor: TECNICO.id,
          },
        }),
      ).rejects.toThrow(/Unique|unique/);
      await expect(
        t.prisma.swaNotificacion.update({
          where: { id: nt.id },
          data: { notificadoPor: OPERADOR.id },
        }),
      ).rejects.toThrow(/permission denied|denegado/i);
      await expect(t.prisma.swaNotificacion.delete({ where: { id: nt.id } })).rejects.toThrow(
        /permission denied|denegado/i,
      );
      const h = await t.prisma.swaHistorial.findFirstOrThrow({ where: { swaId: id } });
      await expect(
        t.prisma.swaHistorial.update({ where: { id: h.id }, data: { actorId: OPERADOR.id } }),
      ).rejects.toThrow(/permission denied|denegado/i);
      await expect(t.prisma.swaHistorial.delete({ where: { id: h.id } })).rejects.toThrow(
        /permission denied|denegado/i,
      );
    });

    it('lo activado no se reescribe y la aplicación no borra', async () => {
      const id = await nueva();
      await expect(
        t.prisma.swa.update({ where: { id }, data: { descripcion: 'otra cosa' } }),
      ).rejects.toThrow(/permission denied|denegado/i);
      await expect(
        t.prisma.swa.update({ where: { id }, data: { activadoPor: OPERADOR.id } }),
      ).rejects.toThrow(/permission denied|denegado/i);
      await expect(t.prisma.swa.delete({ where: { id } })).rejects.toThrow(
        /permission denied|denegado/i,
      );
    });
  });
});
