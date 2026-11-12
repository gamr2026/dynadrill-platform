/**
 * Integración real de QHSE: documentos por pedido y Acta de Entrega de Locación (contrato 4.11), con las reglas de la base.
 *   RUN_INTEGRATION=1 npx jest documentos   (dentro de libs/qhse/seguridad)
 */
import { Permission } from '@dyn/authz';
import { uuidv7 } from '@dyn/utils';
import { PumpingEventosConsumer } from '../consumers/pumping-eventos.consumer';
import { VerificadorFirmasHttp, type LecturaFirma } from './verificador-firmas';
import { levantarAppDePrueba, type AppDePrueba } from '../testing/app-de-prueba';
import { quitarMaestros, sembrarMaestros, type MaestrosDePrueba } from '../testing/maestros';

const run = process.env['RUN_INTEGRATION'] ? describe : describe.skip;
const n = Date.now();
const P = Permission;

const TECNICO = { id: uuidv7(), nombre: 'Tania Técnica HSE' };
const SUPERVISOR = { id: uuidv7(), nombre: 'Sara Supervisora' };
const SUPLENTE = { id: uuidv7(), nombre: 'Silvia Suplente' };
const OPERADOR = { id: uuidv7(), nombre: 'Oscar Operador' };
const MAESTROS: MaestrosDePrueba = {
  usuarios: [
    { ...TECNICO, rol: 'tecnico_hse' },
    { ...SUPERVISOR, rol: 'supervisor' },
    { ...SUPLENTE, rol: 'supervisor' },
    { ...OPERADOR, rol: 'operador' },
  ],
};

type Salida = {
  datos: { source: string; actor?: { userId: string }; data: Record<string, unknown> };
};

