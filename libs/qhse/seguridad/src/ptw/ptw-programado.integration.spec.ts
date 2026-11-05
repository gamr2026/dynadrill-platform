/**
 * Integración real de QHSE: apertura diaria del PTW. Pumping avisa los días de servicio de cada ticket (evento) y la tarea programada abre el
 * PTW del día. La tarea se invoca a mano (`abrirDelDia`) con un «hoy» fijo; sin RabbitMQ.
 *   RUN_INTEGRATION=1 npx jest ptw-programado   (dentro de libs/qhse/seguridad)
 */
import { uuidv7 } from '@dyn/utils';
import type { EventEnvelope } from '@dyn/messaging';
import { PumpingEventosConsumer } from '../consumers/pumping-eventos.consumer';
import { levantarAppDePrueba, type AppDePrueba } from '../testing/app-de-prueba';
import { quitarMaestros, sembrarMaestros, type MaestrosDePrueba } from '../testing/maestros';
import { PtwProgramadoService } from './ptw-programado.service';

const run = process.env['RUN_INTEGRATION'] ? describe : describe.skip;
const n = Date.now();

const TECNICO = { id: uuidv7(), nombre: 'Tania Técnica HSE' };
const SUPERVISOR = { id: uuidv7(), nombre: 'Sara Supervisora' };
const MAESTROS: MaestrosDePrueba = {
  usuarios: [
    { ...TECNICO, rol: 'tecnico_hse' },
    { ...SUPERVISOR, rol: 'supervisor' },
  ],
};

// días de prueba lejanos: no chocan con los PTW de otras pruebas
const D1 = '2031-03-10';
const D2 = '2031-03-11';
const D3 = '2031-03-12';

