/**
 * Integración real de QHSE: Derrames (HSE-AMBIENTAL-002), con las reglas de la base.
 *   RUN_INTEGRATION=1 npx jest derrames   (dentro de libs/qhse/seguridad)
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

type Catalogos = {
  ubicaciones: Array<{ id: string; codigo: string }>;
  bandas: Array<{
    id: string;
    codigo: string;
    desdeBarriles: number;
    hastaBarriles: number | null;
    porConfirmar: boolean;
  }>;
};

run('QHSE: Derrames (base de datos real)', () => {
  jest.setTimeout(120000);
  let t: AppDePrueba;
  let cat: Catalogos;
  const derrames: string[] = [];
  const tickets: string[] = [];

  const operador = () => t.token('operador', OPERADOR.nombre, [P.QHSE_REPORTAR], OPERADOR.id);
  const tecnico = () =>
    t.token('tecnico_hse', TECNICO.nombre, [P.QHSE_REPORTAR, P.DERRAMES_VER], TECNICO.id);

  const ubicacion = (codigo: string): string => {
    const u = cat.ubicaciones.find((x) => x.codigo === codigo);
    if (!u) throw new Error(`Falta la ubicación ${codigo} en la semilla`);
    return u.id;
  };
  const banda = (codigo: string): string => {
    const b = cat.bandas.find((x) => x.codigo === codigo);
    if (!b) throw new Error(`Falta la banda ${codigo} en la semilla`);
    return b.id;
  };
  const sql = (texto: string, params: unknown[] = []) => t.admin.query(texto, params);
  const ticketNuevo = async () => {
    const ticketId = uuidv7();
    tickets.push(ticketId);
    await t.prisma.ticketRef.create({
      data: {
        ticketId,
        pedidoId: uuidv7(),
        pedidoCodigo: `PED-DER${n}`,
        ticketNumero: 960_000 + tickets.length,
        supervisorId: null,
        cliente: 'Cliente Derrames',
      },
    });
    return ticketId;
  };
  const activar = async (cuerpo: Record<string, unknown> = {}, quien = operador()) => {
    const r = await t
      .http()
      .post('/api/qhse/derrames')
      .set(quien)
      .send({
        ubicacionId: ubicacion('geomembrana'),
        bandaId: banda('menor'),
        descripcion: 'Fuga de aceite hidráulico en la bomba 2',
        ubicacionFisica: 'Junto a la bomba 2',
        ...cuerpo,
      });
    if (r.status === 201) derrames.push(r.body.id);
    return r;
  };
  const eventos = async (tipo: string, id: string) =>
    (
      await sql(
        "SELECT datos FROM msg_qhse.outbox WHERE tipo = $1 AND datos->'data'->>'derrameId' = $2 ORDER BY ocurrido_at, id",
        [tipo, id],
      )
    ).rows as Array<{
      datos: { source: string; actor?: { userId: string }; data: Record<string, unknown> };
    }>;

  beforeAll(async () => {
    t = await levantarAppDePrueba('3182');
    await sembrarMaestros(t.admin, MAESTROS);
    cat = (await t.http().get('/api/qhse/derrames/catalogos').set(operador())).body;
  });

  afterAll(async () => {
    await t.admin.query('DELETE FROM qhse.derrame WHERE id = ANY($1::uuid[])', [derrames]);
    await t.admin.query('DELETE FROM qhse.ticket_ref WHERE ticket_id = ANY($1::uuid[])', [tickets]);
    await t.admin.query(
      "DELETE FROM msg_qhse.outbox WHERE datos->'data'->>'derrameId' = ANY($1::text[])",
      [derrames],
    );
    await quitarMaestros(t.admin, MAESTROS);
    await t.cerrar();
  });

  it('los catálogos salen sembrados y las bandas de volumen quedan marcadas por confirmar con Dynadrill', () => {
    expect(cat.ubicaciones.map((u) => u.codigo)).toEqual(['geomembrana', 'suelo', 'cuerpo_agua']);
    expect(cat.bandas.map((b) => [b.codigo, b.desdeBarriles, b.hastaBarriles])).toEqual([
      ['menor', 0, 1],
      ['moderado', 1, 5],
      ['mayor', 5, null],
    ]);
    // el supuesto de la demo no es definitivo
    expect(cat.bandas.every((b) => b.porConfirmar)).toBe(true);
  });

  it('cualquier trabajador activa la alerta; el equipo HSE la ve con sus reglas, el ticket y el evento', async () => {
    const ticketId = await ticketNuevo();
    const r = await activar({ ticketId });
    expect(r.status).toBe(201);
    expect(r.body).toEqual({
      id: expect.any(String),
      codigo: expect.stringMatching(/^DER-\d{6}$/),
      estado: 'activo',
      requiereNotificacionMae: false,
    });
    // quien activa no ve la bandeja ni el detalle
    expect((await t.http().get('/api/qhse/derrames').set(operador())).status).toBe(403);
    expect((await t.http().get(`/api/qhse/derrames/${r.body.id}`).set(operador())).status).toBe(
      403,
    );

    const d = (await t.http().get(`/api/qhse/derrames/${r.body.id}`).set(tecnico())).body;
    expect(d).toMatchObject({
      estado: 'activo',
      ubicacion: { codigo: 'geomembrana' },
      banda: { codigo: 'menor', porConfirmar: true },
      requiereNotificacionMae: false,
      escalaAEmergencia: false,
      ticketId,
      pedidoCodigo: `PED-DER${n}`,
      cliente: 'Cliente Derrames',
      activadoPor: OPERADOR.nombre,
    });
    expect(d.historial).toHaveLength(1);

    const ev = await eventos('qhse.derrame.activado', r.body.id);
    expect(ev).toHaveLength(1);
    expect(ev[0].datos.source).toBe('qhse');
    expect(ev[0].datos.actor?.userId).toBe(OPERADOR.id);
    expect(ev[0].datos.data).toMatchObject({
      derrameId: r.body.id,
      ticketId,
      ubicacion: 'geomembrana',
      banda: 'menor',
      requiereNotificacionMae: false,
      activadoPor: OPERADOR.nombre,
    });
  });

  it('la notificación al MAE y la escalada salen de las columnas de la banda y de la ubicación, no de los nombres', async () => {
    const casos: Array<[string, string, boolean, boolean]> = [
      // ubicación, banda, exige MAE, escala a emergencia
      ['geomembrana', 'menor', false, false],
      ['suelo', 'moderado', false, false],
      ['suelo', 'mayor', true, true],
      ['cuerpo_agua', 'menor', true, true], // en cuerpo de agua, con cualquier volumen
      ['geomembrana', 'mayor', true, true],
    ];
    for (const [u, b, mae, escala] of casos) {
      const r = await activar({ ubicacionId: ubicacion(u), bandaId: banda(b) });
      expect(r.status).toBe(201);
      expect(r.body.requiereNotificacionMae).toBe(mae);
      const d = (await t.http().get(`/api/qhse/derrames/${r.body.id}`).set(tecnico())).body;
      expect([d.requiereNotificacionMae, d.escalaAEmergencia]).toEqual([mae, escala]);
      expect((await eventos('qhse.derrame.activado', r.body.id))[0].datos.data).toMatchObject({
        requiereNotificacionMae: mae,
        escalaAEmergencia: escala,
      });
    }
  });

  it('el servicio rechaza lo incompleto con mensajes claros', async () => {
    const sinDescripcion = await activar({ descripcion: '   ' });
    expect(sinDescripcion.status).toBe(400);
    expect(sinDescripcion.body.detail).toMatch(/Describa qué se derramó/);
    expect((await activar({ ubicacionId: uuidv7() })).status).toBe(400);
    expect((await activar({ bandaId: uuidv7() })).status).toBe(400);
    const sinTicket = await activar({ ticketId: uuidv7() });
    expect(sinTicket.status).toBe(400);
    expect(sinTicket.body.detail).toMatch(/no conoce ese ticket/);
    expect((await activar({ ubicacionId: 'no-es-uuid' })).status).toBe(400);
    // sin permiso de reportar no se activa
    const sinPermiso = t.token('operador', OPERADOR.nombre, [], OPERADOR.id);
    expect((await activar({}, sinPermiso)).status).toBe(403);
  });

  it('la bandeja filtra por estado, ticket y texto', async () => {
    const ticketId = await ticketNuevo();
    const a = await activar({ ticketId, descripcion: 'Derrame distintivo ZETA' });
    const lista = (await t.http().get('/api/qhse/derrames').set(tecnico())).body as Array<{
      id: string;
      ticketNumero: number | null;
    }>;
    expect(lista.find((x) => x.id === a.body.id)?.ticketNumero).toEqual(expect.any(Number));
    const porTicket = (await t.http().get(`/api/qhse/derrames?ticketId=${ticketId}`).set(tecnico()))
      .body as Array<{ id: string }>;
    expect(porTicket.map((x) => x.id)).toEqual([a.body.id]);
    const porTexto = (await t.http().get('/api/qhse/derrames?q=distintivo zeta').set(tecnico()))
      .body as Array<{ id: string }>;
    expect(porTexto.map((x) => x.id)).toEqual([a.body.id]);
    const cerrados = (await t.http().get('/api/qhse/derrames?estado=cerrado').set(tecnico()))
      .body as Array<{ id: string }>;
    expect(cerrados.some((x) => x.id === a.body.id)).toBe(false);
    expect((await t.http().get('/api/qhse/derrames?estado=otro').set(tecnico())).status).toBe(400);
  });

  describe('contención y volumen real', () => {
    const gestor = () =>
      t.token(
        'tecnico_hse',
        TECNICO.nombre,
        [P.QHSE_REPORTAR, P.DERRAMES_VER, P.DERRAMES_GESTIONAR],
        TECNICO.id,
      );
    const detalle = async (id: string) =>
      (await t.http().get(`/api/qhse/derrames/${id}`).set(tecnico())).body;
    const paso = (id: string, itemId: string, quien = gestor()) =>
      t.http().post(`/api/qhse/derrames/${id}/checklist`).set(quien).send({ itemId });
    const contener = (id: string, quien = gestor()) =>
      t.http().post(`/api/qhse/derrames/${id}/contener`).set(quien);
    const volumen = (id: string, barriles: unknown, quien = gestor()) =>
      t.http().post(`/api/qhse/derrames/${id}/volumen`).set(quien).send({ barriles });
    const confirmarTodo = async (id: string) => {
      for (const c of (await detalle(id)).checklist as Array<{
        itemId: string;
        confirmadoAt: string | null;
      }>)
        if (!c.confirmadoAt) expect((await paso(id, c.itemId)).status).toBe(201);
    };

    it('el checklist trae los 5 pasos de la contención y solo con todos confirmados se marca contenido', async () => {
      const id = (await activar()).body.id as string;
      const d0 = await detalle(id);
      expect(d0.checklist.map((c: { codigo: string }) => c.codigo)).toEqual([
        'detener_fuente',
        'delimitar_area',
        'evitar_drenajes',
        'usar_epp',
        'notificar_qhse',
      ]);
      expect(d0.checklistCompleto).toBe(false);
      // permisos: quien solo ve o solo reporta no gestiona
      expect((await paso(id, d0.checklist[0].itemId, tecnico())).status).toBe(403);
      expect((await paso(id, d0.checklist[0].itemId, operador())).status).toBe(403);
      // sin todos los pasos no se contiene, y el servicio dice cuál falta
      const antes = await contener(id);
      expect(antes.status).toBe(409);
      expect(antes.body.detail).toMatch(/confirme todo el checklist.*Detener la fuente/s);

      expect((await paso(id, d0.checklist[0].itemId)).status).toBe(201);
      expect((await paso(id, d0.checklist[0].itemId)).status).toBe(409); // ya confirmado
      expect((await paso(id, uuidv7())).status).toBe(400); // no es un paso
      expect((await contener(id)).status).toBe(409);

      await confirmarTodo(id); // el primero ya estaba: se confirman los demás
      const d1 = await detalle(id);
      expect(d1.checklistCompleto).toBe(true);
      expect(d1.checklist[0]).toMatchObject({ confirmadoPor: TECNICO.nombre });
      expect(d1.estado).toBe('activo');

      const r = await contener(id);
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({ estado: 'contenido', contenidoPor: TECNICO.nombre });
      expect(r.body.contencionMinutos).toEqual(expect.any(Number));
      expect(r.body.historial.map((h: { estado: string }) => h.estado)).toEqual([
        'activo',
        'contenido',
      ]);
      const ev = await eventos('qhse.derrame.contenido', id);
      expect(ev).toHaveLength(1);
      expect(ev[0].datos.data).toMatchObject({ estado: 'contenido', plazoMinutos: 5 });
      // ya contenido: no se confirman más pasos ni se contiene otra vez
      expect((await contener(id)).status).toBe(409);
      expect((await paso(id, d0.checklist[1].itemId)).status).toBe(409);
    });

    it('el plazo de 5 minutos se informa pero no bloquea: contener tarde también se puede', async () => {
      const id = (await activar()).body.id as string;
      // la alerta se activó hace 20 minutos (se atrasa directo en la base)
      await sql(
        "UPDATE qhse.derrame SET activado_at = now() - interval '20 minutes' WHERE id = $1",
        [id],
      );
      await confirmarTodo(id);
      const tarde = (await contener(id)).body;
      expect(tarde.estado).toBe('contenido');
      expect(tarde.contencionEnPlazo).toBe(false);
      expect(tarde.contencionMinutos).toBeGreaterThanOrEqual(19);
      expect((await eventos('qhse.derrame.contenido', id))[0].datos.data).toMatchObject({
        contencionEnPlazo: false,
      });

      const rapido = (await activar()).body.id as string;
      await confirmarTodo(rapido);
      const enPlazo = (await contener(rapido)).body;
      expect(enPlazo.contencionEnPlazo).toBe(true);
      expect(enPlazo.contencionMinutos).toBeLessThan(5);
    });

    it('el volumen real se confirma solo después de contener, se puede corregir hasta cerrar y deja historial', async () => {
      const id = (await activar()).body.id as string;
      // activo: todavía no
      const temprano = await volumen(id, 0.5);
      expect(temprano.status).toBe(409);
      expect(temprano.body.detail).toMatch(/después de contener/);
      await confirmarTodo(id);
      await contener(id);

      expect((await volumen(id, 0.5, tecnico())).status).toBe(403);
      expect((await volumen(id, -1)).status).toBe(400);
      expect((await volumen(id, 'mucho')).status).toBe(400);
      expect((await volumen(id, 99_999_999)).status).toBe(400);

      const r = await volumen(id, 0.5);
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({
        volumenRealBarriles: 0.5,
        volumenConfirmadoPor: TECNICO.nombre,
        bandaReal: { codigo: 'menor' },
        requiereNotificacionMae: false,
      });
      // corrección: ahora cae en la banda mayor y exige notificar al MAE y escalar, aunque se reportó «menor»
      const mayor = await volumen(id, 7.25);
      expect(mayor.body).toMatchObject({
        volumenRealBarriles: 7.25,
        bandaReal: { codigo: 'mayor' },
        banda: { codigo: 'menor' },
        requiereNotificacionMae: true,
        escalaAEmergencia: true,
      });
      expect(mayor.body.volumenes.map((v: { barriles: number }) => v.barriles)).toEqual([
        0.5, 7.25,
      ]);
      const ev = await eventos('qhse.derrame.volumen_confirmado', id);
      expect(ev).toHaveLength(2);
      expect(ev[1].datos.data).toMatchObject({
        volumenConfirmadoBarriles: 7.25,
        bandaReal: 'mayor',
        requiereNotificacionMae: true,
        escalaAEmergencia: true,
      });
      // la bandeja también lo refleja
      const fila = (
        (await t.http().get('/api/qhse/derrames?estado=contenido').set(tecnico())).body as Array<{
          id: string;
          requiereNotificacionMae: boolean;
          volumenRealBarriles: number | null;
        }>
      ).find((x) => x.id === id);
      expect(fila).toMatchObject({ requiereNotificacionMae: true, volumenRealBarriles: 7.25 });
    });
  });

  describe('reglas de la base', () => {
    const insertarContenido = async () => {
      const id = (await activar()).body.id as string;
      await sql(
        'INSERT INTO qhse.derrame_checklist_confirmacion (derrame_id, item_id, confirmado_por) SELECT $1, id, $2 FROM qhse.derrame_checklist_item WHERE activo',
        [id, OPERADOR.id],
      );
      await sql(
        "UPDATE qhse.derrame SET estado = 'contenido', contenido_at = now(), contenido_por = $2 WHERE id = $1",
        [id, OPERADOR.id],
      );
      return id;
    };

    it('contener exige todo el checklist, y cada estado trae sus datos de contención', async () => {
      const id = (await activar()).body.id as string;
      await expect(
        sql(
          "UPDATE qhse.derrame SET estado = 'contenido', contenido_at = now(), contenido_por = $2 WHERE id = $1",
          [id, OPERADOR.id],
        ),
      ).rejects.toThrow(/confirmar todo el checklist de contención/);
      // contenido sin quién ni cuándo, o activo con datos de contención, no se acepta
      await sql(
        'INSERT INTO qhse.derrame_checklist_confirmacion (derrame_id, item_id, confirmado_por) SELECT $1, id, $2 FROM qhse.derrame_checklist_item WHERE activo',
        [id, OPERADOR.id],
      );
      await expect(
        sql("UPDATE qhse.derrame SET estado = 'contenido' WHERE id = $1", [id]),
      ).rejects.toThrow(/derrame_contencion_check/);
      await expect(
        sql('UPDATE qhse.derrame SET contenido_at = now(), contenido_por = $2 WHERE id = $1', [
          id,
          OPERADOR.id,
        ]),
      ).rejects.toThrow(/derrame_contencion_check/);
    });

    it('los pasos se confirman con el derrame activo, una sola vez, y no se editan ni se borran', async () => {
      const id = await insertarContenido();
      const item = (await sql('SELECT id FROM qhse.derrame_checklist_item LIMIT 1')).rows[0].id;
      await expect(
        sql(
          'INSERT INTO qhse.derrame_checklist_confirmacion (derrame_id, item_id, confirmado_por) VALUES ($1, $2, $3)',
          [id, item, OPERADOR.id],
        ),
      ).rejects.toThrow(/derrame_checklist_confirmacion_pkey|con el derrame activo/);
      await expect(
        t.prisma.derrameChecklistConfirmacion.deleteMany({ where: { derrameId: id } }),
      ).rejects.toThrow(/permission denied|denegado/i);
      await expect(
        t.prisma.derrameChecklistConfirmacion.updateMany({
          where: { derrameId: id },
          data: { confirmadoPor: TECNICO.id },
        }),
      ).rejects.toThrow(/permission denied|denegado/i);
      const activo = (await activar()).body.id as string;
      await expect(
        sql(
          'INSERT INTO qhse.derrame_checklist_confirmacion (derrame_id, item_id, confirmado_por) VALUES ($1, $2, $3), ($1, $2, $3)',
          [activo, item, OPERADOR.id],
        ),
      ).rejects.toThrow(/derrame_checklist_confirmacion_pkey/);
    });

    it('el volumen real: completo, sin negativos, después de contener, y su historial es inmutable', async () => {
      const activo = (await activar()).body.id as string;
      await expect(
        sql(
          'UPDATE qhse.derrame SET volumen_real_barriles = 2, volumen_confirmado_por = $2, volumen_confirmado_at = now() WHERE id = $1',
          [activo, OPERADOR.id],
        ),
      ).rejects.toThrow(/derrame_volumen_check/);
      await expect(
        sql(
          'INSERT INTO qhse.derrame_volumen_historial (id, derrame_id, volumen_barriles, actor_id) VALUES ($1, $2, 1, $3)',
          [uuidv7(), activo, OPERADOR.id],
        ),
      ).rejects.toThrow(/volumen real se confirma con el derrame contenido/);

      const id = await insertarContenido();
      await expect(
        sql('UPDATE qhse.derrame SET volumen_real_barriles = 2 WHERE id = $1', [id]),
      ).rejects.toThrow(/derrame_volumen_check/); // falta quién y cuándo
      await expect(
        sql(
          'UPDATE qhse.derrame SET volumen_real_barriles = -1, volumen_confirmado_por = $2, volumen_confirmado_at = now() WHERE id = $1',
          [id, OPERADOR.id],
        ),
      ).rejects.toThrow(/derrame_volumen_check/);
      await expect(
        sql(
          'INSERT INTO qhse.derrame_volumen_historial (id, derrame_id, volumen_barriles, actor_id) VALUES ($1, $2, -3, $3)',
          [uuidv7(), id, OPERADOR.id],
        ),
      ).rejects.toThrow(/derrame_volumen_historial_volumen_check/);
      await sql(
        'INSERT INTO qhse.derrame_volumen_historial (id, derrame_id, volumen_barriles, actor_id) VALUES ($1, $2, 2, $3)',
        [uuidv7(), id, OPERADOR.id],
      );
      await expect(
        t.prisma.derrameVolumenHistorial.deleteMany({ where: { derrameId: id } }),
      ).rejects.toThrow(/permission denied|denegado/i);
      await expect(
        t.prisma.derrameVolumenHistorial.updateMany({
          where: { derrameId: id },
          data: { volumenBarriles: 9 },
        }),
      ).rejects.toThrow(/permission denied|denegado/i);
    });

    const insertar = (extra: { estado?: string; ticket?: string | null } = {}) => {
      const id = uuidv7();
      return {
        id,
        texto: `INSERT INTO qhse.derrame (id, estado, ubicacion_id, banda_id, descripcion, ticket_id, activado_por, created_by)
                VALUES ($1, $2::qhse.estado_derrame, $3, $4, $5, $6, $7, $7)`,
        params: [
          id,
          extra.estado ?? 'activo',
          ubicacion('suelo'),
          banda('menor'),
          'Prueba',
          extra.ticket ?? null,
          OPERADOR.id,
        ],
      };
    };

    it('nace activo, no se salta de estado y lo reportado no se reescribe ni se borra', async () => {
      const nace = insertar({ estado: 'cerrado' });
      await expect(sql(nace.texto, nace.params)).rejects.toThrow(/nace activo/);

      const id = (await activar()).body.id as string;
      await expect(
        sql("UPDATE qhse.derrame SET estado = 'cerrado' WHERE id = $1", [id]),
      ).rejects.toThrow(/Cambio de estado no permitido/);
      await sql(
        'INSERT INTO qhse.derrame_checklist_confirmacion (derrame_id, item_id, confirmado_por) SELECT $1, id, $2 FROM qhse.derrame_checklist_item WHERE activo',
        [id, OPERADOR.id],
      );
      await sql(
        "UPDATE qhse.derrame SET estado = 'contenido', contenido_at = now(), contenido_por = $2 WHERE id = $1",
        [id, OPERADOR.id],
      );
      await expect(
        sql("UPDATE qhse.derrame SET estado = 'activo' WHERE id = $1", [id]),
      ).rejects.toThrow(/Cambio de estado no permitido/);

      await expect(
        t.prisma.derrame.update({ where: { id }, data: { descripcion: 'otra cosa' } }),
      ).rejects.toThrow(/permission denied|denegado/i);
      await expect(
        t.prisma.derrame.update({ where: { id }, data: { bandaId: banda('mayor') } }),
      ).rejects.toThrow(/permission denied|denegado/i);
      await expect(t.prisma.derrame.delete({ where: { id } })).rejects.toThrow(
        /permission denied|denegado/i,
      );
      await expect(
        t.prisma.derrameHistorial.deleteMany({ where: { derrameId: id } }),
      ).rejects.toThrow(/permission denied|denegado/i);
      await expect(
        t.prisma.derrameHistorial.updateMany({
          where: { derrameId: id },
          data: { actorId: TECNICO.id },
        }),
      ).rejects.toThrow(/permission denied|denegado/i);
    });

    it('la descripción no puede estar vacía y el ticket, la ubicación y la banda deben existir (FK)', async () => {
      const vacia = insertar();
      vacia.params[4] = '   ';
      await expect(sql(vacia.texto, vacia.params)).rejects.toThrow(/derrame_descripcion_check/);
      const ticket = insertar({ ticket: uuidv7() });
      await expect(sql(ticket.texto, ticket.params)).rejects.toThrow(/derrame_ticket_fkey/);
      const u = insertar();
      u.params[2] = uuidv7();
      await expect(sql(u.texto, u.params)).rejects.toThrow(/derrame_ubicacion_fkey/);
      const b = insertar();
      b.params[3] = uuidv7();
      await expect(sql(b.texto, b.params)).rejects.toThrow(/derrame_banda_fkey/);
    });

    it('las bandas de volumen activas no se solapan y su rango debe ser válido', async () => {
      const banda = (codigo: string, desde: number, hasta: number | null, activo = true) =>
        sql(
          `INSERT INTO qhse.derrame_banda_volumen (id, codigo, nombre, orden, desde_barriles, hasta_barriles, activo)
           VALUES ($1, $2, 'prueba', $3, $4, $5, $6)`,
          [
            uuidv7(),
            `tmp-${n}-${codigo}`,
            900 + Math.floor(Math.random() * 90_000),
            desde,
            hasta,
            activo,
          ],
        );
      await expect(banda('a', 0.5, 2)).rejects.toThrow(/derrame_banda_volumen_sin_solape/);
      await expect(banda('b', 7, null)).rejects.toThrow(/derrame_banda_volumen_sin_solape/);
      await expect(banda('c', 3, 3, false)).rejects.toThrow(/derrame_banda_volumen_rango_check/);
      await expect(banda('d', -1, 2, false)).rejects.toThrow(/derrame_banda_volumen_rango_check/);
      // una banda inactiva puede coincidir con las activas (queda de historial)
      await banda('e', 0.5, 2, false);
      await sql('DELETE FROM qhse.derrame_banda_volumen WHERE codigo = $1', [`tmp-${n}-e`]);
    });
  });
});
