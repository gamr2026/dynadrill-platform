/**
 * Integración real de QHSE: matriz IPERC maestra (versionada, vigencia de 12 meses, cobertura) y su efecto en el PTW, con las reglas de la
 * base. Requiere haber corrido `npm run db:seed:archivos` (módulo de archivos de la matriz).
 *   RUN_INTEGRATION=1 npx jest iperc   (dentro de libs/qhse/seguridad)
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
const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Guayaquil' });
const masDias = (dia: string, dias: number) =>
  new Date(Date.parse(`${dia}T00:00:00Z`) + dias * 86_400_000).toISOString().slice(0, 10);

run('QHSE: matriz IPERC maestra y PTW (base de datos real)', () => {
  jest.setTimeout(180000);
  let t: AppDePrueba;
  let moduloIperc = '';
  let moduloDoc = '';
  let procesoId = '';
  let zonaId = '';
  let clasifId = '';
  const actividades: string[] = [];
  const pedidos: string[] = [];
  const tickets: string[] = [];
  const archivos: string[] = [];

  const hse = () =>
    t.token(
      'tecnico_hse',
      TECNICO.nombre,
      [
        P.IPERC_VER,
        P.IPERC_GESTIONAR,
        P.PTW_VER,
        P.PTW_GESTIONAR,
        P.DOCUMENTOS_VER,
        P.DOCUMENTOS_GESTIONAR,
      ],
      TECNICO.id,
    );
  const gerente = () =>
    t.token(
      'gerente_hse',
      GERENTE.nombre,
      [P.IPERC_VER, P.IPERC_GESTIONAR, P.IPERC_APROBAR],
      GERENTE.id,
    );
  const supervisor = () =>
    t.token('supervisor', SUPERVISOR.nombre, [P.ACTA_ENTREGA_VER], SUPERVISOR.id);
  const sql = (texto: string, params: unknown[] = []) => t.admin.query(texto, params);

  const archivo = async (modulo: string) => {
    const id = uuidv7();
    archivos.push(id);
    await sql(
      `INSERT INTO archivos.archivo (id, modulo_id, nombre_original, mime_type, tamano_bytes, sha256, blob_key, escaneo, subido_por)
       VALUES ($1, $2, 'doc.pdf', 'application/pdf', 10, $3, $4, 'omitido', $5)`,
      [id, modulo, id.replace(/-/g, '').padEnd(64, '0'), `qhse-iperc/${n}/${id}`, TECNICO.id],
    );
    return id;
  };
  const peligro = (completo = true) => ({
    descripcion: '4.6 Exposición a gases y vapores',
    clasificacionId: clasifId,
    fuenteRiesgo: 'Pintura y solventes',
    requisitoLegal: true,
    ...(completo ? { inicial: { nd: 2, ne: 3, nc: 25 }, residual: { nd: 2, ne: 2, nc: 10 } } : {}),
    controles: [
      { momento: 'propuesto', tipo: 'epp', descripcion: 'Uso de máscara' },
      { momento: 'residual', tipo: 'administrativo', descripcion: 'MSDS disponibles' },
    ],
  });
  const contenido = (completo = true) => ({
    tareas: [
      {
        descripcion: 'Preparar la superficie',
        rutinaria: true,
        areaPuesto: 'Taller',
        peligros: [peligro(completo)],
      },
    ],
    evaluadorIds: [TECNICO.id],
  });

  const nuevaActividad = async (nombre = `Actividad IT${n}-${actividades.length}`) => {
    const r = await t
      .http()
      .post('/api/qhse/iperc/actividades')
      .set(hse())
      .send({ procesoId, zonaId, nombre });
    expect(r.status).toBe(201);
    const act = (await t.prisma.ipercMatriz.findUniqueOrThrow({ where: { id: r.body.id } }))
      .actividadId;
    actividades.push(act);
    return { actividadId: act, matrizId: r.body.id as string };
  };
  const post = (ruta: string, cuerpo: Record<string, unknown> = {}, quien = hse()) =>
    t.http().post(`/api/qhse/iperc/${ruta}`).set(quien).send(cuerpo);
  /** Lleva una matriz hasta «en revisión» con adjuntos, lista para aprobar. */
  const hastaRevision = async (matrizId: string, completo = true) => {
    expect(
      (
        await t
          .http()
          .put(`/api/qhse/iperc/matrices/${matrizId}/contenido`)
          .set(hse())
          .send(contenido(completo))
      ).status,
    ).toBe(200);
    expect((await post(`matrices/${matrizId}/iniciar-evaluacion`)).status).toBe(201);
    expect(
      (
        await post(`matrices/${matrizId}/adjuntos`, {
          tipo: 'procedimiento',
          archivoId: await archivo(moduloIperc),
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await post(`matrices/${matrizId}/adjuntos`, {
          tipo: 'ats',
          archivoId: await archivo(moduloIperc),
        })
      ).status,
    ).toBe(201);
    return post(`matrices/${matrizId}/enviar-revision`);
  };
  const eventos = async (tipo: string, matrizId: string) =>
    (
      await sql(
        "SELECT datos FROM msg_qhse.outbox WHERE tipo = $1 AND datos->'data'->>'matrizId' = $2 ORDER BY ocurrido_at, id",
        [tipo, matrizId],
      )
    ).rows as Salida[];
  const aprobada = async () => {
    const { actividadId, matrizId } = await nuevaActividad();
    expect((await hastaRevision(matrizId)).status).toBe(201);
    expect((await post(`matrices/${matrizId}/aprobar`, {}, gerente())).status).toBe(201);
    return { actividadId, matrizId };
  };

  beforeAll(async () => {
    t = await levantarAppDePrueba('3198');
    await sembrarMaestros(t.admin, MAESTROS);
    const m = await sql(
      "SELECT id, codigo FROM archivos.modulo_archivo WHERE codigo IN ('qhse_iperc_documento', 'qhse_documento_pedido')",
    );
    for (const f of m.rows as Array<{ id: string; codigo: string }>) {
      if (f.codigo === 'qhse_iperc_documento') moduloIperc = f.id;
      else moduloDoc = f.id;
    }
    expect(moduloIperc && moduloDoc).toBeTruthy();
    procesoId =
      (await sql('SELECT id FROM qhse.iperc_proceso ORDER BY orden LIMIT 1')).rows[0]?.id ?? '';
    zonaId = (await sql('SELECT id FROM qhse.iperc_zona ORDER BY orden LIMIT 1')).rows[0]?.id ?? '';
    clasifId =
      (await sql('SELECT id FROM qhse.iperc_clasificacion_peligro ORDER BY orden LIMIT 1')).rows[0]
        ?.id ?? '';
    // si falta, correr: npm run db:cargar:iperc
    expect(procesoId && zonaId && clasifId).toBeTruthy();
  });

  afterAll(async () => {
    await sql('DELETE FROM qhse.ptw WHERE pedido_id = ANY($1::uuid[])', [pedidos]);
    await sql('DELETE FROM qhse.documento_pedido WHERE pedido_id = ANY($1::uuid[])', [pedidos]);
    await sql('DELETE FROM qhse.ticket_ref WHERE ticket_id = ANY($1::uuid[])', [tickets]);
    await sql('DELETE FROM qhse.iperc_cobertura WHERE tipo_servicio_codigo LIKE $1', [`it${n}_%`]);
    // los triggers de contenido impiden tocar matrices aprobadas: para limpiar se desactivan un momento (dueño de las tablas)
    const tablas = [
      'iperc_matriz',
      'iperc_tarea',
      'iperc_peligro',
      'iperc_control',
      'iperc_tarea_cargo',
      'iperc_matriz_evaluador',
    ];
    for (const tb of tablas) await sql(`ALTER TABLE qhse.${tb} DISABLE TRIGGER USER`);
    await sql('DELETE FROM qhse.iperc_matriz WHERE actividad_id = ANY($1::uuid[])', [actividades]);
    await sql('DELETE FROM qhse.iperc_actividad WHERE id = ANY($1::uuid[])', [actividades]);
    for (const tb of tablas) await sql(`ALTER TABLE qhse.${tb} ENABLE TRIGGER USER`);
    await sql("DELETE FROM msg_qhse.outbox WHERE datos->'data'->>'actividad' LIKE $1", [
      `Actividad IT${n}%`,
    ]);
    await sql('DELETE FROM archivos.archivo WHERE id = ANY($1::uuid[])', [archivos]);
    await quitarMaestros(t.admin, MAESTROS);
    await t.cerrar();
  });

  // ------------------------------------------------------------------------------------------------------ ciclo y vigencia

  it('ciclo completo: contenido, evaluación, adjuntos, revisión y aprobación con 12 meses de vigencia y valoración GTC 45 calculada', async () => {
    const { matrizId } = await nuevaActividad();
    expect(
      (await t.http().get(`/api/qhse/iperc/matrices/${matrizId}`).set(hse())).body,
    ).toMatchObject({ estado: 'borrador', version: 1 });
    const guardada = await t
      .http()
      .put(`/api/qhse/iperc/matrices/${matrizId}/contenido`)
      .set(hse())
      .send(contenido());
    expect(guardada.status).toBe(200);
    const p = guardada.body.tareas[0].peligros[0];
    expect(p.inicial).toMatchObject({
      nd: 2,
      ne: 3,
      nc: 25,
      np: 6,
      probabilidad: 'medio',
      nr: 150,
      nivel: 'II',
    });
    expect(p.residual).toMatchObject({ np: 4, nr: 40, nivel: 'III', aceptabilidad: 'Mejorable' });
    expect(guardada.body.equipoEvaluador).toEqual([{ id: TECNICO.id, nombre: TECNICO.nombre }]);

    expect((await post(`matrices/${matrizId}/enviar-revision`)).status).toBe(409); // aún en borrador
    expect((await post(`matrices/${matrizId}/iniciar-evaluacion`)).status).toBe(201);
    // sin adjuntos puede ir a revisión, pero no se aprueba
    expect((await post(`matrices/${matrizId}/enviar-revision`)).status).toBe(201);
    const sinAdjuntos = await post(`matrices/${matrizId}/aprobar`, {}, gerente());
    expect(sinAdjuntos.status).toBe(409);
    expect(sinAdjuntos.body.detail).toMatch(/adjunte el procedimiento y el ATS base/);
    // los adjuntos aún se cargan en revisión; el archivo debe venir del módulo correcto
    expect(
      (
        await post(`matrices/${matrizId}/adjuntos`, {
          tipo: 'ats',
          archivoId: await archivo(moduloDoc),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post(`matrices/${matrizId}/adjuntos`, {
          tipo: 'procedimiento',
          archivoId: await archivo(moduloIperc),
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await post(`matrices/${matrizId}/adjuntos`, {
          tipo: 'ats',
          archivoId: await archivo(moduloIperc),
        })
      ).status,
    ).toBe(201);

    // aprueba solo el Gerente HSE
    expect((await post(`matrices/${matrizId}/aprobar`, {}, hse())).status).toBe(403);
    const ok = await post(`matrices/${matrizId}/aprobar`, {}, gerente());
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({
      estado: 'aprobada',
      aprobadaPor: GERENTE.nombre,
      aprobadaEl: hoy,
      vencida: false,
      porVencer: false,
    });
    const [a, m, d] = hoy.split('-').map(Number);
    const esperado = new Date(Date.UTC(a + 1, m - 1, d));
    if (esperado.getUTCMonth() !== m - 1) esperado.setUTCDate(0);
    expect(ok.body.vigenteHasta).toBe(esperado.toISOString().slice(0, 10));
    expect(ok.body.historial.map((h: { estadoNuevo: string }) => h.estadoNuevo)).toEqual([
      'borrador',
      'en_evaluacion',
      'en_revision',
      'aprobada',
    ]);
    const ev = await eventos('qhse.iperc.aprobada', matrizId);
    expect(ev).toHaveLength(1);
    expect(ev[0].datos.data).toMatchObject({
      matrizId,
      version: 1,
      vigenteHasta: ok.body.vigenteHasta,
    });
    void d;
    // una aprobada ya no se edita ni se vuelve a aprobar
    expect(
      (
        await t
          .http()
          .put(`/api/qhse/iperc/matrices/${matrizId}/contenido`)
          .set(hse())
          .send(contenido())
      ).status,
    ).toBe(409);
    expect((await post(`matrices/${matrizId}/aprobar`, {}, gerente())).status).toBe(409);
  });

  it('no se envía a revisión con peligros sin valoración, y un rechazo se retoma con su motivo', async () => {
    const { matrizId } = await nuevaActividad();
    const r = await hastaRevision(matrizId, false);
    expect(r.status).toBe(409);
    expect(r.body.detail).toMatch(/faltan la valoración inicial o la residual de 1 peligro/);
    expect(
      (
        await t
          .http()
          .put(`/api/qhse/iperc/matrices/${matrizId}/contenido`)
          .set(hse())
          .send(contenido(true))
      ).status,
    ).toBe(200);
    expect((await post(`matrices/${matrizId}/enviar-revision`)).status).toBe(201);
    expect((await post(`matrices/${matrizId}/rechazar`, { motivo: '  ' }, gerente())).status).toBe(
      400,
    );
    const rech = await post(
      `matrices/${matrizId}/rechazar`,
      { motivo: 'Faltan controles de ingeniería' },
      gerente(),
    );
    expect(rech.status).toBe(201);
    expect(rech.body).toMatchObject({
      estado: 'rechazada',
      rechazadaPor: GERENTE.nombre,
      motivoRechazo: 'Faltan controles de ingeniería',
    });
    expect((await eventos('qhse.iperc.rechazada', matrizId))[0].datos.data).toMatchObject({
      motivo: 'Faltan controles de ingeniería',
    });
    const retomada = await post(`matrices/${matrizId}/iniciar-evaluacion`);
    expect(retomada.status).toBe(201);
    expect(retomada.body).toMatchObject({
      estado: 'en_evaluacion',
      rechazadaPor: null,
      motivoRechazo: null,
    });
  });

  it('revisión anual: la versión nueva se copia de la aprobada, una sola en trabajo, y al aprobarla la anterior queda reemplazada', async () => {
    const { actividadId, matrizId: v1 } = await aprobada();
    const nueva = await post(`actividades/${actividadId}/nueva-version`);
    expect(nueva.status).toBe(201);
    expect(nueva.body).toMatchObject({ version: 2, estado: 'borrador' });
    expect(nueva.body.tareas).toHaveLength(1);
    expect(nueva.body.tareas[0].peligros[0].controles).toHaveLength(2);
    expect((await post(`actividades/${actividadId}/nueva-version`)).status).toBe(409); // ya hay una en trabajo
    // mientras tanto la aprobada sigue valiendo
    const lista = await t
      .http()
      .get('/api/qhse/iperc/actividades')
      .query({ q: `IT${n}` })
      .set(hse());
    const fila = lista.body.find((x: { id: string }) => x.id === actividadId);
    expect(fila.aprobada).toMatchObject({ matrizId: v1, version: 1, vencida: false });
    expect(fila.enTrabajo).toMatchObject({
      matrizId: nueva.body.id,
      version: 2,
      estado: 'borrador',
    });

    const v2 = nueva.body.id as string;
    expect((await hastaRevision(v2)).status).toBe(201);
    expect((await post(`matrices/${v2}/aprobar`, {}, gerente())).status).toBe(201);
    expect((await t.http().get(`/api/qhse/iperc/matrices/${v1}`).set(hse())).body.estado).toBe(
      'reemplazada',
    );
    const versiones = await t
      .http()
      .get(`/api/qhse/iperc/actividades/${actividadId}/versiones`)
      .set(hse());
    expect(
      versiones.body.map((v: { version: number; estado: string }) => [v.version, v.estado]),
    ).toEqual([
      [2, 'aprobada'],
      [1, 'reemplazada'],
    ]);
    // y se puede iniciar otra revisión desde la nueva
    expect((await post(`actividades/${actividadId}/nueva-version`)).status).toBe(201);
  });

  it('catálogos sin duplicados: un proceso escrito de otra forma devuelve el existente; el Supervisor no entra', async () => {
    const cat = (await t.http().get('/api/qhse/iperc/catalogos').set(hse())).body;
    expect(cat.procesos.length).toBeGreaterThan(0);
    const existente = cat.procesos[0];
    const igual = await t
      .http()
      .post('/api/qhse/iperc/catalogos/proceso')
      .set(hse())
      .send({ nombre: `  ${existente.nombre.toUpperCase()}  ` });
    expect(igual.body.id).toBe(existente.id);
    const nuevo = await t
      .http()
      .post('/api/qhse/iperc/catalogos/cargo')
      .set(hse())
      .send({ nombre: `Cargo IT${n}` });
    const otra = await t
      .http()
      .post('/api/qhse/iperc/catalogos/cargo')
      .set(hse())
      .send({ nombre: `cargo it${n}` });
    expect(otra.body.id).toBe(nuevo.body.id);
    expect(
      (
        await t
          .http()
          .post('/api/qhse/iperc/catalogos/inexistente')
          .set(hse())
          .send({ nombre: 'x' })
      ).status,
    ).toBe(400);
    expect((await t.http().get('/api/qhse/iperc/actividades').set(supervisor())).status).toBe(403);
    // una actividad repetida (mismo proceso, zona y nombre, sin importar mayúsculas) se rechaza
    const { actividadId } = await nuevaActividad(`Actividad IT${n}-repetida`);
    void actividadId;
    expect(
      (
        await t
          .http()
          .post('/api/qhse/iperc/actividades')
          .set(hse())
          .send({ procesoId, zonaId, nombre: `ACTIVIDAD IT${n}-REPETIDA` })
      ).status,
    ).toBe(409);
    await sql('DELETE FROM qhse.iperc_cargo WHERE nombre ILIKE $1', [`cargo it${n}`]);
  });

  // ------------------------------------------------------------------------------------ cobertura y efecto en el PTW

  describe('PTW exige las matrices IPERC aprobadas y vigentes de su cobertura', () => {
    const tipoCodigo = `it${n}_slickline`;
    const ticketConServicio = async () => {
      const ticketId = uuidv7();
      const pedidoId = uuidv7();
      tickets.push(ticketId);
      pedidos.push(pedidoId);
      await t.prisma.ticketRef.create({
        data: {
          ticketId,
          pedidoId,
          pedidoCodigo: `PED-IP${n}`,
          ticketNumero: 980_000 + pedidos.length,
        },
      });
      await t.prisma.ticketServicio.create({ data: { ticketId, tipoCodigo } });
      return { ticketId, pedidoId };
    };
    const doc = async (pedidoId: string, cuerpo: Record<string, unknown>) => {
      const id = uuidv7();
      archivos.push(id);
      await sql(
        `INSERT INTO archivos.archivo (id, modulo_id, nombre_original, mime_type, tamano_bytes, sha256, blob_key, escaneo, subido_por) VALUES ($1, $2, 'd.pdf', 'application/pdf', 10, $3, $4, 'omitido', $5)`,
        [id, moduloDoc, id.replace(/-/g, '').padEnd(64, '0'), `qhse-iperc/${n}/${id}`, TECNICO.id],
      );
      expect(
        (
          await t
            .http()
            .post('/api/qhse/documentos')
            .set(hse())
            .send({ pedidoId, archivoId: id, ...cuerpo })
        ).status,
      ).toBe(201);
    };
    const ptwListo = async (dia: string) => {
      const { ticketId, pedidoId } = await ticketConServicio();
      await doc(pedidoId, { tipo: 'formato_recepcion' });
      await doc(pedidoId, { tipo: 'sfi' });
      await doc(pedidoId, { tipo: 'art', fecha: masDias(dia, -2) });
      await doc(pedidoId, { tipo: 'pt', fecha: dia });
      const p = await t
        .http()
        .post('/api/qhse/ptw')
        .set(hse())
        .send({ ticketId, diaOperacion: dia });
      expect(p.status).toBe(201);
      return { ptwId: p.body.id as string, ticketId, pedidoId, abierto: p.body };
    };
    const fijarCobertura = (actividadIds: string[]) =>
      t.http().put(`/api/qhse/iperc/cobertura/${tipoCodigo}`).set(hse()).send({ actividadIds });

    it('un tipo de servicio sin cobertura no exige nada; con cobertura, una matriz sin aprobar bloquea y explica por qué', async () => {
      expect((await fijarCobertura([uuidv7()])).status).toBe(400);
      const sin = await ptwListo(hoy);
      expect(sin.abierto.matricesIperc).toEqual([]);
      expect(
        (await t.http().post(`/api/qhse/ptw/${sin.ptwId}/validar-documentos`).set(hse())).status,
      ).toBe(201);

      const { actividadId, matrizId } = await nuevaActividad();
      expect((await fijarCobertura([actividadId])).body[tipoCodigo]).toEqual([
        { id: actividadId, nombre: expect.stringContaining(`IT${n}`) },
      ]);
      const conCobertura = await ptwListo(masDias(hoy, 1));
      expect(conCobertura.abierto.matricesIperc[0]).toMatchObject({ actividadId, matrizId: null });
      expect(conCobertura.abierto.gabineteCompleta).toBe(false);
      const bloqueado = await t
        .http()
        .post(`/api/qhse/ptw/${conCobertura.ptwId}/validar-documentos`)
        .set(hse());
      expect(bloqueado.status).toBe(409);
      expect(bloqueado.body.detail).toMatch(/aún no está aprobada \(está borrador\)/);

      // aprobada: pasa y la matriz queda fijada en el PTW
      expect((await hastaRevision(matrizId)).status).toBe(201);
      expect((await post(`matrices/${matrizId}/aprobar`, {}, gerente())).status).toBe(201);
      const ok = await t
        .http()
        .post(`/api/qhse/ptw/${conCobertura.ptwId}/validar-documentos`)
        .set(hse());
      expect(ok.status).toBe(201);
      expect(ok.body.fase).toBe('formalizacion');
      expect(ok.body.matricesIperc).toEqual([
        expect.objectContaining({ actividadId, matrizId, falta: null }),
      ]);
      expect(await t.prisma.ptwMatriz.count({ where: { ptwId: conCobertura.ptwId } })).toBe(1);
    });

    it('el equipo de FCR consulta la cobertura IPERC de un ticket: qué actividades exige y si cada matriz está aprobada y vigente', async () => {
      const fcr = () =>
        t.token(
          'supervisor_operaciones_fcr',
          'Fabio FCR',
          [Permission.DOCUMENTOS_VER_TICKET],
          uuidv7(),
        );
      const consultar = (ticketId: string, dia = '', quien = fcr()) =>
        t
          .http()
          .get(`/api/qhse/iperc/tickets/${ticketId}${dia ? `?dia=${dia}` : ''}`)
          .set(quien);
      // un ticket que QHSE no conoce, o sin servicios con cobertura: no exige nada
      const desconocido = await consultar(uuidv7());
      expect(desconocido.status).toBe(200);
      expect(desconocido.body).toMatchObject({ requisitos: [], coberturaOk: true });

      const { actividadId, matrizId } = await nuevaActividad();
      expect((await fijarCobertura([actividadId])).status).toBe(200);
      const { ticketId } = await ticketConServicio();
      const sinAprobar = await consultar(ticketId);
      expect(sinAprobar.body).toMatchObject({ ticketId, dia: hoy, coberturaOk: false });
      expect(sinAprobar.body.requisitos[0]).toMatchObject({ actividadId, matrizId: null });
      expect(sinAprobar.body.requisitos[0].falta).toMatch(/aún no está aprobada/);

      expect((await hastaRevision(matrizId)).status).toBe(201);
      expect((await post(`matrices/${matrizId}/aprobar`, {}, gerente())).status).toBe(201);
      const aprobada = await consultar(ticketId);
      expect(aprobada.body.coberturaOk).toBe(true);
      expect(aprobada.body.requisitos[0]).toMatchObject({ actividadId, matrizId, falta: null });
      expect(aprobada.body.requisitos[0].vigenteHasta).toBeTruthy();

      // otro día: pasado el año de vigencia ya no cubre
      const vencida = await consultar(ticketId, masDias(hoy, 400));
      expect(vencida.body.coberturaOk).toBe(false);
      expect(vencida.body.requisitos[0].falta).toMatch(/vale hasta el/);

      // permisos y validación del día
      const sinPermiso = t.token(
        'operador',
        'Oscar Operador',
        [Permission.QHSE_REPORTAR],
        uuidv7(),
      );
      expect((await consultar(ticketId, '', sinPermiso)).status).toBe(403);
      expect((await consultar(ticketId, 'mañana')).status).toBe(400);
      expect((await consultar('no-es-uuid')).status).toBe(400);
    });

    it('una matriz vencida el día de operación bloquea (la vigencia es de 12 meses)', async () => {
      const { actividadId } = await aprobada();
      await fijarCobertura([actividadId]);
      const lejano = masDias(hoy, 400); // pasado el año de vigencia
      const p = await ptwListo(lejano);
      const r = await t.http().post(`/api/qhse/ptw/${p.ptwId}/validar-documentos`).set(hse());
      expect(r.status).toBe(409);
      expect(r.body.detail).toMatch(/vale hasta el .* y no cubre el .*una matriz vencida bloquea/);
    });

    it('reglas de la base: la matriz debe estar aprobada, vigente y ser de una actividad exigida; lo fijado no cambia', async () => {
      const { actividadId, matrizId } = await aprobada();
      await fijarCobertura([actividadId]);
      const p = await ptwListo(masDias(hoy, 2));
      const fijar = (id: string) =>
        t.prisma.ptwMatriz.create({ data: { ptwId: p.ptwId, matrizId: id } });
      // una matriz de una actividad que el servicio no exige
      const otra = await aprobada();
      await expect(fijar(otra.matrizId)).rejects.toThrow(/no la exige el tipo de servicio/);
      // una matriz sin aprobar
      const enBorrador = await nuevaActividad();
      await sql(
        'INSERT INTO qhse.iperc_cobertura (tipo_servicio_codigo, actividad_id, created_by) VALUES ($1, $2, $3)',
        [tipoCodigo, enBorrador.actividadId, TECNICO.id],
      );
      await expect(fijar(enBorrador.matrizId)).rejects.toThrow(/no está aprobada/);
      await sql('DELETE FROM qhse.iperc_cobertura WHERE actividad_id = $1', [
        enBorrador.actividadId,
      ]);
      // la válida entra; pasar a formalización exige TODAS las exigidas
      await fijar(matrizId);
      expect(
        (await t.http().post(`/api/qhse/ptw/${p.ptwId}/validar-documentos`).set(hse())).status,
      ).toBe(201);
      // ya en formalización: no se agregan ni se cambian matrices
      await expect(fijar(otra.matrizId)).rejects.toThrow(/en gabinete/);
      await expect(t.prisma.ptwMatriz.deleteMany({ where: { ptwId: p.ptwId } })).rejects.toThrow(
        /permission denied|denegado/i,
      );
    });

    it('al pasar de gabinete a formalización la base exige una matriz por actividad, aunque se salte el servicio', async () => {
      const { actividadId } = await aprobada();
      await fijarCobertura([actividadId]);
      const p = await ptwListo(masDias(hoy, 3));
      const docs = (
        await sql('SELECT id, tipo FROM qhse.documento_pedido WHERE pedido_id = $1', [p.pedidoId])
      ).rows as Array<{ id: string; tipo: string }>;
      const de = (tipo: string) => docs.find((d) => d.tipo === tipo)?.id;
      await expect(
        t.prisma.ptw.update({
          where: { id: p.ptwId },
          data: {
            fase: 'formalizacion',
            documentoRecepcionId: de('formato_recepcion'),
            documentoArtId: de('art'),
            documentoPtId: de('pt'),
            documentoSfiId: de('sfi'),
          },
        }),
      ).rejects.toThrow(/Falta la matriz IPERC aprobada y vigente de 1 actividad/);
    });
  });

  // --------------------------------------------------------------------------------------------- reglas de la base

  describe('reglas de la base de la matriz', () => {
    it('nace en borrador, una sola aprobada y una sola en trabajo por actividad, y las fechas de aprobación son coherentes', async () => {
      const { actividadId, matrizId } = await aprobada();
      const ins = (extra = '', ...p: unknown[]) =>
        sql(
          `INSERT INTO qhse.iperc_matriz (id, actividad_id, version, created_by ${extra ? ', ' + extra.split('|')[0] : ''}) VALUES ($1, $2, $3, $4 ${extra ? ', ' + extra.split('|')[1] : ''})`,
          [uuidv7(), actividadId, 50 + Math.floor(Math.random() * 1e6), TECNICO.id, ...p],
        );
      await expect(
        sql(
          "INSERT INTO qhse.iperc_matriz (id, actividad_id, version, created_by, estado) VALUES ($1, $2, 90, $3, 'aprobada')",
          [uuidv7(), actividadId, TECNICO.id],
        ),
      ).rejects.toThrow(/nace en borrador/);
      await ins(); // una versión en trabajo
      await expect(ins()).rejects.toThrow(/iperc_matriz_en_trabajo_key/);
      // la vigencia debe ser exactamente un año después de la aprobación
      await expect(
        sql('UPDATE qhse.iperc_matriz SET vigente_hasta = vigente_hasta + 1 WHERE id = $1', [
          matrizId,
        ]),
      ).rejects.toThrow(/iperc_matriz_vigencia_check|no se puede cambiar/);
    });

    it('lo aprobado es un documento firmado: no se edita, no se borra ni cambia su contenido', async () => {
      const { matrizId } = await aprobada();
      const tarea = await t.prisma.ipercTarea.findFirstOrThrow({ where: { matrizId } });
      await expect(
        t.prisma.ipercMatriz.update({ where: { id: matrizId }, data: { estado: 'borrador' } }),
      ).rejects.toThrow(/no se puede cambiar|iperc_matriz_aprobacion_check/);
      await expect(t.prisma.ipercMatriz.delete({ where: { id: matrizId } })).rejects.toThrow(
        /permission denied|denegado/i,
      );
      await expect(
        t.prisma.ipercTarea.update({ where: { id: tarea.id }, data: { descripcion: 'otra' } }),
      ).rejects.toThrow(/El contenido de la matriz no se puede cambiar/);
      await expect(t.prisma.ipercTarea.delete({ where: { id: tarea.id } })).rejects.toThrow(
        /El contenido de la matriz no se puede cambiar/,
      );
      await expect(
        t.prisma.ipercTarea.create({
          data: { id: uuidv7(), matrizId, orden: 99, descripcion: 'x' },
        }),
      ).rejects.toThrow(/El contenido de la matriz no se puede cambiar/);
      const peligroId = (
        await t.prisma.ipercPeligro.findFirstOrThrow({ where: { tareaId: tarea.id } })
      ).id;
      await expect(
        t.prisma.ipercControl.create({
          data: { id: uuidv7(), peligroId, momento: 'residual', tipo: 'epp', descripcion: 'x' },
        }),
      ).rejects.toThrow(/El contenido de la matriz no se puede cambiar/);
      await expect(t.prisma.ipercHistorial.deleteMany({ where: { matrizId } })).rejects.toThrow(
        /permission denied|denegado/i,
      );
    });

    it('los niveles son los oficiales de la GTC 45 y no se salta de estado', async () => {
      const { matrizId } = await nuevaActividad();
      await t
        .http()
        .put(`/api/qhse/iperc/matrices/${matrizId}/contenido`)
        .set(hse())
        .send(contenido());
      const peligroId = (
        await t.prisma.ipercPeligro.findFirstOrThrow({ where: { tarea: { matrizId } } })
      ).id;
      for (const [campo, valor] of [
        ['inicial_nd', 5],
        ['inicial_ne', 5],
        ['inicial_nc', 30],
        ['residual_nd', 3],
      ] as const) {
        await expect(
          sql(`UPDATE qhse.iperc_peligro SET ${campo} = $2 WHERE id = $1`, [peligroId, valor]),
        ).rejects.toThrow(/iperc_peligro_(inicial|residual)_check/);
      }
      await expect(
        sql('UPDATE qhse.iperc_peligro SET inicial_nd = NULL WHERE id = $1', [peligroId]),
      ).rejects.toThrow(/iperc_peligro_inicial_check/); // los tres o ninguno
      await expect(
        t.prisma.ipercMatriz.update({ where: { id: matrizId }, data: { estado: 'en_revision' } }),
      ).rejects.toThrow(/Cambio de estado no permitido/);
      await expect(
        t.prisma.ipercMatriz.update({ where: { id: matrizId }, data: { estado: 'aprobada' } }),
      ).rejects.toThrow(/Cambio de estado no permitido/);
    });

    it('el contenido solo se edita en borrador o evaluación y no se pasa a revisión con peligros sin valorar (también en la base)', async () => {
      const { matrizId } = await nuevaActividad();
      await t
        .http()
        .put(`/api/qhse/iperc/matrices/${matrizId}/contenido`)
        .set(hse())
        .send(contenido(false));
      await t.prisma.ipercMatriz.update({
        where: { id: matrizId },
        data: { estado: 'en_evaluacion' },
      });
      await expect(
        t.prisma.ipercMatriz.update({ where: { id: matrizId }, data: { estado: 'en_revision' } }),
      ).rejects.toThrow(/Faltan la valoración inicial o la residual de 1 peligro/);
      const vacia = await nuevaActividad();
      await t.prisma.ipercMatriz.update({
        where: { id: vacia.matrizId },
        data: { estado: 'en_evaluacion' },
      });
      await expect(
        t.prisma.ipercMatriz.update({
          where: { id: vacia.matrizId },
          data: { estado: 'en_revision' },
        }),
      ).rejects.toThrow(/La matriz no tiene tareas/);
    });
  });

  it('la carga del formato real dejó las actividades maestras (si no, correr npm run db:cargar:iperc)', async () => {
    const lista = await t.http().get('/api/qhse/iperc/actividades').set(hse());
    expect(lista.status).toBe(200);
    const reales = lista.body.filter((a: { nombre: string }) => !a.nombre.includes(`IT${n}`));
    expect(reales.length).toBeGreaterThanOrEqual(30);
  });
});