run('QHSE: apertura diaria del PTW (base de datos real)', () => {
  jest.setTimeout(120000);
  let t: AppDePrueba;
  let consumer: PumpingEventosConsumer;
  let programado: PtwProgramadoService;
  const pedidos: string[] = [];
  const tickets: string[] = [];
  const eventos: string[] = [];
  const sql = (texto: string, params: unknown[] = []) => t.admin.query(texto, params);

  const ticketNuevo = async (supervisorId: string | null = SUPERVISOR.id) => {
    const ticketId = uuidv7();
    const pedidoId = uuidv7();
    tickets.push(ticketId);
    pedidos.push(pedidoId);
    await t.prisma.ticketRef.create({
      data: {
        ticketId,
        pedidoId,
        pedidoCodigo: `PED-AUTO${n}`,
        ticketNumero: 970_000 + tickets.length,
        ...(supervisorId ? { supervisorId } : {}),
      },
    });
    return { ticketId, pedidoId };
  };
  const evento = (
    ticketId: string,
    pedidoId: string,
    dias: unknown,
    extra: Record<string, unknown> = {},
  ): EventEnvelope => {
    const id = uuidv7();
    eventos.push(id);
    return {
      id,
      type: 'operaciones.pumping.dias_de_servicio_actualizados',
      version: 1,
      occurredAt: new Date().toISOString(),
      source: 'operaciones',
      subject: { type: 'pumping_ticket', id: ticketId },
      data: { ticketId, pedidoId, pedidoCodigo: `PED-AUTO${n}`, dias, ...extra },
    } as EventEnvelope;
  };
  const diasDe = async (ticketId: string) =>
    (
      await sql(
        'SELECT fecha::text AS f FROM qhse.ticket_dia_servicio WHERE ticket_id = $1 ORDER BY fecha',
        [ticketId],
      )
    ).rows.map((r) => r.f as string);
  const ptwsDe = async (pedidoId: string) =>
    (
      await sql(
        'SELECT dia_operacion::text AS dia, fase, created_by, anulado_at FROM qhse.ptw WHERE pedido_id = $1 ORDER BY dia_operacion',
        [pedidoId],
      )
    ).rows as Array<{ dia: string; fase: string; created_by: string; anulado_at: Date | null }>;

  beforeAll(async () => {
    t = await levantarAppDePrueba('3189');
    await sembrarMaestros(t.admin, MAESTROS);
    consumer = t.app.get(PumpingEventosConsumer);
    programado = t.app.get(PtwProgramadoService);
  });
  afterAll(async () => {
    await sql('DELETE FROM qhse.ptw WHERE pedido_id = ANY($1::uuid[])', [pedidos]);
    await sql('DELETE FROM qhse.ticket_ref WHERE ticket_id = ANY($1::uuid[])', [tickets]);
    await sql("DELETE FROM msg_qhse.outbox WHERE datos->'data'->>'pedidoId' = ANY($1::text[])", [
      pedidos,
    ]);
    if (eventos.length)
      await sql('DELETE FROM msg_qhse.inbox WHERE id = ANY($1::uuid[])', [eventos]);
    await quitarMaestros(t.admin, MAESTROS);
    await t.cerrar();
  });

  it('Pumping avisa los días de servicio del ticket y cada aviso reemplaza al anterior; lo incompleto o de un ticket desconocido se ignora', async () => {
    const { ticketId, pedidoId } = await ticketNuevo();
    await consumer.consumir(evento(ticketId, pedidoId, [D1, D2, D3]));
    expect(await diasDe(ticketId)).toEqual([D1, D2, D3]);
    // el aviso siguiente trae la lista completa: un día sin operación ya no está, las fechas repetidas o mal escritas no cuentan
    await consumer.consumir(evento(ticketId, pedidoId, [D1, D3, D3, 'mañana', 20260101]));
    expect(await diasDe(ticketId)).toEqual([D1, D3]);
    // el mismo aviso dos veces no cambia nada (lo ignora el inbox)
    const repetido = evento(ticketId, pedidoId, [D2]);
    await consumer.consumir(repetido);
    await consumer.consumir(repetido);
    expect(await diasDe(ticketId)).toEqual([D2]);
    // una lista vacía deja al ticket sin días
    await consumer.consumir(evento(ticketId, pedidoId, []));
    expect(await diasDe(ticketId)).toEqual([]);
    // sin lista o de un ticket que QHSE no conoce: se ignora sin error
    await consumer.consumir(evento(ticketId, pedidoId, undefined));
    await expect(consumer.consumir(evento(uuidv7(), uuidv7(), [D1]))).resolves.toBeUndefined();
    expect(await diasDe(ticketId)).toEqual([]);
  });

  it('la tarea abre el PTW del día solo de los tickets con servicio ese día, a nombre del supervisor, y nace en gabinete', async () => {
    const con = await ticketNuevo();
    const sin = await ticketNuevo();
    await consumer.consumir(evento(con.ticketId, con.pedidoId, [D1, D2]));
    await consumer.consumir(evento(sin.ticketId, sin.pedidoId, [D2])); // no tiene servicio el D1
    const r = await programado.abrirDelDia(D1);
    expect(r).toMatchObject({ yaTenian: 0, sinAbrir: 0 });
    expect(r.abiertos).toBeGreaterThanOrEqual(1);
    expect(await ptwsDe(con.pedidoId)).toEqual([
      { dia: D1, fase: 'gabinete', created_by: SUPERVISOR.id, anulado_at: null },
    ]);
    expect(await ptwsDe(sin.pedidoId)).toEqual([]);
    // el PTW abierto sale por el outbox como cualquier otro (Pumping y Avisos lo reciben)
    const abiertos = await sql(
      "SELECT datos->'data'->>'diaOperacion' AS dia FROM msg_qhse.outbox WHERE tipo = 'qhse.ptw.abierto' AND datos->'data'->>'ticketId' = $1",
      [con.ticketId],
    );
    expect(abiertos.rows.map((x) => x.dia)).toEqual([D1]);
    // al día siguiente se abre el del otro día
    await programado.abrirDelDia(D2);
    expect((await ptwsDe(con.pedidoId)).map((p) => p.dia)).toEqual([D1, D2]);
    expect((await ptwsDe(sin.pedidoId)).map((p) => p.dia)).toEqual([D2]);
  });

  it('correr la tarea otra vez no duplica nada, y un día cuyo PTW se anuló no se vuelve a abrir solo', async () => {
    const { ticketId, pedidoId } = await ticketNuevo();
    await consumer.consumir(evento(ticketId, pedidoId, [D3]));
    expect((await programado.abrirDelDia(D3)).abiertos).toBeGreaterThanOrEqual(1);
    const otra = await programado.abrirDelDia(D3);
    expect(otra.abiertos).toBe(0);
    expect(otra.yaTenian).toBeGreaterThanOrEqual(1);
    expect(await ptwsDe(pedidoId)).toHaveLength(1);
    // QHSE lo anula (decisión de una persona): la tarea lo respeta
    await sql(
      "UPDATE qhse.ptw SET anulado_at = now(), anulado_por = $2, motivo_anulacion = 'Prueba de anulación' WHERE pedido_id = $1",
      [pedidoId, TECNICO.id],
    );
    const trasAnular = await programado.abrirDelDia(D3);
    expect(trasAnular.abiertos).toBe(0);
    expect(await ptwsDe(pedidoId)).toHaveLength(1);
  });

  it('se abre a nombre de quien abrió el último PTW del ticket y, si no hay a nombre de quién, queda sin abrir y se avisa en el registro', async () => {
    // el último PTW lo abrió el técnico HSE: a su nombre se abre el siguiente
    const a = await ticketNuevo();
    await t.prisma.ptw.create({
      data: {
        id: uuidv7(),
        ticketId: a.ticketId,
        pedidoId: a.pedidoId,
        diaOperacion: new Date('2031-03-09T00:00:00Z'),
        createdBy: TECNICO.id,
      },
    });
    await consumer.consumir(evento(a.ticketId, a.pedidoId, [D1]));
    await programado.abrirDelDia(D1);
    expect((await ptwsDe(a.pedidoId)).find((p) => p.dia === D1)?.created_by).toBe(TECNICO.id);

    // sin supervisor asignado y sin PTW anteriores: no hay a nombre de quién
    const b = await ticketNuevo(null);
    await consumer.consumir(evento(b.ticketId, b.pedidoId, [D1]));
    const r = await programado.abrirDelDia(D1);
    expect(r.sinAbrir).toBeGreaterThanOrEqual(1);
    expect(await ptwsDe(b.pedidoId)).toEqual([]);
  });
});
