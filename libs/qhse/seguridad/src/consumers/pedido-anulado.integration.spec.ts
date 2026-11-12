/**
 * Integración real de QHSE: un pedido anulado en comercial (`comercial.pedido.anulado`) marca sus tickets como anulados, cierra sus PTW sin aprobar,
 * deja de abrir PTW, avisos y tareas, y rechaza con 409 todo registro nuevo; lo ya creado se conserva. Sin RabbitMQ: el consumidor se invoca a mano.
 *   RUN_INTEGRATION=1 npx jest pedido-anulado   (dentro de libs/qhse/seguridad)
 */
import { Permission } from '@dyn/authz';
import { uuidv7 } from '@dyn/utils';
import type { EventEnvelope } from '@dyn/messaging';
import { AvisosProgramadosService } from '../avisos/avisos-programados.service';
import { TareasHoyQhseService } from '../avisos/tareas-hoy.service';
import { PtwProgramadoService } from '../ptw/ptw-programado.service';
import { levantarAppDePrueba, type AppDePrueba } from '../testing/app-de-prueba';
import { quitarMaestros, sembrarMaestros, type MaestrosDePrueba } from '../testing/maestros';
import { PedidosEventosConsumer } from './pedidos-eventos.consumer';

const run = process.env['RUN_INTEGRATION'] ? describe : describe.skip;
const n = Date.now();
const P = Permission;

const TECNICO = { id: uuidv7(), nombre: 'Tania Técnica HSE' };
const OPERADOR = { id: uuidv7(), nombre: 'Oscar Operador' };
const COMERCIAL = { id: uuidv7(), nombre: 'Carla Comercial' };
const MAESTROS: MaestrosDePrueba = {
  usuarios: [
    { ...TECNICO, rol: 'tecnico_hse' },
    { ...OPERADOR, rol: 'operador' },
    { ...COMERCIAL, rol: 'tecnico_hse' },
  ],
};

// día de prueba lejano: no choca con los PTW de otras pruebas
const HOY = '2033-06-01';
const MANANA = '2033-06-02';

