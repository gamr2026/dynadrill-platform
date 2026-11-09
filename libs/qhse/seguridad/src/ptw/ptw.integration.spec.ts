/**
 * Integración real de QHSE: Permiso de Trabajo (PTW) por día y pedido, con las reglas de la base.
 *   RUN_INTEGRATION=1 npx jest ptw   (dentro de libs/qhse/seguridad)
 */
import { Permission } from '@dyn/authz';
import { uuidv7 } from '@dyn/utils';
import { levantarAppDePrueba, type AppDePrueba } from '../testing/app-de-prueba';
import { quitarMaestros, sembrarMaestros, type MaestrosDePrueba } from '../testing/maestros';

const run = process.env['RUN_INTEGRATION'] ? describe : describe.skip;
const n = Date.now();
const P = Permission;

const TECNICO = { id: uuidv7(), nombre: 'Tania Técnica HSE' };
const GERENTE = { id: uuidv7(), nombre: 'Gerardo Gerente HSE' };
const SUPERVISOR = { id: uuidv7(), nombre: 'Sara Supervisora' };
const MAESTROS: MaestrosDePrueba = {
  usuarios: [
    { ...TECNICO, rol: 'tecnico_hse' },
    { ...GERENTE, rol: 'gerente_hse' },
    { ...SUPERVISOR, rol: 'supervisor' },
  ],
};

type Salida = {
  datos: { source: string; actor?: { userId: string }; data: Record<string, unknown> };
};

const hoy = new Date().toISOString().slice(0, 10);
const fechaEn = (dias: number, base = hoy) =>
  new Date(new Date(`${base}T00:00:00Z`).getTime() + dias * 86_400_000).toISOString().slice(0, 10);

