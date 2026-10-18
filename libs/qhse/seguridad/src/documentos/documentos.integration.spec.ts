/**
 * Integración real de QHSE: documentos por pedido y Acta de Entrega de Locación (contrato 4.11), con las reglas de la base.
 *   RUN_INTEGRATION=1 npx jest documentos   (dentro de libs/qhse/seguridad)
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

run('QHSE: documentos por pedido y Acta de Entrega (base de datos real)', () => {
  jest.setTimeout(90000);
  let t: AppDePrueba;
  const pedidos: string[] = [];
  const tickets: string[] = [];
  const archivos: string[] = [];
  const modulo: Record<string, string> = {};

  const tecnico = () =>
    t.token(
      'tecnico_hse',
      TECNICO.nombre,
      [P.DOCUMENTOS_VER, P.DOCUMENTOS_GESTIONAR, P.ACTA_ENTREGA_VER, P.ACTA_ENTREGA_CARGAR],
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
  const operador = () => t.token('operador', OPERADOR.nombre, [P.PUMPING_OPERAR], OPERADOR.id);

  /** Un pedido con un ticket que QHSE ya conoce (llega por evento de Pumping). */
  const ticketNuevo = async () => {
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
    await t.admin.query('DELETE FROM archivos.archivo WHERE id = ANY($1::uuid[])', [archivos]);
    await quitarMaestros(t.admin, MAESTROS);
    await t.cerrar();
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
    expect(lista.body).toHaveLength(1);
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
    expect(historial.body.map((d: { anulado: boolean }) => d.anulado).sort()).toEqual([
      false,
      true,
    ]);
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
});