run('QHSE: pedido anulado en comercial (base de datos real)', () => {
  jest.setTimeout(120000);
  let t: AppDePrueba;
  let consumer: PedidosEventosConsumer;
  let programado: PtwProgramadoService;
  let avisos: AvisosProgramadosService;
  let tareas: TareasHoyQhseService;
  const pedidos: string[] = [];
  const tickets: string[] = [];
  const eventosUsados: string[] = [];
  const archivos: string[] = [];
  const sql = (texto: string, params: unknown[] = []) => t.admin.query(texto, params);

  const tecnico = () =>
    t.token(
      'tecnico_hse',
      TECNICO.nombre,
      [
        P.DOCUMENTOS_VER,
        P.DOCUMENTOS_GESTIONAR,
        P.PTW_VER,
        P.PTW_GESTIONAR,
        P.QHSE_REPORTAR,
        P.EPI_CREAR,
      ],
      TECNICO.id,
    );

  const ticketNuevo = async () => {
    const ticketId = uuidv7();
    const pedidoId = uuidv7();
    tickets.push(ticketId);
    pedidos.push(pedidoId);
    await t.prisma.ticketRef.create({
      data: {
        ticketId,
        pedidoId,
        pedidoCodigo: `PED-ANU${n}`,
        ticketNumero: 960_000 + tickets.length,
        supervisorId: TECNICO.id,
      },
    });
    return { ticketId, pedidoId };
  };
  /** Un segundo ticket del mismo pedido (un pedido puede tener varios). */
  const otroTicket = async (pedidoId: string) => {
    const ticketId = uuidv7();
    tickets.push(ticketId);
    await t.prisma.ticketRef.create({
      data: {
        ticketId,
        pedidoId,
        pedidoCodigo: `PED-ANU${n}`,
        ticketNumero: 960_000 + tickets.length,
      },
    });
    return ticketId;
  };
  const anulado = (pedidoId: string, extra: Record<string, unknown> = {}): EventEnvelope => {
    const id = uuidv7();
    eventosUsados.push(id);
    return {
      id,
      type: 'comercial.pedido.anulado',
      version: 1,
      occurredAt: new Date().toISOString(),
      source: 'comercial',
      actor: { userId: COMERCIAL.id, role: 'comercial' },
      subject: { type: 'pedido', id: pedidoId },
      data: { pedidoId, codigo: `PED-ANU${n}`, motivo: 'Cliente desistió', ...extra },
    } as EventEnvelope;
  };
  const marca = async (ticketId: string) =>
    (
      await sql('SELECT anulado_at, anulado_motivo FROM qhse.ticket_ref WHERE ticket_id = $1', [
        ticketId,
      ])
    ).rows[0] as { anulado_at: Date | null; anulado_motivo: string | null };
  const abrirPtw = (ticketId: string, dia: string) =>
    t.http().post('/api/qhse/ptw').set(tecnico()).send({ ticketId, diaOperacion: dia });
  const diasServicio = (ticketId: string, ...dias: string[]) =>
    sql('INSERT INTO qhse.ticket_dia_servicio (ticket_id, fecha) SELECT $1, unnest($2::date[])', [
      ticketId,
      dias,
    ]);

  beforeAll(async () => {
    t = await levantarAppDePrueba('3199');
    await sembrarMaestros(t.admin, MAESTROS);
    consumer = t.app.get(PedidosEventosConsumer);
    programado = t.app.get(PtwProgramadoService);
    avisos = t.app.get(AvisosProgramadosService);
    tareas = t.app.get(TareasHoyQhseService);
  });
  afterAll(async () => {
    await sql('DELETE FROM qhse.swa WHERE ticket_id = ANY($1::uuid[])', [tickets]);
    await sql('DELETE FROM qhse.epi_entrega WHERE ticket_id = ANY($1::uuid[])', [tickets]);
    await sql('DELETE FROM qhse.ptw WHERE pedido_id = ANY($1::uuid[])', [pedidos]);
    await sql('DELETE FROM qhse.documento_pedido WHERE pedido_id = ANY($1::uuid[])', [pedidos]);
    await sql('DELETE FROM qhse.ticket_ref WHERE ticket_id = ANY($1::uuid[])', [tickets]);
    await sql("DELETE FROM msg_qhse.outbox WHERE datos->'data'->>'pedidoId' = ANY($1::text[])", [
      pedidos,
    ]);
    if (eventosUsados.length)
      await sql('DELETE FROM msg_qhse.inbox WHERE id = ANY($1::uuid[])', [eventosUsados]);
    await sql('DELETE FROM archivos.archivo WHERE id = ANY($1::uuid[])', [archivos]);
    await quitarMaestros(t.admin, MAESTROS);
    await t.cerrar();
  });

  it('marca como anulados todos los tickets del pedido con su motivo; repetir el evento o recibir otro no cambia nada y uno incompleto se ignora', async () => {
    const a = await ticketNuevo();
    const b = await otroTicket(a.pedidoId);
    const ajeno = await ticketNuevo(); // otro pedido: no se toca

    const ev = anulado(a.pedidoId);
    await consumer.consumir(ev);
    for (const id of [a.ticketId, b]) {
      const m = await marca(id);
      expect(m.anulado_at).toBeTruthy();
      expect(m.anulado_motivo).toBe('Cliente desistió');
    }
    expect((await marca(ajeno.ticketId)).anulado_at).toBeNull();

    // el mismo evento otra vez (lo ignora el inbox) y uno nuevo con otro motivo: se conserva la primera anulación
    const primera = (await marca(a.ticketId)).anulado_at;
    await consumer.consumir(ev);
    await consumer.consumir(anulado(a.pedidoId, { motivo: 'Otro motivo' }));
    expect(await marca(a.ticketId)).toEqual({
      anulado_at: primera,
      anulado_motivo: 'Cliente desistió',
    });

    // sin pedido, de un pedido que QHSE no conoce, o sin motivo: no falla
    await expect(
      consumer.consumir(anulado(a.pedidoId, { pedidoId: undefined })),
    ).resolves.toBeUndefined();
    await expect(consumer.consumir(anulado(uuidv7()))).resolves.toBeUndefined();
    const sinMotivo = await ticketNuevo();
    await consumer.consumir(anulado(sinMotivo.pedidoId, { motivo: undefined }));
    expect(await marca(sinMotivo.ticketId)).toMatchObject({ anulado_motivo: null });
    expect((await marca(sinMotivo.ticketId)).anulado_at).toBeTruthy();
    // un ticket anulado no se reabre (ni siquiera con SQL directo de la aplicación)
    await expect(
      t.prisma.ticketRef.update({ where: { ticketId: a.ticketId }, data: { anuladoAt: null } }),
    ).rejects.toThrow(/no se puede reabrir/i);
  });

  it('cierra por el camino normal los PTW abiertos del pedido (con su historial y su evento) y deja los documentos tal cual', async () => {
    const tk = await ticketNuevo();
    const abierto = (await abrirPtw(tk.ticketId, HOY).expect(201)).body;
    // un documento ya cargado antes de la anulación
    const modulo = (
      await sql("SELECT id FROM archivos.modulo_archivo WHERE codigo = 'qhse_documento_pedido'")
    ).rows[0].id as string;
    const archivoId = uuidv7();
    archivos.push(archivoId);
    await sql(
      `INSERT INTO archivos.archivo (id, modulo_id, nombre_original, mime_type, tamano_bytes, sha256, blob_key, escaneo, subido_por)
       VALUES ($1, $2, 'doc.pdf', 'application/pdf', 10, $3, $4, 'omitido', $5)`,
      [
        archivoId,
        modulo,
        archivoId.replace(/-/g, '').padEnd(64, '0'),
        `qhse-test/${n}/${archivoId}`,
        TECNICO.id,
      ],
    );
    const doc = (
      await t
        .http()
        .post('/api/qhse/documentos')
        .set(tecnico())
        .send({ pedidoId: tk.pedidoId, ticketId: tk.ticketId, tipo: 'sfi', archivoId })
        .expect(201)
    ).body;

    await consumer.consumir(anulado(tk.pedidoId));

    const ptw = (
      await sql(
        'SELECT fase, anulado_at, anulado_por, motivo_anulacion FROM qhse.ptw WHERE id = $1',
        [abierto.id],
      )
    ).rows[0];
    expect(ptw).toMatchObject({
      fase: 'gabinete',
      anulado_por: COMERCIAL.id,
      motivo_anulacion: 'Pedido anulado: Cliente desistió',
    });
    expect(ptw.anulado_at).toBeTruthy();
    const historia = await sql(
      "SELECT accion, motivo FROM qhse.ptw_historial WHERE ptw_id = $1 AND accion = 'anulado'",
      [abierto.id],
    );
    expect(historia.rows).toEqual([
      { accion: 'anulado', motivo: 'Pedido anulado: Cliente desistió' },
    ]);
    const eventos = await sql(
      "SELECT datos FROM msg_qhse.outbox WHERE tipo = 'qhse.ptw.anulado' AND datos->'data'->>'ticketId' = $1",
      [tk.ticketId],
    );
    expect(eventos.rows).toHaveLength(1);

    // lo ya creado se conserva: el documento sigue vigente y sin tocar
    expect(
      await t.prisma.documentoPedido.findUniqueOrThrow({ where: { id: doc.id } }),
    ).toMatchObject({
      anuladoAt: null,
      revisionEstado: 'cargado',
    });
  });

  it('rechaza con 409 los documentos, PTW, SWA, entregas de EPI e inspecciones nuevos del ticket anulado', async () => {
    const tk = await ticketNuevo();
    const vivo = await ticketNuevo();
    await consumer.consumir(anulado(tk.pedidoId));

    // PTW: a mano es un 409 (por evento o por la tarea programada simplemente no se abre)
    const ptw = await abrirPtw(tk.ticketId, HOY);
    expect(ptw.status).toBe(409);
    expect(ptw.body.message).toMatch(/pedido de este ticket fue anulado/i);
    expect((await abrirPtw(vivo.ticketId, HOY)).status).toBe(201);

    // documentos: contra el ticket y contra el pedido (sin ticket)
    const modulo = (
      await sql("SELECT id FROM archivos.modulo_archivo WHERE codigo = 'qhse_documento_pedido'")
    ).rows[0].id as string;
    const archivoId = uuidv7();
    archivos.push(archivoId);
    await sql(
      `INSERT INTO archivos.archivo (id, modulo_id, nombre_original, mime_type, tamano_bytes, sha256, blob_key, escaneo, subido_por)
       VALUES ($1, $2, 'doc.pdf', 'application/pdf', 10, $3, $4, 'omitido', $5)`,
      [
        archivoId,
        modulo,
        archivoId.replace(/-/g, '').padEnd(64, '0'),
        `qhse-test/${n}/${archivoId}`,
        TECNICO.id,
      ],
    );
    const post = (cuerpo: Record<string, unknown>) =>
      t
        .http()
        .post('/api/qhse/documentos')
        .set(tecnico())
        .send({ archivoId, tipo: 'sfi', ...cuerpo });
    expect((await post({ pedidoId: tk.pedidoId, ticketId: tk.ticketId })).status).toBe(409);
    expect((await post({ pedidoId: tk.pedidoId })).status).toBe(409);
    expect((await post({ pedidoId: vivo.pedidoId })).status).toBe(201);

    // SWA
    const tipoPeligroId = (
      await sql("SELECT id FROM qhse.swa_tipo_peligro WHERE codigo = 'quimico'")
    ).rows[0].id as string;
    const swa = await t
      .http()
      .post('/api/qhse/swa')
      .set(tecnico())
      .send({ tipoPeligroId, descripcion: 'Fuga', ticketId: tk.ticketId });
    expect(swa.status).toBe(409);

    // entrega de EPI
    const epi = await t
      .http()
      .post('/api/qhse/epi')
      .set(tecnico())
      .send({ trabajadorId: OPERADOR.id, ticketId: tk.ticketId });
    expect(epi.status).toBe(409);

    // inspección
    const tipo = (await sql("SELECT id FROM qhse.inspeccion_tipo WHERE codigo = 'eslinga_cable'"))
      .rows[0].id as string;
    const criterios = (
      await sql('SELECT id FROM qhse.inspeccion_criterio WHERE tipo_id = $1 AND activo', [tipo])
    ).rows as Array<{ id: string }>;
    const inspeccion = await t
      .http()
      .post('/api/qhse/inspecciones')
      .set(tecnico())
      .send({
        tipoId: tipo,
        equipoCodigo: `EQ-ANU-${n}`,
        ticketId: tk.ticketId,
        resultados: criterios.map((c) => ({ criterioId: c.id, cumple: true })),
      });
    expect(inspeccion.status).toBe(409);
  });

  it('la tarea programada, los avisos y las tareas de hoy se saltan el ticket anulado', async () => {
    const vivo = await ticketNuevo();
    const anul = await ticketNuevo();
    await diasServicio(vivo.ticketId, HOY, MANANA);
    await diasServicio(anul.ticketId, HOY, MANANA);

    const delTicket = (lista: Array<{ entidadId: string | number }>, id: string) =>
      lista.filter((c) => String(c.entidadId) === id);
    expect(delTicket(await avisos.servicioSinPtw(HOY), anul.ticketId)).toHaveLength(1);
    expect(delTicket(await avisos.faltaPtManana(HOY, '23:59'), anul.ticketId)).toHaveLength(1);

    // un PTW sin aprobar del ticket (abierto antes de la anulación) genera aviso; el consumidor lo anula, así que se simula solo la marca
    await abrirPtw(anul.ticketId, MANANA).expect(201);
    expect(
      (await avisos.ptwSinAprobarALaHora(MANANA, '23:59')).filter(
        (c) => c.datos['ticketId'] === anul.ticketId,
      ),
    ).toHaveLength(1);
    await sql(
      "UPDATE qhse.ticket_ref SET anulado_at = now(), anulado_motivo = 'Prueba' WHERE ticket_id = $1",
      [anul.ticketId],
    );

    expect(delTicket(await avisos.servicioSinPtw(HOY), anul.ticketId)).toHaveLength(0);
    expect(delTicket(await avisos.servicioSinPtw(HOY), vivo.ticketId)).toHaveLength(1);
    expect(delTicket(await avisos.faltaPtManana(HOY, '23:59'), anul.ticketId)).toHaveLength(0);
    expect(delTicket(await avisos.faltaPtManana(HOY, '23:59'), vivo.ticketId)).toHaveLength(1);
    expect(
      (await avisos.ptwSinAprobarALaHora(MANANA, '23:59')).filter(
        (c) => c.datos['ticketId'] === anul.ticketId,
      ),
    ).toHaveLength(0);

    // tareas de hoy: la del ticket vivo está, la del anulado no
    const hoy = await tareas.delDia(HOY);
    const ids = hoy.bloques.flatMap((b) => b.tareas.map((x) => x.ticketId));
    expect(ids).toContain(vivo.ticketId);
    expect(ids).not.toContain(anul.ticketId);

    // la tarea programada abre el PTW del ticket vivo y no el del anulado
    await programado.abrirDelDia(HOY);
    const ptws = async (pedidoId: string) =>
      (
        await sql('SELECT 1 FROM qhse.ptw WHERE pedido_id = $1 AND dia_operacion = $2', [
          pedidoId,
          HOY,
        ])
      ).rowCount;
    expect(await ptws(vivo.pedidoId)).toBe(1);
    expect(await ptws(anul.pedidoId)).toBe(0);
  });
});