run('QHSE: Permiso de Trabajo (PTW) por día y pedido (base de datos real)', () => {
  jest.setTimeout(120000);
  let t: AppDePrueba;
  let moduloDoc = '';
  const pedidos: string[] = [];
  const tickets: string[] = [];
  const archivos: string[] = [];

  const hse = () =>
    t.token(
      'tecnico_hse',
      TECNICO.nombre,
      [P.PTW_VER, P.PTW_GESTIONAR, P.DOCUMENTOS_VER, P.DOCUMENTOS_GESTIONAR],
      TECNICO.id,
    );
  const gerente = () =>
    t.token(
      'gerente_hse',
      GERENTE.nombre,
      [P.PTW_VER, P.PTW_GESTIONAR, P.PTW_APROBAR, P.DOCUMENTOS_GESTIONAR],
      GERENTE.id,
    );
  const supervisor = () =>
    t.token(
      'supervisor',
      SUPERVISOR.nombre,
      [P.ACTA_ENTREGA_VER, P.ACTA_ENTREGA_CARGAR],
      SUPERVISOR.id,
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
        pedidoCodigo: `PED-PTW${n}`,
        ticketNumero: 960_000 + pedidos.length,
        supervisorId: SUPERVISOR.id,
        cliente: 'Cliente PTW',
      },
    });
    return { ticketId, pedidoId };
  };
  const archivo = async () => {
    const id = uuidv7();
    archivos.push(id);
    await t.admin.query(
      `INSERT INTO archivos.archivo (id, modulo_id, nombre_original, mime_type, tamano_bytes, sha256, blob_key, escaneo, subido_por)
       VALUES ($1, $2, 'doc.pdf', 'application/pdf', 10, $3, $4, 'omitido', $5)`,
      [id, moduloDoc, id.replace(/-/g, '').padEnd(64, '0'), `qhse-ptw/${n}/${id}`, TECNICO.id],
    );
    return id;
  };
  const doc = async (pedidoId: string, cuerpo: Record<string, unknown>) =>
    t
      .http()
      .post('/api/qhse/documentos')
      .set(hse())
      .send({ pedidoId, archivoId: await archivo(), ...cuerpo });
  /** Deja en el pedido los documentos que sirven para el PTW de `dia`. */
  const documentosCompletos = async (pedidoId: string, dia: string) => {
    expect((await doc(pedidoId, { tipo: 'formato_recepcion' })).status).toBe(201);
    expect((await doc(pedidoId, { tipo: 'sfi' })).status).toBe(201);
    expect((await doc(pedidoId, { tipo: 'art', fecha: fechaEn(-2, dia) })).status).toBe(201);
    expect((await doc(pedidoId, { tipo: 'pt', fecha: dia })).status).toBe(201);
  };
  const abrir = (ticketId: string, diaOperacion: string, quien = hse()) =>
    t.http().post('/api/qhse/ptw').set(quien).send({ ticketId, diaOperacion });
  const accion = (id: string, ruta: string, cuerpo: Record<string, unknown> = {}, quien = hse()) =>
    t.http().post(`/api/qhse/ptw/${id}/${ruta}`).set(quien).send(cuerpo);
  const eventos = async (tipo: string, ticketId: string) =>
    (
      await t.admin.query(
        "SELECT datos FROM msg_qhse.outbox WHERE tipo = $1 AND datos->'data'->>'ticketId' = $2 ORDER BY ocurrido_at, id",
        [tipo, ticketId],
      )
    ).rows as Salida[];
  /** Un PTW con los documentos validados, listo para que QHSE lo apruebe. */
  const enAprobacion = async (dia = hoy) => {
    const { ticketId, pedidoId } = await ticketNuevo();
    await documentosCompletos(pedidoId, dia);
    const p = await abrir(ticketId, dia);
    expect(p.status).toBe(201);
    expect((await accion(p.body.id, 'validar-documentos')).status).toBe(201);
    return { ticketId, pedidoId, id: p.body.id as string, dia };
  };
  const sql = (texto: string, params: unknown[] = []) => t.admin.query(texto, params);

  beforeAll(async () => {
    t = await levantarAppDePrueba('3196');
    await sembrarMaestros(t.admin, MAESTROS);
    moduloDoc = (
      await t.admin.query(
        "SELECT id FROM archivos.modulo_archivo WHERE codigo = 'qhse_documento_pedido'",
      )
    ).rows[0].id;
  });

  afterAll(async () => {
    await sql('DELETE FROM qhse.ptw WHERE pedido_id = ANY($1::uuid[])', [pedidos]);
    await sql('DELETE FROM qhse.documento_pedido WHERE pedido_id = ANY($1::uuid[])', [pedidos]);
    await sql('DELETE FROM qhse.ticket_ref WHERE ticket_id = ANY($1::uuid[])', [tickets]);
    await sql("DELETE FROM msg_qhse.outbox WHERE datos->'data'->>'pedidoId' = ANY($1::text[])", [
      pedidos,
    ]);
    await sql('DELETE FROM archivos.archivo WHERE id = ANY($1::uuid[])', [archivos]);
    await quitarMaestros(t.admin, MAESTROS);
    await t.cerrar();
  });

  // ------------------------------------------------------------------------------------------------ ciclo completo

  it('ciclo completo (como la demo): abrir, validar la gabinete y aprobar; cada hito publica su evento con ticketId y pedidoId', async () => {
    const { ticketId, pedidoId } = await ticketNuevo();
    await documentosCompletos(pedidoId, hoy);

    const abierto = await abrir(ticketId, hoy);
    expect(abierto.status).toBe(201);
    const id = abierto.body.id as string;
    expect(abierto.body).toMatchObject({
      fase: 'gabinete',
      diaOperacion: hoy,
      ticketId,
      pedidoId,
      cliente: 'Cliente PTW',
      gabineteCompleta: true,
    });
    expect(abierto.body.codigo).toMatch(/^PTW-\d{6}$/);
    expect((await eventos('qhse.ptw.abierto', ticketId))[0].datos.data).toMatchObject({
      ptwId: id,
      ticketId,
      pedidoId,
      diaOperacion: hoy,
      fase: 'gabinete',
    });

    // la aprobación aún no se acepta, y la formalización ya no existe
    expect((await accion(id, 'aprobar', {}, gerente())).status).toBe(409);
    expect((await accion(id, 'confirmaciones', { tipo: 'barricadas' })).status).toBe(404);

    const validado = await accion(id, 'validar-documentos');
    expect(validado.status).toBe(201);
    expect(validado.body.fase).toBe('aprobacion');
    expect(
      validado.body.requisitos.every((r: { documentoId: string | null }) => r.documentoId),
    ).toBe(true);
    expect((await accion(id, 'validar-documentos')).status).toBe(409);
    // ya no se publica la formalización ni queda evidencia de confirmaciones
    expect(await eventos('qhse.ptw.formalizado', ticketId)).toHaveLength(0);
    expect(await eventos('qhse.ptw.firmado', ticketId)).toHaveLength(0);

    // aprueba quien tiene el permiso de aprobar, no quien solo gestiona
    expect((await accion(id, 'aprobar', {}, hse())).status).toBe(403);
    const aprobado = await accion(id, 'aprobar', {}, gerente());
    expect(aprobado.status).toBe(201);
    expect(aprobado.body.fase).toBe('aprobado');
    const cerrado = await eventos('qhse.ptw.cerrado', ticketId);
    expect(cerrado).toHaveLength(1);
    expect(cerrado[0].datos.actor?.userId).toBe(GERENTE.id);
    // la aprobación también deja su evidencia, con quien aprobó como firmante
    const aprobacion = (await eventos('qhse.ptw.firmado', ticketId)).filter(
      (e) => e.datos.data['rolFirmante'] === 'aprobacion',
    );
    expect(aprobacion).toHaveLength(1);
    expect(aprobacion[0].datos.actor?.userId).toBe(GERENTE.id);
    expect(cerrado[0].datos.data).toMatchObject({
      ptwId: id,
      ticketId,
      pedidoId,
      diaOperacion: hoy,
      fase: 'aprobado',
      asignados: [{ usuarioId: SUPERVISOR.id, rolCodigo: 'supervisor' }],
    });
    expect(aprobado.body.historial.map((h: { accion: string }) => h.accion)).toEqual([
      'abierto',
      'documentos_validados',
      'aprobado',
    ]);
    expect(aprobado.body.firmas).toHaveLength(1);
    expect((await accion(id, 'aprobar', {}, gerente())).status).toBe(409);
  });

  // --------------------------------------------------------------------------------------------------- un PTW por día

  it('uno vigente por pedido y día: el segundo se rechaza, otro día se abre y tras anular se puede abrir de nuevo', async () => {
    const { ticketId } = await ticketNuevo();
    const primero = await abrir(ticketId, hoy);
    expect(primero.status).toBe(201);
    const dup = await abrir(ticketId, hoy);
    expect(dup.status).toBe(409);
    expect(dup.body.detail).toMatch(/solo se permite uno por pedido y día/);
    expect((await abrir(ticketId, fechaEn(1))).status).toBe(201);
    expect((await abrir(ticketId, '2026-02-31')).status).toBe(400);
    expect((await abrir(uuidv7(), hoy)).status).toBe(404);

    expect((await accion(primero.body.id, 'anular', { motivo: '  ' }, gerente())).status).toBe(400);
    expect(
      (await accion(primero.body.id, 'anular', { motivo: 'Se abrió con el día equivocado' }, hse()))
        .status,
    ).toBe(403);
    const anulado = await accion(
      primero.body.id,
      'anular',
      { motivo: 'Se abrió con el día equivocado' },
      gerente(),
    );
    expect(anulado.status).toBe(201);
    expect(anulado.body).toMatchObject({
      anulado: true,
      motivoAnulacion: 'Se abrió con el día equivocado',
      anuladoPor: GERENTE.nombre,
    });
    expect((await eventos('qhse.ptw.anulado', ticketId))[0].datos.data).toMatchObject({
      ptwId: primero.body.id,
      motivo: 'Se abrió con el día equivocado',
    });
    expect((await abrir(ticketId, hoy)).status).toBe(201);
    // un PTW anulado no avanza
    expect((await accion(primero.body.id, 'validar-documentos')).status).toBe(409);
  });

  // ------------------------------------------------------------------------------------------------------ la gabinete

  it('la gabinete exige los cuatro documentos: dice cuáles faltan y un ART vencido bloquea', async () => {
    const { ticketId, pedidoId } = await ticketNuevo();
    const p = await abrir(ticketId, hoy);
    expect(p.body.gabineteCompleta).toBe(false);
    const vacio = await accion(p.body.id, 'validar-documentos');
    expect(vacio.status).toBe(409);
    expect(vacio.body.detail).toMatch(/formato de recepción.*ART.*PT.*sfi/i);

    expect((await doc(pedidoId, { tipo: 'formato_recepcion' })).status).toBe(201);
    expect((await doc(pedidoId, { tipo: 'sfi' })).status).toBe(201);
    expect((await doc(pedidoId, { tipo: 'pt', fecha: hoy })).status).toBe(201);
    // el ART venció hace 5 días: bloquea
    expect((await doc(pedidoId, { tipo: 'art', fecha: fechaEn(-20) })).status).toBe(201);
    const vencido = await accion(p.body.id, 'validar-documentos');
    expect(vencido.status).toBe(409);
    expect(vencido.body.detail).toMatch(/ya venció para el .*un ART vencido bloquea/);
    // el PT de otro día tampoco sirve
    const otroDia = await abrir(ticketId, fechaEn(3));
    expect(otroDia.body.requisitos.find((r: { tipo: string }) => r.tipo === 'pt').falta).toMatch(
      /No hay un PT cargado para el/,
    );

    // con un ART vigente que cubre el día, pasa
    expect((await doc(pedidoId, { tipo: 'art', fecha: fechaEn(-3) })).status).toBe(201);
    const ok = await accion(p.body.id, 'validar-documentos');
    expect(ok.status).toBe(201);
    expect(
      ok.body.requisitos.find((r: { tipo: string }) => r.tipo === 'art').documentoId,
    ).toBeTruthy();
  });

  it('el ART cubre solo su vigencia: un PTW de un día posterior a los 15 días no se valida', async () => {
    const { ticketId, pedidoId } = await ticketNuevo();
    const dia = fechaEn(20);
    await doc(pedidoId, { tipo: 'formato_recepcion' });
    await doc(pedidoId, { tipo: 'sfi' });
    await doc(pedidoId, { tipo: 'pt', fecha: dia });
    await doc(pedidoId, { tipo: 'art', fecha: hoy }); // vale hasta hoy + 15
    const p = await abrir(ticketId, dia);
    expect((await accion(p.body.id, 'validar-documentos')).status).toBe(409);
  });

  it('un documento en uso por un PTW vigente no se anula hasta anular el PTW', async () => {
    const { id, pedidoId } = await enAprobacion();
    const pt = (
      await t.http().get('/api/qhse/documentos').query({ pedidoId, tipo: 'pt' }).set(hse())
    ).body[0];
    const enUso = await t
      .http()
      .post(`/api/qhse/documentos/${pt.id}/anular`)
      .set(hse())
      .send({ motivo: 'prueba' });
    expect(enUso.status).toBe(409);
    expect(enUso.body.detail).toMatch(/en uso por el PTW PTW-\d{6}/);
    expect((await accion(id, 'anular', { motivo: 'PTW mal abierto' }, gerente())).status).toBe(201);
    expect(
      (
        await t
          .http()
          .post(`/api/qhse/documentos/${pt.id}/anular`)
          .set(hse())
          .send({ motivo: 'prueba' })
      ).status,
    ).toBe(201);
  });

  it('un PTW anulado se puede reintegrar con su motivo: recupera su fase y deja la huella; no si el día ya tiene otro vigente o un documento se anuló', async () => {
    const { id, ticketId, pedidoId } = await enAprobacion();
    expect((await accion(id, 'aprobar', {}, gerente())).status).toBe(201);
    // no se reintegra lo que no está anulado
    const noAnulado = await accion(id, 'reintegrar', { motivo: 'por error' }, gerente());
    expect(noAnulado.status).toBe(409);
    expect(noAnulado.body.detail).toMatch(/no está anulado/);

    expect((await accion(id, 'anular', { motivo: 'Se anuló por error' }, gerente())).status).toBe(
      201,
    );
    // quien reintegra necesita el permiso de aprobar y debe decir por qué
    expect((await accion(id, 'reintegrar', { motivo: 'fue un error' }, hse())).status).toBe(403);
    expect((await accion(id, 'reintegrar', { motivo: '  ' }, gerente())).status).toBe(400);

    const r = await accion(id, 'reintegrar', { motivo: 'La anulación fue un error' }, gerente());
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ anulado: false, fase: 'aprobado', anuladoPor: null });
    // la anulación anterior queda en el historial, seguida del reintegro con su motivo
    expect(r.body.historial.map((h: { accion: string }) => h.accion)).toEqual([
      'abierto',
      'documentos_validados',
      'aprobado',
      'anulado',
      'reintegrado',
    ]);
    expect(r.body.historial.at(-1).motivo).toBe('La anulación fue un error');
    expect((await eventos('qhse.ptw.reintegrado', ticketId))[0].datos.data).toMatchObject({
      ptwId: id,
      fase: 'aprobado',
      motivo: 'La anulación fue un error',
    });
    // sigue siendo el vigente del día: otro no se puede abrir
    expect((await abrir(ticketId, hoy)).status).toBe(409);

    // si el día ya tiene otro PTW vigente, no se reintegra hasta anularlo
    expect((await accion(id, 'anular', { motivo: 'otra vez' }, gerente())).status).toBe(201);
    const otro = await abrir(ticketId, hoy);
    expect(otro.status).toBe(201);
    const choca = await accion(id, 'reintegrar', { motivo: 'quiero este' }, gerente());
    expect(choca.status).toBe(409);
    expect(choca.body.detail).toMatch(/Ya hay un PTW vigente/);
    expect((await accion(otro.body.id, 'anular', { motivo: 'sobra' }, gerente())).status).toBe(201);

    // si alguno de sus documentos se anuló mientras tanto, tampoco
    const pt = (
      await t.http().get('/api/qhse/documentos').query({ pedidoId, tipo: 'pt' }).set(hse())
    ).body[0];
    expect(
      (
        await t
          .http()
          .post(`/api/qhse/documentos/${pt.id}/anular`)
          .set(hse())
          .send({ motivo: 'se cargó mal' })
      ).status,
    ).toBe(201);
    const sinDoc = await accion(id, 'reintegrar', { motivo: 'insisto' }, gerente());
    expect(sinDoc.status).toBe(409);
    expect(sinDoc.body.detail).toMatch(/documentos/);
    // y un PTW anulado sigue sin poder cambiarse de otra forma (lo protege la base)
    await expect(sql("UPDATE qhse.ptw SET fase = 'gabinete' WHERE id = $1", [id])).rejects.toThrow(
      /anulado/,
    );
  });

  // ------------------------------------------------------------------------------------------------------- permisos

  it('el Supervisor no entra al PTW y hace falta el permiso de cada acción', async () => {
    const { ticketId } = await ticketNuevo();
    expect((await t.http().get('/api/qhse/ptw').set(supervisor())).status).toBe(403);
    expect((await abrir(ticketId, hoy, supervisor())).status).toBe(403);
    const soloVer = t.token('tecnico_hse', TECNICO.nombre, [P.PTW_VER], TECNICO.id);
    expect((await t.http().get('/api/qhse/ptw').set(soloVer)).status).toBe(200);
    expect((await abrir(ticketId, hoy, soloVer)).status).toBe(403);
    // la bandeja filtra por fase y pedido
    const p = await abrir(ticketId, hoy);
    const lista = await t
      .http()
      .get('/api/qhse/ptw')
      .query({ pedidoId: p.body.pedidoId, fase: 'gabinete' })
      .set(hse());
    expect(lista.body).toHaveLength(1);
    expect(lista.body[0]).toMatchObject({
      id: p.body.id,
      pedidoCodigo: `PED-PTW${n}`,
      cliente: 'Cliente PTW',
    });
    expect(
      (
        await t
          .http()
          .get('/api/qhse/ptw')
          .query({ pedidoId: p.body.pedidoId, fase: 'aprobado' })
          .set(hse())
      ).body,
    ).toHaveLength(0);
  });

  // ------------------------------------------------------------------------------------- reglas de la base de datos

  describe('reglas de la base', () => {
    it('no se salta de fase, aunque se intente por fuera del servicio', async () => {
      const { ticketId } = await ticketNuevo();
      const p = await abrir(ticketId, hoy);
      await expect(
        t.prisma.ptw.update({ where: { id: p.body.id }, data: { fase: 'aprobado' } }),
      ).rejects.toThrow(/Cambio de fase no permitido/);
      // pasar a aprobación sin documentos fijados se rechaza, y la formalización ya no es una fase válida
      await expect(
        t.prisma.ptw.update({ where: { id: p.body.id }, data: { fase: 'aprobacion' } }),
      ).rejects.toThrow(/ptw_documentos_check|Falta el documento/);
      await expect(
        t.prisma.ptw.update({ where: { id: p.body.id }, data: { fase: 'formalizacion' } }),
      ).rejects.toThrow(/Cambio de fase no permitido/);
    });

    it('al pasar a aprobación cada documento debe ser del tipo, del pedido y estar vigente', async () => {
      const a = await ticketNuevo();
      const b = await ticketNuevo();
      await documentosCompletos(a.pedidoId, hoy);
      await documentosCompletos(b.pedidoId, hoy);
      const ids = async (pedidoId: string) => {
        const r = await sql(
          'SELECT id, tipo FROM qhse.documento_pedido WHERE pedido_id = $1 AND anulado_at IS NULL',
          [pedidoId],
        );
        return Object.fromEntries(r.rows.map((x: { id: string; tipo: string }) => [x.tipo, x.id]));
      };
      const da = await ids(a.pedidoId);
      const db = await ids(b.pedidoId);
      const p = await abrir(a.ticketId, hoy);
      const pasar = (extra: Record<string, string>) =>
        t.prisma.ptw.update({
          where: { id: p.body.id },
          data: {
            fase: 'aprobacion',
            documentoRecepcionId: da['formato_recepcion'],
            documentoArtId: da['art'],
            documentoPtId: da['pt'],
            documentoSfiId: da['sfi'],
            ...extra,
          },
        });
      // un documento de otro pedido
      await expect(pasar({ documentoSfiId: db['sfi'] })).rejects.toThrow(
        /no es del pedido|no es de ese tipo/,
      );
      // un documento de otro tipo
      await expect(pasar({ documentoPtId: da['sfi'] })).rejects.toThrow(
        /no es del pedido|no es de ese tipo/,
      );
      // un ART que no cubre el día
      await sql(
        "UPDATE qhse.documento_pedido SET anulado_at = now(), anulado_por = $2, motivo_anulacion = 'x' WHERE id = $1",
        [da['art'], TECNICO.id],
      );
      const viejo = await doc(a.pedidoId, { tipo: 'art', fecha: fechaEn(-30) });
      await expect(pasar({ documentoArtId: viejo.body.id })).rejects.toThrow(/ART no está vigente/);
      // un documento anulado
      await expect(pasar({ documentoArtId: da['art'] })).rejects.toThrow(/anulado/);
    });

    it('lo fijado queda congelado, el ticket y el día no cambian y la aplicación no puede editar esas columnas ni borrar', async () => {
      const { id } = await enAprobacion();
      const otro = await archivo();
      void otro;
      await expect(
        t.prisma.ptw.update({ where: { id }, data: { documentoSfiId: null } }),
      ).rejects.toThrow(/ya están fijados|documentos_check/);
      await expect(
        t.prisma.ptw.update({
          where: { id },
          data: { diaOperacion: new Date('2030-01-01T00:00:00Z') },
        }),
      ).rejects.toThrow(/permission denied|denegado/i);
      await expect(t.prisma.ptw.delete({ where: { id } })).rejects.toThrow(
        /permission denied|denegado/i,
      );
      await expect(
        t.admin.query('UPDATE qhse.ptw SET dia_operacion = $2 WHERE id = $1', [id, '2030-01-01']),
      ).rejects.toThrow(/no se pueden cambiar/);
    });

    it('para aprobar hace falta la aprobación de QHSE', async () => {
      const { id } = await enAprobacion();
      await expect(
        t.prisma.ptw.update({ where: { id }, data: { fase: 'aprobado' } }),
      ).rejects.toThrow(/Falta la aprobación de QHSE/);
    });

    it('la aprobación solo cabe en su fase y la historia no se edita ni se borra', async () => {
      const { ticketId } = await ticketNuevo();
      const p = await abrir(ticketId, hoy);
      // en gabinete no se acepta ni la aprobación ni las confirmaciones de la formalización retirada
      await expect(
        t.prisma.ptwFirma.create({
          data: { id: uuidv7(), ptwId: p.body.id, tipo: 'barricadas', usuarioId: TECNICO.id },
        }),
      ).rejects.toThrow(/fase de formalización/);
      await expect(
        t.prisma.ptwFirma.create({
          data: { id: uuidv7(), ptwId: p.body.id, tipo: 'aprobacion', usuarioId: TECNICO.id },
        }),
      ).rejects.toThrow(/fase de aprobación/);
      const { id } = await enAprobacion();
      const f = await t.prisma.ptwFirma.create({
        data: { id: uuidv7(), ptwId: id, tipo: 'aprobacion', usuarioId: TECNICO.id },
      });
      await expect(
        t.prisma.ptwFirma.create({
          data: { id: uuidv7(), ptwId: id, tipo: 'aprobacion', usuarioId: TECNICO.id },
        }),
      ).rejects.toThrow(/Unique|unique/);
      await expect(
        t.prisma.ptwFirma.update({ where: { id: f.id }, data: { usuarioId: GERENTE.id } }),
      ).rejects.toThrow(/permission denied|denegado/i);
      await expect(t.prisma.ptwFirma.delete({ where: { id: f.id } })).rejects.toThrow(
        /permission denied|denegado/i,
      );
      const h = await t.prisma.ptwHistorial.findFirstOrThrow({ where: { ptwId: id } });
      await expect(
        t.prisma.ptwHistorial.update({ where: { id: h.id }, data: { motivo: 'x' } }),
      ).rejects.toThrow(/permission denied|denegado/i);
      await expect(t.prisma.ptwHistorial.delete({ where: { id: h.id } })).rejects.toThrow(
        /permission denied|denegado/i,
      );
    });

    it('un PTW nace en gabinete, con una sola vigencia por pedido y día, y la anulación exige quién y por qué', async () => {
      const { ticketId, pedidoId } = await ticketNuevo();
      const ins = (extra: string, ...params: unknown[]) =>
        t.admin.query(
          `INSERT INTO qhse.ptw (id, ticket_id, pedido_id, dia_operacion, created_by ${extra ? ',' + extra.split('=')[0] : ''}) VALUES ($1, $2, $3, $4, $5 ${extra ? ',' + extra.split('=')[1] : ''})`,
          [uuidv7(), ticketId, pedidoId, '2031-05-05', TECNICO.id, ...params],
        );
      await ins('');
      await expect(ins('')).rejects.toThrow(/ptw_pedido_dia_vigente_key/);
      await expect(
        t.admin.query(
          "INSERT INTO qhse.ptw (id, ticket_id, pedido_id, dia_operacion, created_by, fase) VALUES ($1, $2, $3, '2031-05-06', $4, 'aprobado')",
          [uuidv7(), ticketId, pedidoId, TECNICO.id],
        ),
      ).rejects.toThrow(/nace en gabinete/);
      await expect(
        t.admin.query(
          "INSERT INTO qhse.ptw (id, ticket_id, pedido_id, dia_operacion, created_by, anulado_at) VALUES ($1, $2, $3, '2031-05-07', $4, now())",
          [uuidv7(), ticketId, pedidoId, TECNICO.id],
        ),
      ).rejects.toThrow(/ptw_anulacion_check/);
      // un ticket de otro pedido
      await expect(
        t.admin.query(
          "INSERT INTO qhse.ptw (id, ticket_id, pedido_id, dia_operacion, created_by) VALUES ($1, $2, $3, '2031-05-08', $4)",
          [uuidv7(), ticketId, uuidv7(), TECNICO.id],
        ),
      ).rejects.toThrow(/ptw_ticket_fkey/);
    });
  });
});