run('QHSE: documentos por pedido y Acta de Entrega (base de datos real)', () => {
  jest.setTimeout(90000);
  let t: AppDePrueba;
  const pedidos: string[] = [];
  const tickets: string[] = [];
  const archivos: string[] = [];
  const eventosUsados: string[] = [];
  const modulo: Record<string, string> = {};
  /** Lectura de firmas simulada (D6): lo que responda `ocr.respuesta` (null = el servicio no respondió). */
  const ocr: { respuesta: LecturaFirma | null; llamadas: string[] } = {
    respuesta: null,
    llamadas: [],
  };
  const esperarLectura = async (id: string) => {
    for (let i = 0; i < 50; i++) {
      const d = await t.prisma.documentoPedido.findUniqueOrThrow({ where: { id } });
      if (d.verificacionAt) return d;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('la lectura de la firma no terminó');
  };

  const tecnico = () =>
    t.token(
      'tecnico_hse',
      TECNICO.nombre,
      [
        P.DOCUMENTOS_VER,
        P.DOCUMENTOS_GESTIONAR,
        P.DOCUMENTOS_REVISAR,
        P.ACTA_ENTREGA_VER,
        P.ACTA_ENTREGA_CARGAR,
      ],
      TECNICO.id,
    );
  /** El Supervisor solo trae los dos permisos del Acta. */
  const supervisor = () =>
    t.token(
      'supervisor',
      SUPERVISOR.nombre,
      [P.ACTA_ENTREGA_VER, P.ACTA_ENTREGA_CARGAR],
      SUPERVISOR.id,
    );
  const suplente = () =>
    t.token(
      'supervisor',
      SUPLENTE.nombre,
      [P.ACTA_ENTREGA_VER, P.ACTA_ENTREGA_CARGAR],
      SUPLENTE.id,
    );
  const operador = () => t.token('operador', OPERADOR.nombre, [P.PUMPING_OPERAR], OPERADOR.id);

  /** Un pedido con un ticket que QHSE ya conoce (llega por evento de Pumping). */
  const ticketNuevo = async (supervisorId?: string) => {
    const ticketId = uuidv7();
    const pedidoId = uuidv7();
    tickets.push(ticketId);
    pedidos.push(pedidoId);
    await t.prisma.ticketRef.create({
      data: {
        ticketId,
        pedidoId,
        pedidoCodigo: `PED-DOC${n}`,
        ticketNumero: 900_000 + pedidos.length,
        ...(supervisorId ? { supervisorId } : {}),
      },
    });
    return { ticketId, pedidoId };
  };
  /** Un archivo ya subido por el módulo de archivos (`archivos.archivo`), como lo deja `POST /api/archivos`. */
  const archivo = async (codigoModulo: string, subidoPor = TECNICO.id) => {
    const id = uuidv7();
    archivos.push(id);
    await t.admin.query(
      `INSERT INTO archivos.archivo (id, modulo_id, nombre_original, mime_type, tamano_bytes, sha256, blob_key, escaneo, subido_por)
       VALUES ($1, $2, 'doc.pdf', 'application/pdf', 10, $3, $4, 'omitido', $5)`,
      [
        id,
        modulo[codigoModulo],
        id.replace(/-/g, '').padEnd(64, '0'),
        `qhse-test/${n}/${id}`,
        subidoPor,
      ],
    );
    return id;
  };
  const eventos = async (tipo: string, ticketId: string) =>
    (
      await t.admin.query(
        "SELECT datos FROM msg_qhse.outbox WHERE tipo = $1 AND datos->'data'->>'ticketId' = $2 ORDER BY ocurrido_at, id",
        [tipo, ticketId],
      )
    ).rows as Salida[];
  const fechaEn = (dias: number) =>
    new Date(Date.now() + dias * 86_400_000).toISOString().slice(0, 10);
  const acta = (ticketId: string, cuerpo: Record<string, unknown>, quien = supervisor()) =>
    t.http().post(`/api/qhse/tickets/${ticketId}/acta-entrega`).set(quien).send(cuerpo);
  const anular = (id: string, motivo: string, quien = tecnico()) =>
    t.http().post(`/api/qhse/documentos/${id}/anular`).set(quien).send({ motivo });

  beforeAll(async () => {
    t = await levantarAppDePrueba('3195');
    jest
      .spyOn(VerificadorFirmasHttp.prototype, 'verificar')
      .mockImplementation(async (archivoId) => {
        ocr.llamadas.push(archivoId);
        return ocr.respuesta;
      });
    await sembrarMaestros(t.admin, MAESTROS);
    const r = await t.admin.query(
      "SELECT id, codigo FROM archivos.modulo_archivo WHERE codigo IN ('qhse_acta_entrega','qhse_documento_pedido')",
    );
    for (const f of r.rows as Array<{ id: string; codigo: string }>) modulo[f.codigo] = f.id;
    // si falla aquí, falta correr `npm run db:seed:archivos`
    expect(Object.keys(modulo)).toHaveLength(2);
  });

  afterAll(async () => {
    await t.admin.query('DELETE FROM qhse.documento_pedido WHERE pedido_id = ANY($1::uuid[])', [
      pedidos,
    ]);
    await t.admin.query('DELETE FROM qhse.ticket_ref WHERE ticket_id = ANY($1::uuid[])', [tickets]);
    await t.admin.query(
      "DELETE FROM msg_qhse.outbox WHERE datos->'data'->>'pedidoId' = ANY($1::text[])",
      [pedidos],
    );
    await t.admin.query('DELETE FROM msg_qhse.inbox WHERE id = ANY($1::uuid[])', [eventosUsados]);
    await t.admin.query('DELETE FROM archivos.archivo WHERE id = ANY($1::uuid[])', [archivos]);
    await quitarMaestros(t.admin, MAESTROS);
    await t.cerrar();
  });

  // --------------------------------------------------------------------------------------------- D6: lectura de la firma

  it('D6: al cargar un documento firmado se lee la firma y se guarda solo el indicador; con el servicio caído no se interrumpe la carga y se puede repetir', async () => {
    const { pedidoId, ticketId } = await ticketNuevo(SUPERVISOR.id);
    // documento general (SFI): firma detectada
    ocr.respuesta = { resultado: 'firma_detectada', confianza: 0.92 };
    const a1 = await archivo('qhse_documento_pedido');
    const r = await t
      .http()
      .post('/api/qhse/documentos')
      .set(tecnico())
      .send({ pedidoId, tipo: 'sfi', archivoId: a1 })
      .expect(201);
    const d1 = await esperarLectura(r.body.id);
    expect(d1.verificacion).toBe('firma_detectada');
    expect(Number(d1.verificacionConfianza)).toBe(0.92);
    expect(ocr.llamadas).toContain(a1);
    // la lista lo trae
    const lista = (
      await t.http().get(`/api/qhse/documentos?pedidoId=${pedidoId}`).set(tecnico()).expect(200)
    ).body;
    expect(lista.find((x: { id: string }) => x.id === r.body.id)).toMatchObject({
      verificacion: 'firma_detectada',
    });
    // el Acta: firma no detectada (el supervisor del ticket la sube)
    ocr.respuesta = { resultado: 'no_detectada', confianza: 0.1 };
    const a2 = await archivo('qhse_acta_entrega', SUPERVISOR.id);
    const acta2 = await acta(ticketId, { archivoId: a2 }).expect(201);
    expect((await esperarLectura(acta2.body.id)).verificacion).toBe('firma_no_detectada');
    // servicio no disponible: el documento se carga igual, queda «sin verificar» y se puede volver a leer
    ocr.respuesta = null;
    const a3 = await archivo('qhse_documento_pedido');
    const r3 = await t
      .http()
      .post('/api/qhse/documentos')
      .set(tecnico())
      .send({ pedidoId, tipo: 'formato_recepcion', archivoId: a3 })
      .expect(201);
    const d3 = await esperarLectura(r3.body.id);
    expect(d3.verificacion).toBe('no_verificada');
    ocr.respuesta = { resultado: 'firma_detectada', confianza: 0.8 };
    const otra = await t
      .http()
      .post(`/api/qhse/documentos/${r3.body.id}/verificar`)
      .set(tecnico())
      .expect(201);
    expect(otra.body).toMatchObject({ verificacion: 'firma_detectada' });
    await t.http().post(`/api/qhse/documentos/${r3.body.id}/verificar`).set(operador()).expect(403);
  });

  // --------------------------------------------------------------------------------------------- Acta de Entrega

  it('el Supervisor sube el Acta del ticket y se publica qhse.acta_entrega.cargada con ticketId y pedidoId', async () => {
    const { ticketId, pedidoId } = await ticketNuevo();
    const a = await archivo('qhse_acta_entrega', SUPERVISOR.id);
    const r = await acta(ticketId, { archivoId: a, referencia: 'ACT-001' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      tipo: 'formato_entrega',
      ticketId,
      pedidoId,
      archivoId: a,
      anulado: false,
      cargadoPor: SUPERVISOR.nombre,
    });

    const ev = await eventos('qhse.acta_entrega.cargada', ticketId);
    expect(ev).toHaveLength(1);
    expect(ev[0].datos.source).toBe('qhse');
    expect(ev[0].datos.actor?.userId).toBe(SUPERVISOR.id);
    expect(ev[0].datos.data).toMatchObject({
      ticketId,
      pedidoId,
      archivoId: a,
      documentoId: r.body.id,
    });
    const lista = await t
      .http()
      .get(`/api/qhse/tickets/${ticketId}/acta-entrega`)
      .set(supervisor());
    expect(lista.status).toBe(200);
    expect(lista.body.documentos).toHaveLength(1);
  });

  it('un pedido solo tiene una Acta vigente; anularla (con motivo) publica .anulada y permite cargar otra', async () => {
    const { ticketId } = await ticketNuevo();
    const a1 = await archivo('qhse_acta_entrega');
    const primera = await acta(ticketId, { archivoId: a1 });
    expect(primera.status).toBe(201);

    const a2 = await archivo('qhse_acta_entrega');
    expect((await acta(ticketId, { archivoId: a2 })).status).toBe(409);

    // el Supervisor no anula; el Técnico HSE sí, y con motivo
    expect((await anular(primera.body.id, 'x', supervisor())).status).toBe(403);
    expect((await anular(primera.body.id, '  ')).status).toBe(400);
    const anulada = await anular(primera.body.id, 'Acta equivocada');
    expect(anulada.status).toBe(201);
    expect(anulada.body).toMatchObject({
      anulado: true,
      motivoAnulacion: 'Acta equivocada',
      anuladoPor: TECNICO.nombre,
    });
    const ev = await eventos('qhse.acta_entrega.anulada', ticketId);
    expect(ev).toHaveLength(1);
    expect(ev[0].datos.data).toMatchObject({ ticketId, motivo: 'Acta equivocada' });
    expect((await anular(primera.body.id, 'otra vez')).status).toBe(409);

    expect((await acta(ticketId, { archivoId: a2 })).status).toBe(201);
    const historial = await t
      .http()
      .get(`/api/qhse/tickets/${ticketId}/acta-entrega`)
      .set(tecnico());
    expect(historial.body.documentos.map((d: { anulado: boolean }) => d.anulado).sort()).toEqual([
      false,
      true,
    ]);
  });

  it('otro supervisor puede subir el Acta solo si dice por qué el asignado no pudo (lo exige también la base)', async () => {
    const { ticketId, pedidoId } = await ticketNuevo(SUPERVISOR.id);
    // el asignado la sube sin más
    const propia = await acta(ticketId, { archivoId: await archivo('qhse_acta_entrega') });
    expect(propia.status).toBe(201);
    expect(propia.body.motivoSuplencia).toBeNull();
    expect((await anular(propia.body.id, 'la sube otra persona')).status).toBe(201);

    // otro supervisor: sin motivo, no
    const sin = await acta(ticketId, { archivoId: await archivo('qhse_acta_entrega') }, suplente());
    expect(sin.status).toBe(400);
    expect(sin.body.detail).toMatch(/por qué el supervisor asignado no pudo/);
    const con = await acta(
      ticketId,
      {
        archivoId: await archivo('qhse_acta_entrega'),
        motivoSuplencia: 'Sara está en traslado de unidad',
      },
      suplente(),
    );
    expect(con.status).toBe(201);
    expect(con.body).toMatchObject({
      motivoSuplencia: 'Sara está en traslado de unidad',
      cargadoPor: SUPLENTE.nombre,
    });
    // la pantalla sabe quién es el asignado para pedir el motivo de antemano
    const ctx = await t.http().get(`/api/qhse/tickets/${ticketId}/acta-entrega`).set(suplente());
    expect(ctx.body.supervisorAsignado).toEqual({ id: SUPERVISOR.id, nombre: SUPERVISOR.nombre });

    // aunque se salte el servicio, la base lo rechaza
    await t.admin.query(
      'UPDATE qhse.documento_pedido SET anulado_at = now(), anulado_por = $2, motivo_anulacion = $3 WHERE id = $1',
      [con.body.id, TECNICO.id, 'prueba'],
    );
    await expect(
      t.prisma.$executeRawUnsafe(
        `INSERT INTO qhse.documento_pedido (id, pedido_id, ticket_id, tipo, archivo_id, created_by)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'formato_entrega', $4::uuid, $5::uuid)`,
        uuidv7(),
        pedidoId,
        ticketId,
        await archivo('qhse_acta_entrega'),
        SUPLENTE.id,
      ),
    ).rejects.toThrow(/si la sube otra persona debe indicar por qué/);
    // el motivo de suplencia solo existe en el Acta
    await expect(
      t.prisma.$executeRawUnsafe(
        `INSERT INTO qhse.documento_pedido (id, pedido_id, tipo, archivo_id, created_by, motivo_suplencia)
         VALUES ($1::uuid, $2::uuid, 'sfi', $3::uuid, $4::uuid, 'x')`,
        uuidv7(),
        pedidoId,
        await archivo('qhse_documento_pedido'),
        TECNICO.id,
      ),
    ).rejects.toThrow(/suplencia_check/);
  });

  it('el consumidor de Pumping guarda el supervisor asignado y el cliente, campo y pozo sin borrarlos después', async () => {
    const consumidor = t.app.get(PumpingEventosConsumer);
    const ticketId = uuidv7();
    const pedidoId = uuidv7();
    tickets.push(ticketId);
    pedidos.push(pedidoId);
    const evento = (tipo: string, extra: Record<string, unknown>) => {
      const id = uuidv7();
      eventosUsados.push(id);
      return {
        id,
        type: tipo,
        version: 1,
        occurredAt: new Date().toISOString(),
        source: 'operaciones',
        subject: { type: 'pumping_ticket', id: ticketId },
        data: { ticketId, pedidoId, ticketNumero: 955_001, pedidoCodigo: `PED-DOC${n}`, ...extra },
      } as never;
    };
    await consumidor.consumir(
      evento('operaciones.pumping.asignacion_realizada', {
        cliente: 'Cliente X',
        campo: 'Campo Y',
        pozo: 'Pozo Z',
        operadoresUnidades: [],
        asignados: [
          { usuarioId: SUPERVISOR.id, rolCodigo: 'supervisor' },
          { usuarioId: OPERADOR.id, rolCodigo: 'operador' },
        ],
      }),
    );
    expect(await t.prisma.ticketRef.findUniqueOrThrow({ where: { ticketId } })).toMatchObject({
      supervisorId: SUPERVISOR.id,
      cliente: 'Cliente X',
      campo: 'Campo Y',
      pozo: 'Pozo Z',
    });
    // un evento posterior sin esos datos no los borra
    await consumidor.consumir(evento('operaciones.pumping.ticket_creado', {}));
    expect(await t.prisma.ticketRef.findUniqueOrThrow({ where: { ticketId } })).toMatchObject({
      supervisorId: SUPERVISOR.id,
      cliente: 'Cliente X',
    });
    // los tickets de FCR llegan con sus propios eventos y quedan igual de conocidos para QHSE (documentos, Acta, PTW)
    const fcrId = uuidv7();
    await consumidor.consumir({
      id: uuidv7(),
      type: 'operaciones.fcr.ticket_creado',
      version: 1,
      occurredAt: new Date().toISOString(),
      source: 'operaciones',
      subject: { type: 'fcr_ticket', id: fcrId },
      data: {
        ticketId: fcrId,
        pedidoId: uuidv7(),
        ticketNumero: 955_002,
        pedidoCodigo: `PED-DOCF${n}`,
        cliente: 'Cliente F',
      },
    } as never);
    expect(
      await t.prisma.ticketRef.findUniqueOrThrow({ where: { ticketId: fcrId } }),
    ).toMatchObject({
      pedidoCodigo: `PED-DOCF${n}`,
      cliente: 'Cliente F',
    });
    // la bandeja muestra el cliente, campo y pozo
    const r = await t
      .http()
      .get('/api/qhse/documentos/pedidos')
      .query({ q: `PED-DOC${n}` })
      .set(tecnico());
    expect(r.body.find((p: { pedidoId: string }) => p.pedidoId === pedidoId)).toMatchObject({
      cliente: 'Cliente X',
      campo: 'Campo Y',
      pozo: 'Pozo Z',
    });
  });

  it('rechaza un ticket desconocido, un archivo ajeno o inexistente y a quien no tiene el permiso', async () => {
    const { ticketId } = await ticketNuevo();
    const ok = await archivo('qhse_acta_entrega');
    expect((await acta(uuidv7(), { archivoId: ok })).status).toBe(404);
    // un archivo subido por otro módulo (documento de pedido de QHSE) no vale como Acta
    expect(
      (await acta(ticketId, { archivoId: await archivo('qhse_documento_pedido') })).status,
    ).toBe(400);
    expect((await acta(ticketId, { archivoId: uuidv7() })).status).toBe(400);
    expect((await acta(ticketId, {})).status).toBe(400);
    expect((await acta(ticketId, { archivoId: ok }, operador())).status).toBe(403);
    expect(
      (await t.http().get(`/api/qhse/tickets/${ticketId}/acta-entrega`).set(operador())).status,
    ).toBe(403);
    // el Supervisor no entra al resto de QHSE
    expect(
      (await t.http().get('/api/qhse/documentos').query({ ticketId }).set(supervisor())).status,
    ).toBe(403);
    expect((await t.http().get('/api/qhse/epi').set(supervisor())).status).toBe(403);
    expect(await eventos('qhse.acta_entrega.cargada', ticketId)).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------------------- documentos por pedido

  const cargar = async (pedidoId: string, cuerpo: Record<string, unknown>) =>
    t
      .http()
      .post('/api/qhse/documentos')
      .set(tecnico())
      .send({ pedidoId, archivoId: await archivo('qhse_documento_pedido'), ...cuerpo });

  it('el ART vale 15 días desde su emisión y se marca vencido pasado ese plazo', async () => {
    const { pedidoId } = await ticketNuevo();
    const vigente = await cargar(pedidoId, {
      tipo: 'art',
      fecha: fechaEn(-3),
      referencia: 'ART-77',
    });
    expect(vigente.status).toBe(201);
    expect(vigente.body).toMatchObject({
      tipo: 'art',
      fecha: fechaEn(-3),
      vigenteHasta: fechaEn(12),
      vencido: false,
      referencia: 'ART-77',
    });
    const viejo = await cargar(pedidoId, { tipo: 'art', fecha: fechaEn(-20) });
    expect(viejo.status).toBe(201);
    expect(viejo.body).toMatchObject({ vigenteHasta: fechaEn(-5), vencido: true });
    // puede haber varios ART por pedido
    const lista = await t
      .http()
      .get('/api/qhse/documentos')
      .query({ pedidoId, tipo: 'art' })
      .set(tecnico());
    expect(lista.body).toHaveLength(2);
    // el ART exige su fecha de emisión y una fecha real
    expect((await cargar(pedidoId, { tipo: 'art' })).status).toBe(400);
    expect((await cargar(pedidoId, { tipo: 'art', fecha: '2026-02-31' })).status).toBe(400);
    expect((await cargar(pedidoId, { tipo: 'art', fecha: 'ayer' })).status).toBe(400);
  });

  it('PT: uno vigente por pedido y día; SFI y formato de recepción; el Acta no entra por aquí', async () => {
    const { pedidoId } = await ticketNuevo();
    const pt = await cargar(pedidoId, { tipo: 'pt', fecha: '2026-11-05' });
    expect(pt.status).toBe(201);
    expect((await cargar(pedidoId, { tipo: 'pt', fecha: '2026-11-05' })).status).toBe(409);
    expect((await cargar(pedidoId, { tipo: 'pt', fecha: '2026-11-06' })).status).toBe(201);
    expect((await cargar(pedidoId, { tipo: 'pt' })).status).toBe(400);
    expect((await cargar(pedidoId, { tipo: 'sfi' })).status).toBe(201);
    expect((await cargar(pedidoId, { tipo: 'sfi' })).status).toBe(201);
    expect((await cargar(pedidoId, { tipo: 'formato_recepcion' })).status).toBe(201);
    expect((await cargar(pedidoId, { tipo: 'formato_recepcion' })).status).toBe(409);
    expect((await cargar(pedidoId, { tipo: 'formato_entrega' })).status).toBe(400);
    // anular el PT del día permite cargar otro
    expect((await anular(pt.body.id, 'PT ilegible')).status).toBe(201);
    expect((await cargar(pedidoId, { tipo: 'pt', fecha: '2026-11-05' })).status).toBe(201);
    // por defecto solo los vigentes
    const q = { pedidoId, tipo: 'pt' };
    const vigentes = await t.http().get('/api/qhse/documentos').query(q).set(tecnico());
    expect(vigentes.body).toHaveLength(2);
    const todos = await t
      .http()
      .get('/api/qhse/documentos')
      .query({ ...q, incluirAnulados: 'true' })
      .set(tecnico());
    expect(todos.body).toHaveLength(3);
    // los documentos sueltos publican el evento genérico (con el id del pedido), no el del Acta
    const n1 = await t.admin.query(
      "SELECT count(*)::int AS n FROM msg_qhse.outbox WHERE tipo = 'qhse.documento_pedido.cargado' AND datos->'data'->>'pedidoId' = $1",
      [pedidoId],
    );
    expect(n1.rows[0].n).toBe(6);
    // el evento lleva la fecha del documento (el día del PT; el día de emisión del ART): Pumping los usa como requisitos de cada jornada
    const ev = await t.admin.query(
      "SELECT datos->'data' AS d FROM msg_qhse.outbox WHERE tipo = 'qhse.documento_pedido.cargado' AND datos->'data'->>'pedidoId' = $1 AND datos->'data'->>'tipoDocumento' = 'pt' ORDER BY id LIMIT 1",
      [pedidoId],
    );
    expect(ev.rows).toHaveLength(1);
    expect(ev.rows[0].d.fecha).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('la bandeja resume por pedido lo que tiene y lo que falta (el ART avisa 3 días antes de vencer)', async () => {
    const { ticketId, pedidoId } = await ticketNuevo();
    expect((await cargar(pedidoId, { tipo: 'art', fecha: fechaEn(-12) })).status).toBe(201);
    expect((await cargar(pedidoId, { tipo: 'sfi' })).status).toBe(201);
    expect((await cargar(pedidoId, { tipo: 'pt', fecha: fechaEn(0) })).status).toBe(201);
    expect((await cargar(pedidoId, { tipo: 'pt', fecha: fechaEn(-1) })).status).toBe(201);
    expect((await acta(ticketId, { archivoId: await archivo('qhse_acta_entrega') })).status).toBe(
      201,
    );

    const r = await t
      .http()
      .get('/api/qhse/documentos/pedidos')
      .query({ q: `PED-DOC${n}` })
      .set(tecnico());
    expect(r.status).toBe(200);
    const fila = r.body.find((p: { pedidoId: string }) => p.pedidoId === pedidoId);
    expect(fila).toMatchObject({
      pedidoCodigo: `PED-DOC${n}`,
      tickets: [{ ticketId }],
      formatoRecepcion: null,
      sfi: { id: expect.any(String) },
      ptHoy: { id: expect.any(String) },
      actaEntrega: { id: expect.any(String) },
      art: { venceEnDias: 3, porVencer: true, vencido: false, vigenteHasta: fechaEn(3) },
    });
    // anular el Acta la vuelve a dejar pendiente en la bandeja
    await anular(fila.actaEntrega.id, 'prueba');
    const de = await t
      .http()
      .get('/api/qhse/documentos/pedidos')
      .query({ q: `PED-DOC${n}` })
      .set(tecnico());
    expect(
      de.body.find((p: { pedidoId: string }) => p.pedidoId === pedidoId).actaEntrega,
    ).toBeNull();
    // el Supervisor no ve la bandeja
    expect((await t.http().get('/api/qhse/documentos/pedidos').set(supervisor())).status).toBe(403);
  });

  it('el equipo de Pumping ve el estado de los documentos del pedido de su ticket, sin la bandeja ni poder cargar', async () => {
    const { ticketId, pedidoId } = await ticketNuevo();
    expect((await cargar(pedidoId, { tipo: 'sfi' })).status).toBe(201);
    const equipo = () =>
      t.token('operador', OPERADOR.nombre, [P.DOCUMENTOS_VER_TICKET], OPERADOR.id);
    const r = await t.http().get(`/api/qhse/documentos/ticket/${ticketId}`).set(equipo());
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      pedidoId,
      sfi: { id: expect.any(String) },
      formatoRecepcion: null,
      art: null,
      ptHoy: null,
      actaEntrega: null,
    });
    // un ticket que QHSE no conoce responde 404; quien no tiene el permiso no entra; el permiso no abre la bandeja
    expect(
      (await t.http().get(`/api/qhse/documentos/ticket/${uuidv7()}`).set(equipo())).status,
    ).toBe(404);
    expect(
      (await t.http().get(`/api/qhse/documentos/ticket/${ticketId}`).set(operador())).status,
    ).toBe(403);
    expect((await t.http().get('/api/qhse/documentos/pedidos').set(equipo())).status).toBe(403);
  });

  it('rechaza un pedido que QHSE no conoce y un ticket de otro pedido', async () => {
    const { ticketId } = await ticketNuevo();
    const otro = await ticketNuevo();
    expect((await cargar(uuidv7(), { tipo: 'sfi' })).status).toBe(400);
    expect((await cargar(otro.pedidoId, { tipo: 'sfi', ticketId })).status).toBe(400);
    expect((await cargar(otro.pedidoId, { tipo: 'sfi', ticketId: otro.ticketId })).status).toBe(
      201,
    );
  });

  // ------------------------------------------------------------------------------------- reglas de la base de datos

  describe('reglas de la base', () => {
    const insertar = async (campos: Record<string, unknown>) => {
      const { pedidoId } = await ticketNuevo();
      const cols = {
        id: uuidv7(),
        pedido_id: pedidoId,
        archivo_id: await archivo('qhse_documento_pedido'),
        created_by: TECNICO.id,
        ...campos,
      };
      const claves = Object.keys(cols);
      return t.prisma.$executeRawUnsafe(
        `INSERT INTO qhse.documento_pedido (${claves.map((c) => `"${c}"`).join(',')}) VALUES (${claves.map((_, i) => `$${i + 1}`).join(',')})`,
        ...Object.values(cols),
      );
    };

    it('CHECK: el ART exige emisión y vigencia de 15 días; el Acta exige ticket; solo el ART lleva vigencia', async () => {
      await expect(insertar({ tipo: 'art' })).rejects.toThrow(/art_check/);
      await expect(
        insertar({ tipo: 'art', fecha: '2026-11-01', vigente_hasta: '2026-11-30' }),
      ).rejects.toThrow(/art_check/);
      await expect(insertar({ tipo: 'formato_entrega' })).rejects.toThrow(/acta_ticket_check/);
      await expect(insertar({ tipo: 'sfi', vigente_hasta: '2026-11-30' })).rejects.toThrow(
        /vigencia_check/,
      );
      await expect(insertar({ tipo: 'pt' })).rejects.toThrow(/pt_check/);
      await expect(insertar({ tipo: 'sfi', referencia: '   ' })).rejects.toThrow(
        /referencia_check/,
      );
    });

    it('FK: archivo inexistente, ticket de otro pedido y creador inexistente', async () => {
      await expect(insertar({ tipo: 'sfi', archivo_id: uuidv7() })).rejects.toThrow(/archivo_fkey/);
      const { ticketId } = await ticketNuevo();
      await expect(insertar({ tipo: 'sfi', ticket_id: ticketId })).rejects.toThrow(/ticket_fkey/);
      await expect(insertar({ tipo: 'sfi', created_by: uuidv7() })).rejects.toThrow(
        /created_by_fkey/,
      );
    });

    it('anular exige quién, cuándo y por qué, todo junto', async () => {
      await expect(insertar({ tipo: 'sfi', anulado_at: new Date() })).rejects.toThrow(
        /anulacion_check/,
      );
      await expect(
        insertar({
          tipo: 'sfi',
          anulado_at: new Date(),
          anulado_por: TECNICO.id,
          motivo_anulacion: ' ',
        }),
      ).rejects.toThrow(/anulacion_check/);
    });

    it('índice único parcial: una Acta vigente por pedido (aunque se intente saltar el servicio)', async () => {
      const { ticketId, pedidoId } = await ticketNuevo();
      const ins = async () =>
        t.prisma.$executeRawUnsafe(
          `INSERT INTO qhse.documento_pedido (id, pedido_id, ticket_id, tipo, archivo_id, created_by)
           VALUES ($1::uuid, $2::uuid, $3::uuid, 'formato_entrega', $4::uuid, $5::uuid)`,
          uuidv7(),
          pedidoId,
          ticketId,
          await archivo('qhse_acta_entrega'),
          TECNICO.id,
        );
      await ins();
      await expect(ins()).rejects.toThrow(/acta_vigente_key/);
    });

    it('la aplicación no puede borrar ni editar lo cargado: solo anular, una vez', async () => {
      const { pedidoId } = await ticketNuevo();
      const id = uuidv7();
      await t.prisma.documentoPedido.create({
        data: {
          id,
          pedidoId,
          tipo: 'sfi',
          archivoId: await archivo('qhse_documento_pedido'),
          createdBy: TECNICO.id,
        },
      });
      await expect(t.prisma.documentoPedido.delete({ where: { id } })).rejects.toThrow(
        /permission denied|denegado/i,
      );
      // cambiar de qué tipo es o a qué archivo apunta: no hay privilegio de UPDATE sobre esas columnas
      await expect(
        t.prisma.documentoPedido.update({ where: { id }, data: { tipo: 'pt' } }),
      ).rejects.toThrow(/permission denied|denegado/i);
      await expect(
        t.prisma.documentoPedido.update({
          where: { id },
          data: { archivoId: await archivo('qhse_documento_pedido') },
        }),
      ).rejects.toThrow(/permission denied|denegado/i);
      await t.prisma.documentoPedido.update({
        where: { id },
        data: {
          anuladoAt: new Date(),
          anuladoPor: TECNICO.id,
          motivoAnulacion: 'prueba',
          updatedBy: TECNICO.id,
        },
      });
      // ya anulado, no se puede tocar de nuevo (ni siquiera para cambiar el motivo)
      await expect(
        t.prisma.documentoPedido.update({ where: { id }, data: { motivoAnulacion: 'otro' } }),
      ).rejects.toThrow(/ya está anulado/i);
    });
  });

  // --------------------------------------------------------------------------------------------- revisión de documentos

  describe('revisión: aprobar y rechazar un documento', () => {
    const cargarDoc = async (
      ticket: { ticketId: string; pedidoId: string },
      tipo: string,
      extra: Record<string, unknown> = {},
    ) =>
      (
        await t
          .http()
          .post('/api/qhse/documentos')
          .set(tecnico())
          .send({
            pedidoId: ticket.pedidoId,
            ticketId: ticket.ticketId,
            tipo,
            archivoId: await archivo('qhse_documento_pedido'),
            ...extra,
          })
          .expect(201)
      ).body;
    const aprobar = (id: string, quien = tecnico()) =>
      t.http().post(`/api/qhse/documentos/${id}/aprobar`).set(quien);
    const rechazar = (id: string, cuerpo: Record<string, unknown>, quien = tecnico()) =>
      t.http().post(`/api/qhse/documentos/${id}/rechazar`).set(quien).send(cuerpo);
    const historial = async (id: string) =>
      (await t.http().get(`/api/qhse/documentos/${id}/historial`).set(tecnico()).expect(200)).body;
    const pasos = async (id: string) =>
      (await historial(id)).map(
        (h: { estadoAnterior: string | null; estadoNuevo: string }) =>
          `${h.estadoAnterior}>${h.estadoNuevo}`,
      );
    const estadoDe = async (ticketId: string) =>
      (await t.http().get(`/api/qhse/documentos/ticket/${ticketId}`).set(tecnico()).expect(200))
        .body;

    it('rechazar avisa (asignados) a quien subió el documento y al supervisor del ticket, sin repetidos y sin quien rechaza', async () => {
      const tk = await ticketNuevo(SUPERVISOR.id);
      const pt = await cargarDoc(tk, 'pt', { fecha: fechaEn(0) });
      const revisor = t.token(
        'gerente_hse',
        SUPLENTE.nombre,
        [P.DOCUMENTOS_VER, P.DOCUMENTOS_REVISAR],
        SUPLENTE.id,
      );
      await rechazar(pt.id, { motivo: 'Firma ilegible' }, revisor).expect(201);
      const [ev] = await eventos('qhse.documento_pedido.rechazado', tk.ticketId);
      expect(ev.datos.data['tipoDocumentoNombre']).toBe('Permiso de Trabajo (PT)');
      expect(ev.datos.data['asignados']).toEqual([
        { usuarioId: TECNICO.id, rolCodigo: 'tecnico_hse' },
        { usuarioId: SUPERVISOR.id, rolCodigo: 'supervisor' },
      ]);
      // si quien rechaza es quien lo subió y el supervisor del ticket es otro, solo se avisa al supervisor
      const pt2 = await cargarDoc(tk, 'pt', { fecha: fechaEn(1) });
      await rechazar(pt2.id, { motivo: 'Vencido' }).expect(201);
      const eventosRech = await eventos('qhse.documento_pedido.rechazado', tk.ticketId);
      expect(eventosRech[1].datos.data['asignados']).toEqual([
        { usuarioId: SUPERVISOR.id, rolCodigo: 'supervisor' },
      ]);
    });

    it('un documento nace cargado, con su fila de historia; aprobarlo registra quién y cuándo, publica .aprobado y no cambia el estado que ve Operaciones', async () => {
      const tk = await ticketNuevo();
      const doc = await cargarDoc(tk, 'sfi');
      expect(doc).toMatchObject({
        revisionEstado: 'cargado',
        revisadoAt: null,
        revisadoPor: null,
        motivoRechazo: null,
      });
      expect((await estadoDe(tk.ticketId)).sfi).toMatchObject({
        id: doc.id,
        revisionEstado: 'cargado',
      });

      // quien no gestiona documentos no revisa
      expect((await aprobar(doc.id, supervisor())).status).toBe(403);
      const r = await aprobar(doc.id);
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({
        revisionEstado: 'aprobado',
        revisadoPor: TECNICO.nombre,
        motivoRechazo: null,
        anulado: false,
      });
      expect(r.body.revisadoAt).toBeTruthy();

      const ev = await eventos('qhse.documento_pedido.aprobado', tk.ticketId);
      expect(ev).toHaveLength(1);
      expect(ev[0].datos.actor?.userId).toBe(TECNICO.id);
      expect(ev[0].datos.data).toMatchObject({
        documentoId: doc.id,
        tipoDocumento: 'sfi',
        pedidoId: tk.pedidoId,
        ticketId: tk.ticketId,
        revisadoPor: TECNICO.id,
      });
      // sigue valiendo: el estado que ve Operaciones es el mismo y no se publicó ninguna anulación
      expect((await estadoDe(tk.ticketId)).sfi).toMatchObject({
        id: doc.id,
        archivoId: doc.archivoId,
        revisionEstado: 'aprobado',
        revisadoPor: TECNICO.nombre,
      });
      expect(await eventos('qhse.documento_pedido.anulado', tk.ticketId)).toHaveLength(0);

      // una sola revisión: no se aprueba ni se rechaza de nuevo
      expect((await aprobar(doc.id)).status).toBe(409);
      expect((await rechazar(doc.id, { motivo: 'tarde' })).status).toBe(409);
      expect(await pasos(doc.id)).toEqual(['null>cargado', 'cargado>aprobado']);

      // un documento aprobado todavía se puede anular (con su motivo); la historia lo recuerda
      expect((await anular(doc.id, 'Se cargó el archivo equivocado')).status).toBe(201);
      expect(await pasos(doc.id)).toEqual(['null>cargado', 'cargado>aprobado', 'aprobado>anulado']);
    });

    it('rechazar exige motivo, deja el documento sin valor como uno anulado (publica .anulado y .rechazado) y permite cargar otro del mismo tipo y día', async () => {
      const tk = await ticketNuevo();
      const hoy = fechaEn(0);
      const pt = await cargarDoc(tk, 'pt', { fecha: hoy });
      expect((await estadoDe(tk.ticketId)).ptHoy).toMatchObject({
        id: pt.id,
        revisionEstado: 'cargado',
      });

      expect((await rechazar(pt.id, {})).status).toBe(400);
      expect((await rechazar(pt.id, { motivo: '   ' })).status).toBe(400);
      expect((await rechazar(pt.id, { motivo: 'x' }, supervisor())).status).toBe(403);
      const r = await rechazar(pt.id, { motivo: 'Firma ilegible' });
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({
        revisionEstado: 'rechazado',
        revisadoPor: TECNICO.nombre,
        motivoRechazo: 'Firma ilegible',
        anulado: true,
        motivoAnulacion: 'Firma ilegible',
      });

      // mismo efecto aguas abajo que una anulación: el evento .anulado (Operaciones reabre su requisito) y además .rechazado con el PT del día
      const anulado = await eventos('qhse.documento_pedido.anulado', tk.ticketId);
      expect(anulado).toHaveLength(1);
      expect(anulado[0].datos.data).toMatchObject({
        documentoId: pt.id,
        tipoDocumento: 'pt',
        fecha: hoy,
        motivo: 'Firma ilegible',
      });
      const rechazado = await eventos('qhse.documento_pedido.rechazado', tk.ticketId);
      expect(rechazado).toHaveLength(1);
      expect(rechazado[0].datos.data).toMatchObject({
        documentoId: pt.id,
        tipoDocumento: 'pt',
        pedidoId: tk.pedidoId,
        ticketId: tk.ticketId,
        fecha: hoy,
        motivo: 'Firma ilegible',
        revisadoPor: TECNICO.id,
      });

      // ya no cuenta como cargado, pero el motivo queda a la vista de la bandeja
      const estado = await estadoDe(tk.ticketId);
      expect(estado.ptHoy).toBeNull();
      expect(estado.rechazados).toEqual([
        expect.objectContaining({
          id: pt.id,
          tipo: 'pt',
          fecha: hoy,
          revisionEstado: 'rechazado',
          revisadoPor: TECNICO.nombre,
          motivoRechazo: 'Firma ilegible',
        }),
      ]);
      // no se aprueba ni se rechaza de nuevo
      expect((await aprobar(pt.id)).status).toBe(409);
      expect((await rechazar(pt.id, { motivo: 'otra vez' })).status).toBe(409);

      // el rechazado no bloquea la carga de otro PT del mismo día (el índice único mira solo los vigentes)
      const nuevo = await cargarDoc(tk, 'pt', { fecha: hoy });
      expect(nuevo).toMatchObject({ revisionEstado: 'cargado', anulado: false });
      const despues = await estadoDe(tk.ticketId);
      expect(despues.ptHoy).toMatchObject({ id: nuevo.id });
      expect(despues.rechazados).toEqual([]);

      // la lista trae la revisión de cada documento (también el rechazado, con incluirAnulados)
      const lista = (
        await t
          .http()
          .get(`/api/qhse/documentos?pedidoId=${tk.pedidoId}&incluirAnulados=true`)
          .set(tecnico())
          .expect(200)
      ).body as Array<{ id: string; revisionEstado: string; motivoRechazo: string | null }>;
      expect(lista.find((x) => x.id === pt.id)).toMatchObject({
        revisionEstado: 'rechazado',
        motivoRechazo: 'Firma ilegible',
      });
      expect(lista.find((x) => x.id === nuevo.id)).toMatchObject({ revisionEstado: 'cargado' });

      const h = await historial(pt.id);
      expect(h).toHaveLength(2);
      expect(h[1]).toMatchObject({
        estadoAnterior: 'cargado',
        estadoNuevo: 'rechazado',
        motivo: 'Firma ilegible',
        actorId: TECNICO.id,
        actor: TECNICO.nombre,
      });
      // lo lee quien ve documentos; el Supervisor (solo Acta) no
      await t.http().get(`/api/qhse/documentos/${pt.id}/historial`).set(supervisor()).expect(403);
      await t.http().get(`/api/qhse/documentos/${uuidv7()}/historial`).set(tecnico()).expect(404);
    });

    it('rechazar el Acta publica acta_entrega.anulada (el ticket vuelve a exigirla) y .rechazado, y se puede subir otra', async () => {
      const tk = await ticketNuevo();
      const a1 = await archivo('qhse_acta_entrega');
      const acta1 = (await acta(tk.ticketId, { archivoId: a1 }).expect(201)).body;
      expect((await rechazar(acta1.id, { motivo: 'Sin sello' })).status).toBe(201);
      expect(await eventos('qhse.acta_entrega.anulada', tk.ticketId)).toHaveLength(1);
      expect(await eventos('qhse.documento_pedido.rechazado', tk.ticketId)).toHaveLength(1);
      const a2 = await archivo('qhse_acta_entrega');
      expect((await acta(tk.ticketId, { archivoId: a2 })).status).toBe(201);
    });

    describe('reglas de la base', () => {
      it('CHECK: el rechazo exige quién, cuándo, motivo y estar anulado; aprobar no lleva motivo', async () => {
        const tk = await ticketNuevo();
        const id = (await cargarDoc(tk, 'sfi')).id as string;
        const quien = `revisado_at = now(), revisado_por = '${TECNICO.id}'`;
        const upd = (set: string) =>
          t.admin.query(`UPDATE qhse.documento_pedido SET ${set} WHERE id = $1`, [id]);
        await expect(
          upd(
            `revision_estado = 'rechazado', ${quien}, motivo_rechazo = '  ', anulado_at = now(), anulado_por = '${TECNICO.id}', motivo_anulacion = 'x'`,
          ),
        ).rejects.toThrow(/revision_check/);
        await expect(
          upd(`revision_estado = 'rechazado', ${quien}, motivo_rechazo = 'x'`),
        ).rejects.toThrow(/rechazo_anulado_check/);
        await expect(
          upd(`revision_estado = 'aprobado', ${quien}, motivo_rechazo = 'x'`),
        ).rejects.toThrow(/revision_check/);
        // sin cambiar de estado, la revisión no se toca (lo impide el trigger antes que el CHECK)
        await expect(upd(`revisado_por = '${TECNICO.id}'`)).rejects.toThrow(/no se puede cambiar/);
      });

      it('el trigger impide aprobar un documento anulado y cambiar una revisión; la aplicación solo lee e inserta la historia', async () => {
        const tk = await ticketNuevo();
        const doc = await cargarDoc(tk, 'sfi');
        await anular(doc.id, 'Equivocado').expect(201);
        await expect(
          t.prisma.documentoPedido.update({
            where: { id: doc.id },
            data: {
              revisionEstado: 'aprobado',
              revisadoAt: new Date(),
              revisadoPor: TECNICO.id,
            },
          }),
        ).rejects.toThrow(/anulado/i);

        const otro = await cargarDoc(tk, 'formato_recepcion');
        await aprobar(otro.id).expect(201);
        await expect(
          t.prisma.documentoPedido.update({
            where: { id: otro.id },
            data: { motivoRechazo: 'cambio' },
          }),
        ).rejects.toThrow(/revisi/i);

        // historia append-only
        const fila = await t.prisma.documentoPedidoRevision.findFirstOrThrow({
          where: { documentoPedidoId: otro.id },
        });
        await expect(
          t.prisma.documentoPedidoRevision.update({
            where: { id: fila.id },
            data: { motivo: 'editado' },
          }),
        ).rejects.toThrow(/permission denied|denegado/i);
        await expect(
          t.prisma.documentoPedidoRevision.delete({ where: { id: fila.id } }),
        ).rejects.toThrow(/permission denied|denegado/i);
        await expect(
          t.admin.query(
            "INSERT INTO qhse.documento_pedido_revision (id, documento_pedido_id, estado_anterior, estado_nuevo, actor_id) VALUES (gen_random_uuid(), $1, 'cargado', 'rechazado', $2)",
            [otro.id, TECNICO.id],
          ),
        ).rejects.toThrow(/motivo_check/);
      });
    });
  });
});
