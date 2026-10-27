/**
 * Integración real de QHSE: Desechos (HSE-AMBIENTAL-001), con las reglas de la base.
 *   RUN_INTEGRATION=1 npx jest desechos   (dentro de libs/qhse/seguridad)
 */
import { Permission } from '@dyn/authz';
import { uuidv7 } from '@dyn/utils';
import { VerificadorFirmasHttp, type LecturaFirma } from '../documentos/verificador-firmas';
import { AvisosProgramadosService } from '../avisos/avisos-programados.service';
import { levantarAppDePrueba, type AppDePrueba } from '../testing/app-de-prueba';
import { quitarMaestros, sembrarMaestros, type MaestrosDePrueba } from '../testing/maestros';

const run = process.env['RUN_INTEGRATION'] ? describe : describe.skip;
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
  caracteristicas: Array<{ id: string; codigo: string }>;
  contenedores: Array<{ id: string; codigo: string }>;
  pozos: Array<{ id: string }>;
};

run('QHSE: Desechos (base de datos real)', () => {
  jest.setTimeout(120000);
  let t: AppDePrueba;
  let cat: Catalogos;
  const desechos: string[] = [];

  const operador = () => t.token('operador', OPERADOR.nombre, [P.QHSE_REPORTAR], OPERADOR.id);
  const tecnico = () =>
    t.token('tecnico_hse', TECNICO.nombre, [P.QHSE_REPORTAR, P.DESECHOS_VER], TECNICO.id);
  const gestor = () =>
    t.token(
      'tecnico_hse',
      TECNICO.nombre,
      [P.QHSE_REPORTAR, P.DESECHOS_VER, P.DESECHOS_GESTIONAR],
      TECNICO.id,
    );

  const car = (codigo: string): string => {
    const c = cat.caracteristicas.find((x) => x.codigo === codigo);
    if (!c) throw new Error(`Falta la característica ${codigo} en la semilla`);
    return c.id;
  };
  const cont = (codigo: string): string => {
    const c = cat.contenedores.find((x) => x.codigo === codigo);
    if (!c) throw new Error(`Falta el contenedor ${codigo} en la semilla`);
    return c.id;
  };
  const linea = (extra: Record<string, unknown> = {}) => ({
    descripcion: 'Trapos con hidrocarburo',
    codigo: 'NE-03',
    cantidadGalones: 12.5,
    bultos: 2,
    ...extra,
  });
  const registrar = async (cuerpo: Record<string, unknown> = {}, quien = operador()) => {
    const r = await t
      .http()
      .post('/api/qhse/desechos')
      .set(quien)
      .send({
        clasificacion: 'peligroso',
        contenedorId: cont('negro'),
        caracteristicaIds: [car('inflamable'), car('toxico')],
        descripcion: 'Trapos y absorbentes contaminados',
        ubicacion: 'Laydown de la locación 3',
        items: [linea()],
        ...cuerpo,
      });
    if (r.status === 201) desechos.push(r.body.id);
    return r;
  };
  const sql = (texto: string, params: unknown[] = []) => t.admin.query(texto, params);
  const estadoId = async (codigo: string) =>
    (await sql('SELECT id FROM qhse.desecho_estado WHERE codigo = $1', [codigo])).rows[0]
      .id as string;

  /** Inserta un desecho completo directo en la base (como dyn_migrator) con la fecha de registro que se indique. */
  const insertarDirecto = async (diasAtras: number, estado = 'almacenado') => {
    const id = uuidv7();
    const c = await t.admin.connect();
    try {
      await c.query('BEGIN');
      await c.query(
        `INSERT INTO qhse.desecho (id, clasificacion, contenedor_id, estado_id, descripcion, registrado_el, limite_almacenamiento_hasta, created_by)
         VALUES ($1, 'no_peligroso', $2, $3, 'Desecho antiguo', CURRENT_DATE - $4::int, (CURRENT_DATE - $4::int + INTERVAL '12 months')::date, $5)`,
        [id, cont('gris'), await estadoId(estado), diasAtras, OPERADOR.id],
      );
      await c.query(
        "INSERT INTO qhse.desecho_item (id, desecho_id, orden, descripcion, codigo, cantidad_galones, created_by) VALUES ($1, $2, 1, 'Plástico', 'NP-01', 5, $3)",
        [uuidv7(), id, OPERADOR.id],
      );
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
    desechos.push(id);
    return id;
  };

  /** Lectura de firmas simulada (D6): lo que responda `ocr.respuesta` (null = el servicio no respondió). */
  const ocr: { respuesta: LecturaFirma | null; llamadas: string[] } = {
    respuesta: { resultado: 'firma_detectada', confianza: 0.9 },
    llamadas: [],
  };
  const archivos: string[] = [];
  let moduloDocumento = '';
  /** Un archivo ya subido por el módulo de archivos de desechos, como lo deja `POST /api/archivos`. */
  const archivo = async () => {
    const id = uuidv7();
    archivos.push(id);
    await t.admin.query(
      `INSERT INTO archivos.archivo (id, modulo_id, nombre_original, mime_type, tamano_bytes, sha256, blob_key, escaneo, subido_por)
       VALUES ($1, $2, 'doc.pdf', 'application/pdf', 10, $3, $4, 'omitido', $5)`,
      [
        id,
        moduloDocumento,
        id.replace(/-/g, '').padEnd(64, '0'),
        `qhse-test/desechos/${id}`,
        TECNICO.id,
      ],
    );
    return id;
  };
  /** La lectura de firma corre aparte: se espera a que quede guardada. */
  const esperarLectura = async (desechoId: string, tipo: string) => {
    for (let i = 0; i < 40; i++) {
      const f = (
        await sql(
          'SELECT verificacion, verificacion_confianza AS confianza, verificacion_at FROM qhse.desecho_documento WHERE desecho_id = $1 AND tipo = $2::qhse.tipo_documento_desecho',
          [desechoId, tipo],
        )
      ).rows[0];
      if (f?.verificacion_at) return f as { verificacion: string; confianza: string | null };
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('La lectura de firma no se guardó');
  };

  beforeAll(async () => {
    t = await levantarAppDePrueba('3181');
    jest
      .spyOn(VerificadorFirmasHttp.prototype, 'verificar')
      .mockImplementation(async (archivoId) => {
        ocr.llamadas.push(archivoId);
        return ocr.respuesta;
      });
    await sembrarMaestros(t.admin, MAESTROS);
    cat = (await t.http().get('/api/qhse/desechos/catalogos').set(operador())).body;
    // si falla aquí, falta correr `npm run db:seed:archivos`
    moduloDocumento = (
      await sql("SELECT id FROM archivos.modulo_archivo WHERE codigo = 'qhse_desecho_documento'")
    ).rows[0].id;
  });

  afterAll(async () => {
    await t.admin.query('DELETE FROM qhse.desecho WHERE id = ANY($1::uuid[])', [desechos]);
    await t.admin.query('DELETE FROM archivos.archivo WHERE id = ANY($1::uuid[])', [archivos]);
    await t.admin.query(
      "DELETE FROM msg_qhse.outbox WHERE datos->'data'->>'desechoId' = ANY($1::text[])",
      [desechos],
    );
    await quitarMaestros(t.admin, MAESTROS);
    await t.cerrar();
  });

  it('los catálogos salen sembrados: seis características CRETIB, cinco contenedores y tres estados', async () => {
    expect(cat.caracteristicas.map((c) => c.codigo)).toEqual([
      'corrosivo',
      'reactivo',
      'explosivo',
      'toxico',
      'inflamable',
      'biologico_infeccioso',
    ]);
    expect(cat.contenedores.map((c) => c.codigo)).toEqual([
      'rojo',
      'negro',
      'gris',
      'verde',
      'azul',
    ]);
    const estados = await sql('SELECT codigo FROM qhse.desecho_estado ORDER BY orden');
    expect(estados.rows.map((e: { codigo: string }) => e.codigo)).toEqual([
      'almacenado',
      'con_manifiesto',
      'dispuesto',
    ]);
  });

  it('cualquier trabajador registra; el equipo HSE lo ve con el límite de 12 meses, el historial y el evento', async () => {
    const r = await registrar();
    expect(r.status).toBe(201);
    expect(r.body).toEqual({
      id: expect.any(String),
      codigo: expect.stringMatching(/^DES-\d{6}$/),
      estado: 'almacenado',
    });
    // quien reporta no ve la bandeja ni el detalle
    expect((await t.http().get('/api/qhse/desechos').set(operador())).status).toBe(403);
    expect((await t.http().get(`/api/qhse/desechos/${r.body.id}`).set(operador())).status).toBe(
      403,
    );

    const d = (await t.http().get(`/api/qhse/desechos/${r.body.id}`).set(tecnico())).body;
    expect(d).toMatchObject({
      clasificacion: 'peligroso',
      estado: { codigo: 'almacenado' },
      contenedor: { codigo: 'negro' },
      generadoPor: OPERADOR.nombre,
      totalGalones: 12.5,
      vencido: false,
    });
    expect(d.cretib.sort()).toEqual(['Inflamable', 'Tóxico']);
    expect(d.items).toHaveLength(1);
    expect(d.historial).toHaveLength(1);
    // límite = registro + 12 meses
    const fila = (
      await sql(
        "SELECT (registrado_el + INTERVAL '12 months')::date::text AS esperado, limite_almacenamiento_hasta::text AS limite FROM qhse.desecho WHERE id = $1",
        [r.body.id],
      )
    ).rows[0];
    expect(fila.limite).toBe(fila.esperado);
    expect(d.limiteAlmacenamientoHasta).toBe(fila.limite);
    expect(d.diasParaLimite).toBeGreaterThanOrEqual(364);

    const ev = (
      await sql(
        "SELECT datos FROM msg_qhse.outbox WHERE tipo = 'qhse.desecho.registrado' AND datos->'data'->>'desechoId' = $1",
        [r.body.id],
      )
    ).rows;
    expect(ev).toHaveLength(1);
    expect(ev[0].datos.source).toBe('qhse');
    expect(ev[0].datos.data).toMatchObject({
      estado: 'almacenado',
      clasificacion: 'peligroso',
      contenedor: 'negro',
      totalGalones: 12.5,
    });
    expect(ev[0].datos.data.cretib.sort()).toEqual(['inflamable', 'toxico']);
  });

  it('un no peligroso se registra sin características y con pozo del catálogo', async () => {
    const pozoId = cat.pozos[0]?.id;
    const r = await registrar({
      clasificacion: 'no_peligroso',
      contenedorId: cont('gris'),
      caracteristicaIds: [],
      descripcion: 'Residuos comunes de campamento',
      ...(pozoId ? { pozoId } : {}),
    });
    expect(r.status).toBe(201);
    const d = (await t.http().get(`/api/qhse/desechos/${r.body.id}`).set(tecnico())).body;
    expect(d.cretib).toEqual([]);
  });

  it('el servicio rechaza lo incompleto con mensajes claros', async () => {
    const peligrosoSin = await registrar({ caracteristicaIds: [] });
    expect(peligrosoSin.status).toBe(400);
    expect(peligrosoSin.body.detail).toMatch(
      /peligroso necesita al menos una característica CRETIB/,
    );

    const noPeligrosoCon = await registrar({
      clasificacion: 'no_peligroso',
      caracteristicaIds: [car('toxico')],
    });
    expect(noPeligrosoCon.status).toBe(400);
    expect(noPeligrosoCon.body.detail).toMatch(/no peligroso no lleva/);

    expect((await registrar({ items: [] })).status).toBe(400);
    expect((await registrar({ items: [linea({ cantidadGalones: 0 })] })).status).toBe(400);
    expect((await registrar({ items: [linea({ codigo: '   ' })] })).status).toBe(400);
    expect((await registrar({ descripcion: '   ' })).status).toBe(400);
    expect((await registrar({ contenedorId: uuidv7() })).status).toBe(400);
    expect((await registrar({ caracteristicaIds: [uuidv7()] })).status).toBe(400);
    expect((await registrar({ pozoId: uuidv7() })).status).toBe(400);
    // sin cuenta con permiso de reportar no se registra
    const sinPermiso = t.token('operador', OPERADOR.nombre, [], OPERADOR.id);
    expect((await registrar({}, sinPermiso)).status).toBe(403);
  });

  it('la bandeja filtra por estado y marca como vencido lo almacenado más de 12 meses', async () => {
    const viejo = await insertarDirecto(400);
    const reciente = await insertarDirecto(10);
    const todos = (await t.http().get('/api/qhse/desechos').set(tecnico())).body as Array<{
      id: string;
      vencido: boolean;
      diasParaLimite: number | null;
    }>;
    const filaVieja = todos.find((x) => x.id === viejo);
    expect(filaVieja).toMatchObject({ vencido: true });
    expect(filaVieja?.diasParaLimite).toBeLessThan(0);
    expect(todos.find((x) => x.id === reciente)).toMatchObject({ vencido: false });

    const almacenados = (await t.http().get('/api/qhse/desechos?estado=almacenado').set(tecnico()))
      .body as Array<{ id: string }>;
    expect(almacenados.some((x) => x.id === viejo)).toBe(true);
    const conManifiesto = (
      await t.http().get('/api/qhse/desechos?estado=con_manifiesto').set(tecnico())
    ).body as Array<{ id: string }>;
    expect(conManifiesto.some((x) => x.id === viejo)).toBe(false);
    const busqueda = (await t.http().get('/api/qhse/desechos?q=antiguo').set(tecnico()))
      .body as Array<{ id: string }>;
    expect(busqueda.some((x) => x.id === viejo)).toBe(true);
  });

  describe('manifiesto y firmas', () => {
    const numeroUnico = () => `MAN-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const generar = (id: string, cuerpo: Record<string, unknown> = {}, quien = gestor()) =>
      t
        .http()
        .post(`/api/qhse/desechos/${id}/manifiesto`)
        .set(quien)
        .send({
          numero: numeroUnico(),
          gestorNombre: 'Gestor Ambiental S.A.',
          gestorLicenciaSuia: 'SUIA-2026-0457',
          conductorNombre: 'Carlos Conductor',
          vehiculo: 'Camión tanquero',
          placas: 'PBA-1234',
          ...cuerpo,
        });
    const firmar = (id: string, cuerpo: Record<string, unknown>, quien = gestor()) =>
      t.http().post(`/api/qhse/desechos/${id}/manifiesto/firmas`).set(quien).send(cuerpo);
    const patchGuia = (id: string, cuerpo: Record<string, unknown>) =>
      t.http().patch(`/api/qhse/desechos/${id}/manifiesto`).set(gestor()).send(cuerpo);
    const eventos = async (tipo: string, id: string) =>
      (
        await sql(
          "SELECT datos FROM msg_qhse.outbox WHERE tipo = $1 AND datos->'data'->>'desechoId' = $2 ORDER BY ocurrido_at, id",
          [tipo, id],
        )
      ).rows as Array<{ datos: { data: Record<string, unknown> } }>;

    it('generar el manifiesto exige número, gestor y licencia SUIA, y pasa el desecho a con manifiesto', async () => {
      const id = (await registrar()).body.id as string;
      // permisos: quien solo reporta o solo ve no gestiona
      expect((await generar(id, {}, operador())).status).toBe(403);
      expect((await generar(id, {}, tecnico())).status).toBe(403);
      for (const faltante of ['numero', 'gestorNombre', 'gestorLicenciaSuia'])
        expect((await generar(id, { [faltante]: '   ' })).status).toBe(400);
      expect((await generar(id, { clienteId: uuidv7() })).status).toBe(400);

      const r = await generar(id, { horaSalida: '2026-10-24T08:00:00-05:00' });
      expect(r.status).toBe(201);
      expect(r.body.estado.codigo).toBe('con_manifiesto');
      expect(r.body.manifiesto).toMatchObject({
        gestorLicenciaSuia: 'SUIA-2026-0457',
        transportista: { conductor: 'Carlos Conductor', placas: 'PBA-1234' },
        firmasCompletas: false,
      });
      expect(r.body.manifiesto.firmas.map((f: { rol: string }) => f.rol)).toEqual([
        'despachado_por',
        'transportado_por',
        'recibido_por',
      ]);
      // plazo de 30 días para el certificado de disposición final
      const { fecha, certificadoVenceEl } = r.body.manifiesto;
      expect((Date.parse(certificadoVenceEl) - Date.parse(fecha)) / 86_400_000).toBe(30);
      expect(r.body.historial).toHaveLength(2);
      expect((await eventos('qhse.desecho.manifiesto_generado', id))[0].datos.data).toMatchObject({
        estado: 'con_manifiesto',
        manifiestoNumero: r.body.manifiesto.numero,
      });
      // una sola vez, y con número único
      expect((await generar(id)).status).toBe(409);
      const otro = (await registrar()).body.id as string;
      expect((await generar(otro, { numero: r.body.manifiesto.numero })).status).toBe(409);
    });

    it('las tres firmas: el despachador firma con su cuenta; transportista y gestor, con nombre y cédula; sin repetir', async () => {
      const id = (await registrar()).body.id as string;
      // sin manifiesto no hay qué firmar
      expect((await firmar(id, { rol: 'despachado_por' })).status).toBe(404);
      await generar(id);

      expect((await firmar(id, { rol: 'despachado_por' }, operador())).status).toBe(403);
      expect((await firmar(id, { rol: 'transportado_por' })).status).toBe(400);
      expect(
        (await firmar(id, { rol: 'recibido_por', firmanteNombre: 'Rosa Receptora' })).status,
      ).toBe(400);

      const a = await firmar(id, { rol: 'despachado_por', firmanteNombre: 'No aplica' });
      expect(a.status).toBe(201);
      const firmaA = a.body.manifiesto.firmas[0];
      expect(firmaA).toMatchObject({ registradoPor: TECNICO.nombre, firmanteNombre: null });
      expect(firmaA.firmadoAt).toEqual(expect.any(String));
      expect((await firmar(id, { rol: 'despachado_por' })).status).toBe(409);

      await firmar(id, {
        rol: 'transportado_por',
        firmanteNombre: 'Carlos Conductor',
        firmanteCedula: '1712345678',
      });
      // aún no está completo: se puede completar la guía
      const guia = await patchGuia(id, {
        horaLlegada: '2026-10-24T14:00:00-05:00',
        placas: 'PBA-9999',
      });
      expect(guia.status).toBe(200);
      expect(guia.body.manifiesto.transportista.placas).toBe('PBA-9999');
      // la llegada no puede ser anterior a la salida
      expect((await patchGuia(id, { horaSalida: '2026-10-24T20:00:00-05:00' })).status).toBe(400);

      const c = await firmar(id, {
        rol: 'recibido_por',
        firmanteNombre: 'Rosa Receptora',
        firmanteCedula: '1798765432',
      });
      expect(c.body.manifiesto.firmasCompletas).toBe(true);
      const ev = await eventos('qhse.desecho.firmado', id);
      expect(ev.map((e) => e.datos.data['firmasRegistradas'])).toEqual([1, 2, 3]);
      expect(ev[2].datos.data).toMatchObject({
        rolFirma: 'recibido_por',
        firmasCompletas: true,
        documentoTipo: 'qhse_desecho',
        documentoId: id,
        rolFirmante: 'recibido_por',
        metodo: 'linea',
        hashDocumento: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      // con las tres firmas la guía ya no cambia
      expect((await patchGuia(id, { placas: 'XXX-0000' })).status).toBe(409);
    });
  });

  describe('documentos firmados y certificado de disposición final', () => {
    const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Guayaquil' });
    /** Un desecho con manifiesto y las tres firmas, listo para cargar documentos. */
    const firmado = async (firmas = 3, alGenerar?: (id: string) => Promise<unknown>) => {
      const id = (await registrar()).body.id as string;
      await t
        .http()
        .post(`/api/qhse/desechos/${id}/manifiesto`)
        .set(gestor())
        .send({
          numero: `MAN-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
          gestorNombre: 'Gestor Ambiental S.A.',
          gestorLicenciaSuia: 'SUIA-2026-0457',
        })
        .expect(201);
      await alGenerar?.(id);
      const cuerpos = [
        { rol: 'despachado_por' },
        { rol: 'transportado_por', firmanteNombre: 'Carlos', firmanteCedula: '1712345678' },
        { rol: 'recibido_por', firmanteNombre: 'Rosa', firmanteCedula: '1798765432' },
      ];
      for (const c of cuerpos.slice(0, firmas))
        await t
          .http()
          .post(`/api/qhse/desechos/${id}/manifiesto/firmas`)
          .set(gestor())
          .send(c)
          .expect(201);
      return id;
    };
    const certificado = (id: string, cuerpo: Record<string, unknown>, quien = gestor()) =>
      t.http().post(`/api/qhse/desechos/${id}/certificado`).set(quien).send(cuerpo);
    const eventos = async (tipo: string, id: string) =>
      (
        await sql(
          "SELECT datos FROM msg_qhse.outbox WHERE tipo = $1 AND datos->'data'->>'desechoId' = $2",
          [tipo, id],
        )
      ).rows as Array<{ datos: { data: Record<string, unknown> } }>;

    it('el manifiesto firmado se carga con las tres firmas y se lee la firma (solo un indicador)', async () => {
      const incompleto = await firmado(2);
      const a0 = await archivo();
      const sinFirmas = await t
        .http()
        .post(`/api/qhse/desechos/${incompleto}/manifiesto/documento`)
        .set(gestor())
        .send({ archivoId: a0 });
      expect(sinFirmas.status).toBe(409);

      const id = await firmado();
      ocr.respuesta = { resultado: 'firma_detectada', confianza: 0.92 };
      const a1 = await archivo();
      expect(
        (
          await t
            .http()
            .post(`/api/qhse/desechos/${id}/manifiesto/documento`)
            .set(operador())
            .send({ archivoId: a1 })
        ).status,
      ).toBe(403);
      const r = await t
        .http()
        .post(`/api/qhse/desechos/${id}/manifiesto/documento`)
        .set(gestor())
        .send({ archivoId: a1, referencia: 'Escaneo 1' });
      expect(r.status).toBe(201);
      expect(r.body.estado.codigo).toBe('con_manifiesto');
      expect(r.body.documentos[0]).toMatchObject({
        tipo: 'manifiesto_firmado',
        archivoId: a1,
        referencia: 'Escaneo 1',
      });
      const lectura = await esperarLectura(id, 'manifiesto_firmado');
      expect(lectura.verificacion).toBe('firma_detectada');
      expect(Number(lectura.confianza)).toBe(0.92);
      expect(ocr.llamadas).toContain(a1);
      // uno solo, y el archivo no se reutiliza
      expect(
        (
          await t
            .http()
            .post(`/api/qhse/desechos/${id}/manifiesto/documento`)
            .set(gestor())
            .send({ archivoId: await archivo() })
        ).status,
      ).toBe(409);
      // un archivo de otro módulo no sirve
      const ajeno = uuidv7();
      archivos.push(ajeno);
      const otroModulo = (
        await sql("SELECT id FROM archivos.modulo_archivo WHERE codigo = 'qhse_stop_foto'")
      ).rows[0].id;
      await sql(
        `INSERT INTO archivos.archivo (id, modulo_id, nombre_original, mime_type, tamano_bytes, sha256, blob_key, escaneo, subido_por)
         VALUES ($1, $2, 'f.png', 'image/png', 10, $3, $4, 'omitido', $5)`,
        [
          ajeno,
          otroModulo,
          ajeno.replace(/-/g, '').padEnd(64, '0'),
          `qhse-test/desechos/${ajeno}`,
          TECNICO.id,
        ],
      );
      const certificadoAjeno = await certificado(id, { archivoId: ajeno, emitidoEl: hoy });
      expect(certificadoAjeno.status).toBe(400);
      expect(certificadoAjeno.body.detail).toMatch(/no se subió como documento de desechos/);
    });

    it('el certificado cierra el ciclo: exige las tres firmas, pasa a dispuesto, congela el desecho y publica el evento', async () => {
      const incompleto = await firmado(1);
      expect(
        (await certificado(incompleto, { archivoId: await archivo(), emitidoEl: hoy })).status,
      ).toBe(409);

      const id = await firmado();
      ocr.respuesta = { resultado: 'no_detectada', confianza: 0.1 };
      const a = await archivo();
      // validaciones
      expect((await certificado(id, { archivoId: a, emitidoEl: 'mañana' })).status).toBe(400);
      expect((await certificado(id, { archivoId: a, emitidoEl: '2099-01-01' })).status).toBe(400);
      expect((await certificado(id, { archivoId: a, emitidoEl: '2000-01-01' })).status).toBe(400);
      expect((await certificado(id, { archivoId: uuidv7(), emitidoEl: hoy })).status).toBe(400);
      expect((await certificado(id, { archivoId: a, emitidoEl: hoy }, operador())).status).toBe(
        403,
      );

      const r = await certificado(id, { archivoId: a, emitidoEl: hoy, referencia: 'CERT-001' });
      expect(r.status).toBe(201);
      expect(r.body.estado.codigo).toBe('dispuesto');
      expect(r.body.diasParaLimite).toBeNull();
      expect(r.body.vencido).toBe(false);
      expect(r.body.manifiesto).toMatchObject({
        certificadoVencido: false,
        certificadoFueraDePlazo: false,
      });
      expect(r.body.historial.map((h: { estado: { codigo: string } }) => h.estado.codigo)).toEqual([
        'almacenado',
        'con_manifiesto',
        'dispuesto',
      ]);
      expect((await esperarLectura(id, 'certificado_disposicion')).verificacion).toBe(
        'firma_no_detectada',
      );
      const ev = await eventos('qhse.desecho.dispuesto', id);
      expect(ev).toHaveLength(1);
      expect(ev[0].datos.data).toMatchObject({ estado: 'dispuesto', certificadoEmitidoEl: hoy });
      // un desecho dispuesto ya no recibe documentos ni manifiesto ni firmas
      expect((await certificado(id, { archivoId: await archivo(), emitidoEl: hoy })).status).toBe(
        409,
      );
      expect(
        (
          await t
            .http()
            .post(`/api/qhse/desechos/${id}/manifiesto/firmas`)
            .set(gestor())
            .send({ rol: 'despachado_por' })
        ).status,
      ).toBe(409);
    });

    it('con el servicio de lectura caído el documento se carga igual y la lectura se puede repetir', async () => {
      const id = await firmado();
      ocr.respuesta = null;
      await t
        .http()
        .post(`/api/qhse/desechos/${id}/manifiesto/documento`)
        .set(gestor())
        .send({ archivoId: await archivo() })
        .expect(201);
      expect((await esperarLectura(id, 'manifiesto_firmado')).verificacion).toBe('no_verificada');
      ocr.respuesta = { resultado: 'firma_detectada', confianza: 0.8 };
      const otra = await t
        .http()
        .post(`/api/qhse/desechos/${id}/documentos/verificar`)
        .set(gestor())
        .send({ tipo: 'manifiesto_firmado' });
      expect(otra.status).toBe(201);
      expect(otra.body.documentos[0].verificacion).toBe('firma_detectada');
      expect(
        (
          await t
            .http()
            .post(`/api/qhse/desechos/${id}/documentos/verificar`)
            .set(gestor())
            .send({ tipo: 'certificado_disposicion' })
        ).status,
      ).toBe(404);
    });

    it('un certificado que llega después de 30 días del manifiesto se marca fuera de plazo (no se bloquea)', async () => {
      // el manifiesto se generó hace 45 días (la fecha la fija el servidor; se atrasa directo en la base antes de firmar)
      const id = await firmado(3, (x) =>
        sql('UPDATE qhse.desecho_manifiesto SET fecha = CURRENT_DATE - 45 WHERE desecho_id = $1', [
          x,
        ]),
      );
      const vencido = (await t.http().get(`/api/qhse/desechos/${id}`).set(tecnico())).body;
      expect(vencido.manifiesto.certificadoVencido).toBe(true);
      const r = await certificado(id, { archivoId: await archivo(), emitidoEl: hoy });
      expect(r.status).toBe(201);
      expect(r.body.manifiesto).toMatchObject({
        certificadoVencido: false,
        certificadoFueraDePlazo: true,
      });
    });

    describe('avisos de vencimiento', () => {
      const revisar = (quien = gestor()) =>
        t.http().post('/api/qhse/desechos/avisos/revisar').set(quien);
      const eventosDe = async (tipo: string, id: string) =>
        (
          await sql(
            "SELECT datos FROM msg_qhse.outbox WHERE tipo = $1 AND datos->'data'->>'desechoId' = $2",
            [tipo, id],
          )
        ).rows as Array<{ datos: { data: Record<string, unknown> } }>;

      it('la bandeja y el resumen separan lo vencido (pasó los 12 meses) de lo que está por vencer (30 días o menos)', async () => {
        const vencido = await insertarDirecto(400);
        const porVencer = await insertarDirecto(345); // el límite cae en ~20 días
        const lejos = await insertarDirecto(10);
        const ids = async (q: string) =>
          (
            (await t.http().get(`/api/qhse/desechos?vencimiento=${q}`).set(tecnico()))
              .body as Array<{ id: string }>
          ).map((x) => x.id);
        const v = await ids('vencidos');
        expect(v).toContain(vencido);
        expect(v).not.toContain(porVencer);
        const p = await ids('por_vencer');
        expect(p).toContain(porVencer);
        expect(p).not.toContain(vencido);
        expect(p).not.toContain(lejos);
        expect(
          (await t.http().get('/api/qhse/desechos?vencimiento=nunca').set(tecnico())).status,
        ).toBe(400);

        const r = (await t.http().get('/api/qhse/desechos/resumen').set(tecnico())).body;
        expect(r.diasAviso).toBe(30);
        expect(r.vencidos).toBeGreaterThanOrEqual(1);
        expect(r.porVencer).toBeGreaterThanOrEqual(1);
        expect(r.galonesSinDisponer).toBeGreaterThan(0);
        expect(r.porEstado.map((e: { codigo: string }) => e.codigo)).toEqual([
          'almacenado',
          'con_manifiesto',
          'dispuesto',
        ]);
        expect((await t.http().get('/api/qhse/desechos/resumen').set(operador())).status).toBe(403);
      });

      it('la revisión emite una sola vez el aviso de límite próximo y de límite vencido, y no toca lo que está lejos', async () => {
        const vencido = await insertarDirecto(400);
        const porVencer = await insertarDirecto(345);
        const lejos = await insertarDirecto(10);
        expect((await revisar(tecnico())).status).toBe(403);
        const r1 = await revisar();
        expect(r1.status).toBe(201);
        expect(r1.body.limiteVencido).toBeGreaterThanOrEqual(1);
        expect(r1.body.limiteProximo).toBeGreaterThanOrEqual(1);

        const ev = await eventosDe('qhse.desecho.limite_vencido', vencido);
        expect(ev).toHaveLength(1);
        expect(ev[0].datos.data).toMatchObject({
          desechoId: vencido,
          descripcion: 'Desecho antiguo',
        });
        expect(Number(ev[0].datos.data['diasVencido'])).toBeGreaterThan(0);
        const prox = await eventosDe('qhse.desecho.limite_proximo', porVencer);
        expect(prox).toHaveLength(1);
        expect(Number(prox[0].datos.data['diasParaLimite'])).toBeLessThanOrEqual(30);
        expect(await eventosDe('qhse.desecho.limite_proximo', lejos)).toHaveLength(0);
        expect(await eventosDe('qhse.desecho.limite_vencido', lejos)).toHaveLength(0);
        // el de límite próximo no se emite para uno ya vencido
        expect(await eventosDe('qhse.desecho.limite_proximo', vencido)).toHaveLength(0);

        // repetir la revisión no duplica nada
        const r2 = await revisar();
        expect(r2.body.limiteVencido).toBe(0);
        expect(r2.body.limiteProximo).toBe(0);
        expect(await eventosDe('qhse.desecho.limite_vencido', vencido)).toHaveLength(1);
        expect(await eventosDe('qhse.desecho.limite_proximo', porVencer)).toHaveLength(1);
      });

      it('la revisión automática de avisos por vencimiento también avisa el límite de desechos, sin quien lo dispare, y no repite lo ya avisado', async () => {
        const vencido = await insertarDirecto(400);
        const porVencer = await insertarDirecto(345);
        const lejos = await insertarDirecto(10);
        const programados = t.app.get(AvisosProgramadosService);
        const r1 = await programados.emitir(undefined, [vencido, porVencer, lejos]);
        expect(r1.porTipo['qhse.desecho.limite_vencido']).toBe(1);
        expect(r1.porTipo['qhse.desecho.limite_proximo']).toBe(1);
        const [ev] = await eventosDe('qhse.desecho.limite_vencido', vencido);
        expect(ev.datos.data).toMatchObject({ desechoId: vencido });
        expect((ev.datos as { actor?: unknown }).actor).toBeUndefined(); // lo emite el sistema
        const fila = await sql('SELECT emitido_por FROM qhse.desecho_aviso WHERE desecho_id = $1', [
          vencido,
        ]);
        expect(fila.rows).toEqual([{ emitido_por: null }]);
        expect(await eventosDe('qhse.desecho.limite_proximo', lejos)).toHaveLength(0);
        // otra vuelta, o la revisión manual después, no repite
        const r2 = await programados.emitir(undefined, [vencido, porVencer, lejos]);
        expect(r2.total).toBe(0);
        await revisar();
        expect(await eventosDe('qhse.desecho.limite_vencido', vencido)).toHaveLength(1);
        expect(await eventosDe('qhse.desecho.limite_proximo', porVencer)).toHaveLength(1);
      });

      it('un desecho ya dispuesto no recibe avisos, y el certificado fuera de los 30 días avisa una sola vez', async () => {
        // con más de 12 meses pero dispuesto (se completa todo el ciclo): no se avisa
        const id = await firmado(3, (x) =>
          sql(
            "UPDATE qhse.desecho SET registrado_el = CURRENT_DATE - 400, limite_almacenamiento_hasta = (CURRENT_DATE - 400 + INTERVAL '12 months')::date WHERE id = $1",
            [x],
          ),
        );
        await certificado(id, { archivoId: await archivo(), emitidoEl: hoy }).expect(201);

        // con manifiesto de hace 45 días y sin certificado: aviso de certificado
        const atrasado = await firmado(3, (x) =>
          sql(
            'UPDATE qhse.desecho_manifiesto SET fecha = CURRENT_DATE - 45 WHERE desecho_id = $1',
            [x],
          ),
        );
        const reciente = await firmado();
        const r = await revisar();
        expect(r.body.certificadoVencido).toBeGreaterThanOrEqual(1);
        for (const tipo of ['limite_proximo', 'limite_vencido', 'certificado_vencido'])
          expect(await eventosDe(`qhse.desecho.${tipo}`, id)).toHaveLength(0);
        const ev = await eventosDe('qhse.desecho.certificado_vencido', atrasado);
        expect(ev).toHaveLength(1);
        expect(ev[0].datos.data).toMatchObject({ estado: 'con_manifiesto' });
        expect(ev[0].datos.data['manifiestoNumero']).toEqual(expect.any(String));
        expect(Number(ev[0].datos.data['diasVencido'])).toBeGreaterThan(0);
        expect(await eventosDe('qhse.desecho.certificado_vencido', reciente)).toHaveLength(0);
        await revisar();
        expect(await eventosDe('qhse.desecho.certificado_vencido', atrasado)).toHaveLength(1);
      });

      it('la base impide repetir un aviso y no deja editar ni borrar los emitidos', async () => {
        const id = await insertarDirecto(400);
        await revisar();
        await expect(
          sql(
            "INSERT INTO qhse.desecho_aviso (id, desecho_id, tipo, emitido_por) VALUES ($1, $2, 'limite_vencido', $3)",
            [uuidv7(), id, OPERADOR.id],
          ),
        ).rejects.toThrow(/desecho_aviso_unico_key/);
        await expect(
          t.prisma.desechoAviso.updateMany({
            where: { desechoId: id },
            data: { tipo: 'limite_proximo' },
          }),
        ).rejects.toThrow(/permission denied|denegado/i);
        await expect(
          t.prisma.desechoAviso.deleteMany({ where: { desechoId: id } }),
        ).rejects.toThrow(/permission denied|denegado/i);
      });
    });
  });

  describe('reglas de la base', () => {
    const cabecera = async (
      extra: { limite?: string; estado?: string; clasificacion?: string } = {},
    ) => {
      const id = uuidv7();
      return {
        id,
        texto: `INSERT INTO qhse.desecho (id, clasificacion, contenedor_id, estado_id, descripcion, registrado_el, limite_almacenamiento_hasta, created_by)
                VALUES ($1, $2::qhse.clasificacion_desecho, $3, $4, 'Prueba', CURRENT_DATE, COALESCE($5::date, (CURRENT_DATE + INTERVAL '12 months')::date), $6)`,
        params: [
          id,
          extra.clasificacion ?? 'no_peligroso',
          cont('gris'),
          await estadoId(extra.estado ?? 'almacenado'),
          extra.limite ?? null,
          OPERADOR.id,
        ],
      };
    };
    /** Ejecuta en una transacción y confirma (los triggers diferidos se evalúan al confirmar). */
    const enTransaccion = async (pasos: Array<[string, unknown[]]>) => {
      const c = await t.admin.connect();
      try {
        await c.query('BEGIN');
        for (const [texto, params] of pasos) await c.query(texto, params);
        await c.query('COMMIT');
      } catch (e) {
        await c.query('ROLLBACK').catch(() => undefined);
        throw e;
      } finally {
        c.release();
      }
    };
    /** Carga el certificado de disposición final directo en la base (el desecho debe tener ya las tres firmas). */
    const certificar = async (id: string) =>
      sql(
        'INSERT INTO qhse.desecho_documento (id, desecho_id, tipo, archivo_id, emitido_el, created_by) VALUES ($1, $2, $3::qhse.tipo_documento_desecho, $4, CURRENT_DATE, $5)',
        [uuidv7(), id, 'certificado_disposicion', await archivo(), OPERADOR.id],
      );
    const item = (id: string): [string, unknown[]] => [
      "INSERT INTO qhse.desecho_item (id, desecho_id, orden, descripcion, codigo, cantidad_galones, created_by) VALUES ($1, $2, 1, 'Línea', 'X-1', 1, $3)",
      [uuidv7(), id, OPERADOR.id],
    ];

    it('el límite de almacenamiento debe ser el registro más 12 meses (AM 142)', async () => {
      const c = await cabecera({ limite: '2099-01-01' });
      await expect(sql(c.texto, c.params)).rejects.toThrow(/desecho_limite_check/);
    });

    it('un peligroso sin característica CRETIB, un no peligroso con ella y una guía sin líneas no se confirman', async () => {
      const peligroso = await cabecera({ clasificacion: 'peligroso' });
      await expect(
        enTransaccion([[peligroso.texto, peligroso.params], item(peligroso.id)]),
      ).rejects.toThrow(/al menos una característica CRETIB/);

      const noPeligroso = await cabecera();
      await expect(
        enTransaccion([
          [noPeligroso.texto, noPeligroso.params],
          [
            'INSERT INTO qhse.desecho_caracteristica_asignada (desecho_id, caracteristica_id) VALUES ($1, $2)',
            [noPeligroso.id, car('toxico')],
          ],
          item(noPeligroso.id),
        ]),
      ).rejects.toThrow(/no peligroso no lleva características CRETIB/);

      const sinLineas = await cabecera();
      await expect(enTransaccion([[sinLineas.texto, sinLineas.params]])).rejects.toThrow(
        /al menos una línea/,
      );
    });

    it('nace almacenado, no se salta de estado y la cantidad de una línea debe ser positiva', async () => {
      const nace = await cabecera({ estado: 'dispuesto' });
      await expect(sql(nace.texto, nace.params)).rejects.toThrow(/nace almacenado/);

      const id = await insertarDirecto(1);
      await expect(
        sql('UPDATE qhse.desecho SET estado_id = $2 WHERE id = $1', [
          id,
          await estadoId('dispuesto'),
        ]),
      ).rejects.toThrow(/Cambio de estado no permitido/);
      await expect(
        sql(
          "INSERT INTO qhse.desecho_item (id, desecho_id, orden, descripcion, codigo, cantidad_galones, created_by) VALUES ($1, $2, 2, 'Línea', 'X-2', 0, $3)",
          [uuidv7(), id, OPERADOR.id],
        ),
      ).rejects.toThrow(/desecho_item_cantidad_check/);
    });

    it('la aplicación no reescribe ni borra lo registrado: solo avanza el estado', async () => {
      const id = await insertarDirecto(1);
      await expect(
        t.prisma.desecho.update({ where: { id }, data: { descripcion: 'otra cosa' } }),
      ).rejects.toThrow(/permission denied|denegado/i);
      await expect(
        t.prisma.desecho.update({
          where: { id },
          data: { limiteAlmacenamientoHasta: new Date('2099-01-01') },
        }),
      ).rejects.toThrow(/permission denied|denegado/i);
      await expect(t.prisma.desecho.delete({ where: { id } })).rejects.toThrow(
        /permission denied|denegado/i,
      );
      await expect(
        t.prisma.desechoItem.updateMany({ where: { desechoId: id }, data: { bultos: 9 } }),
      ).rejects.toThrow(/permission denied|denegado/i);
      await expect(t.prisma.desechoItem.deleteMany({ where: { desechoId: id } })).rejects.toThrow(
        /permission denied|denegado/i,
      );
      await expect(
        t.prisma.desechoCaracteristicaAsignada.deleteMany({ where: { desechoId: id } }),
      ).rejects.toThrow(/permission denied|denegado/i);
      await expect(
        t.prisma.desechoHistorial.deleteMany({ where: { desechoId: id } }),
      ).rejects.toThrow(/permission denied|denegado/i);
    });

    it('con el desecho fuera de almacenamiento no se agregan líneas, y uno dispuesto ya no cambia', async () => {
      const id = await insertarDirecto(1);
      await sql(
        "INSERT INTO qhse.desecho_manifiesto (id, desecho_id, numero, fecha, gestor_nombre, gestor_licencia_suia, created_by) VALUES ($1, $2, $3, CURRENT_DATE, 'G', 'S', $4)",
        [uuidv7(), id, `M-${Date.now()}-e`, OPERADOR.id],
      );
      await sql('UPDATE qhse.desecho SET estado_id = $2 WHERE id = $1', [
        id,
        await estadoId('con_manifiesto'),
      ]);
      await expect(sql(...item(id))).rejects.toThrow(/solo se completan con el desecho almacenado/);
      // disponer exige las tres firmas del manifiesto
      const manifiesto = (
        await sql('SELECT id FROM qhse.desecho_manifiesto WHERE desecho_id = $1', [id])
      ).rows[0].id as string;
      for (const [rol, nombre, cedula] of [
        ['despachado_por', null, null],
        ['transportado_por', 'Carlos', '1712345678'],
        ['recibido_por', 'Rosa', '1798765432'],
      ])
        await sql(
          'INSERT INTO qhse.desecho_firma (id, manifiesto_id, rol, registrado_por, firmante_nombre, firmante_cedula) VALUES ($1, $2, $3::qhse.rol_firma_desecho, $4, $5, $6)',
          [uuidv7(), manifiesto, rol, OPERADOR.id, nombre, cedula],
        );
      await certificar(id);
      await sql('UPDATE qhse.desecho SET estado_id = $2 WHERE id = $1', [
        id,
        await estadoId('dispuesto'),
      ]);
      await expect(
        sql('UPDATE qhse.desecho SET estado_id = $2 WHERE id = $1', [
          id,
          await estadoId('almacenado'),
        ]),
      ).rejects.toThrow(/dispuesto ya no se modifica/);
    });

    it('el manifiesto y las firmas: número, horas y firmante lo exige la base; las firmas no se editan ni se borran', async () => {
      const id = await insertarDirecto(1);
      const manifiestoId = uuidv7();
      const crear = (numero: string, horas: [string | null, string | null] = [null, null]) =>
        sql(
          `INSERT INTO qhse.desecho_manifiesto (id, desecho_id, numero, fecha, gestor_nombre, gestor_licencia_suia, hora_salida, hora_llegada, created_by)
           VALUES ($1, $2, $3, CURRENT_DATE, 'Gestor', 'SUIA-1', $4, $5, $6)`,
          [manifiestoId, id, numero, horas[0], horas[1], OPERADOR.id],
        );
      // pasar a con manifiesto sin manifiesto no se puede
      await expect(
        sql('UPDATE qhse.desecho SET estado_id = $2 WHERE id = $1', [
          id,
          await estadoId('con_manifiesto'),
        ]),
      ).rejects.toThrow(/hay que generar el manifiesto/);
      await expect(crear('   ')).rejects.toThrow(/desecho_manifiesto_numero_check/);
      await expect(
        crear(`M-${Date.now()}`, ['2026-10-24T10:00:00Z', '2026-10-24T09:00:00Z']),
      ).rejects.toThrow(/desecho_manifiesto_horas_check/);
      await crear(`M-${Date.now()}-b`);
      await sql('UPDATE qhse.desecho SET estado_id = $2 WHERE id = $1', [
        id,
        await estadoId('con_manifiesto'),
      ]);

      const firma = (rol: string, nombre: string | null, cedula: string | null) =>
        sql(
          'INSERT INTO qhse.desecho_firma (id, manifiesto_id, rol, registrado_por, firmante_nombre, firmante_cedula) VALUES ($1, $2, $3::qhse.rol_firma_desecho, $4, $5, $6)',
          [uuidv7(), manifiestoId, rol, OPERADOR.id, nombre, cedula],
        );
      await expect(firma('despachado_por', 'Alguien', '1700000000')).rejects.toThrow(
        /desecho_firma_firmante_check/,
      );
      await expect(firma('transportado_por', null, null)).rejects.toThrow(
        /desecho_firma_firmante_check/,
      );
      await expect(firma('recibido_por', 'Rosa', '   ')).rejects.toThrow(
        /desecho_firma_firmante_check/,
      );
      await firma('despachado_por', null, null);
      await expect(firma('despachado_por', null, null)).rejects.toThrow(/desecho_firma_unica_key/);

      // disponer exige las tres firmas
      await expect(
        sql('UPDATE qhse.desecho SET estado_id = $2 WHERE id = $1', [
          id,
          await estadoId('dispuesto'),
        ]),
      ).rejects.toThrow(/necesita las tres firmas/);

      await firma('transportado_por', 'Carlos', '1712345678');
      await firma('recibido_por', 'Rosa', '1798765432');
      // firmas inmutables para la aplicación; con las tres, el manifiesto ya no cambia
      await expect(
        t.prisma.desechoFirma.updateMany({
          where: { manifiestoId },
          data: { firmanteNombre: 'Otro' },
        }),
      ).rejects.toThrow(/permission denied|denegado/i);
      await expect(t.prisma.desechoFirma.deleteMany({ where: { manifiestoId } })).rejects.toThrow(
        /permission denied|denegado/i,
      );
      await expect(
        t.prisma.desechoManifiesto.update({
          where: { id: manifiestoId },
          data: { numero: 'otro' },
        }),
      ).rejects.toThrow(/permission denied|denegado/i);
      await expect(
        t.prisma.desechoManifiesto.delete({ where: { id: manifiestoId } }),
      ).rejects.toThrow(/permission denied|denegado/i);
      await expect(
        sql('UPDATE qhse.desecho_manifiesto SET placas = $2 WHERE id = $1', [
          manifiestoId,
          'ZZZ-1',
        ]),
      ).rejects.toThrow(/ya tiene las tres firmas/);
      await certificar(id);
      await sql('UPDATE qhse.desecho SET estado_id = $2 WHERE id = $1', [
        id,
        await estadoId('dispuesto'),
      ]);
      // dispuesto ya no admite firmas
      await expect(firma('despachado_por', null, null)).rejects.toThrow();
    });

    it('un desecho solo tiene un manifiesto y no se genera uno con el desecho fuera de almacenamiento', async () => {
      const id = await insertarDirecto(1);
      const nuevo = (n: string) =>
        sql(
          "INSERT INTO qhse.desecho_manifiesto (id, desecho_id, numero, fecha, gestor_nombre, gestor_licencia_suia, created_by) VALUES ($1, $2, $3, CURRENT_DATE, 'G', 'S', $4)",
          [uuidv7(), id, n, OPERADOR.id],
        );
      await nuevo(`M-${Date.now()}-c`);
      await expect(nuevo(`M-${Date.now()}-d`)).rejects.toThrow(/desecho_manifiesto_desecho_key/);
      await sql('UPDATE qhse.desecho SET estado_id = $2 WHERE id = $1', [
        id,
        await estadoId('con_manifiesto'),
      ]);
      // con el desecho ya con manifiesto, el trigger rechaza antes que la clave única de otro desecho
      const otro = await insertarDirecto(1);
      await sql('UPDATE qhse.desecho SET estado_id = $2 WHERE id = $1', [
        otro,
        await estadoId('almacenado'),
      ]);
      await expect(
        sql(
          "INSERT INTO qhse.desecho_manifiesto (id, desecho_id, numero, fecha, gestor_nombre, gestor_licencia_suia, created_by) VALUES ($1, $2, 'M-dup', CURRENT_DATE, 'G', 'S', $3)",
          [uuidv7(), id, OPERADOR.id],
        ),
      ).rejects.toThrow(
        /desecho_manifiesto_desecho_key|solo se genera|se genera con el desecho almacenado/,
      );
    });

    it('los documentos exigen las tres firmas, el certificado es lo que permite disponer y lo cargado no se reemplaza ni se borra', async () => {
      const id = await insertarDirecto(1);
      const manifiestoId = uuidv7();
      await sql(
        "INSERT INTO qhse.desecho_manifiesto (id, desecho_id, numero, fecha, gestor_nombre, gestor_licencia_suia, created_by) VALUES ($1, $2, $3, CURRENT_DATE, 'G', 'S', $4)",
        [manifiestoId, id, `M-${Date.now()}-f`, OPERADOR.id],
      );
      await sql('UPDATE qhse.desecho SET estado_id = $2 WHERE id = $1', [
        id,
        await estadoId('con_manifiesto'),
      ]);
      const documento = async (tipo: string, emitido: string | null) =>
        sql(
          'INSERT INTO qhse.desecho_documento (id, desecho_id, tipo, archivo_id, emitido_el, created_by) VALUES ($1, $2, $3::qhse.tipo_documento_desecho, $4, $5, $6)',
          [uuidv7(), id, tipo, await archivo(), emitido, OPERADOR.id],
        );
      // sin las tres firmas no se carga ningún documento
      await expect(documento('manifiesto_firmado', null)).rejects.toThrow(/tres firmas/);
      for (const [rol, nombre, cedula] of [
        ['despachado_por', null, null],
        ['transportado_por', 'Carlos', '1712345678'],
        ['recibido_por', 'Rosa', '1798765432'],
      ])
        await sql(
          'INSERT INTO qhse.desecho_firma (id, manifiesto_id, rol, registrado_por, firmante_nombre, firmante_cedula) VALUES ($1, $2, $3::qhse.rol_firma_desecho, $4, $5, $6)',
          [uuidv7(), manifiestoId, rol, OPERADOR.id, nombre, cedula],
        );
      // la fecha de emisión es del certificado y solo del certificado; no puede ser anterior al manifiesto
      await expect(documento('manifiesto_firmado', '2026-10-01')).rejects.toThrow(
        /desecho_documento_emision_check/,
      );
      await expect(documento('certificado_disposicion', null)).rejects.toThrow(
        /desecho_documento_emision_check/,
      );
      await expect(documento('certificado_disposicion', '2000-01-01')).rejects.toThrow(
        /anterior al manifiesto/,
      );
      // sin certificado no se dispone
      await expect(
        sql('UPDATE qhse.desecho SET estado_id = $2 WHERE id = $1', [
          id,
          await estadoId('dispuesto'),
        ]),
      ).rejects.toThrow(/certificado de disposición final/);
      await documento('manifiesto_firmado', null);
      await expect(documento('manifiesto_firmado', null)).rejects.toThrow(
        /desecho_documento_unico_key/,
      );
      await documento('certificado_disposicion', new Date().toISOString().slice(0, 10));

      // lo cargado no se reemplaza ni se borra; solo cambia el indicador de la lectura de firma
      await expect(
        t.prisma.desechoDocumento.updateMany({
          where: { desechoId: id },
          data: { archivoId: uuidv7() },
        }),
      ).rejects.toThrow(/permission denied|denegado/i);
      await expect(
        t.prisma.desechoDocumento.updateMany({
          where: { desechoId: id },
          data: { emitidoEl: new Date('2026-01-01') },
        }),
      ).rejects.toThrow(/permission denied|denegado/i);
      await expect(
        t.prisma.desechoDocumento.deleteMany({ where: { desechoId: id } }),
      ).rejects.toThrow(/permission denied|denegado/i);
      await t.prisma.desechoDocumento.updateMany({
        where: { desechoId: id },
        data: { verificacion: 'firma_detectada', verificacionConfianza: 0.5 },
      });
      await expect(
        t.prisma.desechoDocumento.updateMany({
          where: { desechoId: id },
          data: { verificacionConfianza: 1.5 },
        }),
      ).rejects.toThrow(/desecho_documento_confianza_check|out of range|numeric/i);
      await sql('UPDATE qhse.desecho SET estado_id = $2 WHERE id = $1', [
        id,
        await estadoId('dispuesto'),
      ]);
    });

    it('revisión S1: a un desecho no peligroso no se le agregan características CRETIB después, y las cantidades desmedidas se rechazan con 400', async () => {
      const id = await insertarDirecto(1); // no peligroso, almacenado
      await expect(
        sql(
          'INSERT INTO qhse.desecho_caracteristica_asignada (desecho_id, caracteristica_id) SELECT $1, id FROM qhse.desecho_caracteristica LIMIT 1',
          [id],
        ),
      ).rejects.toThrow(/no peligroso no lleva características CRETIB/);
      expect(
        (await registrar({ items: [linea({ cantidadGalones: 10_000_000_000 })] })).status,
      ).toBe(400);
      expect((await registrar({ items: [linea({ bultos: 99_999_999_999 })] })).status).toBe(400);
    });

    it('un contenedor, un estado o un pozo inexistentes no pasan (FK)', async () => {
      const c = await cabecera();
      c.params[2] = uuidv7();
      await expect(sql(c.texto, c.params)).rejects.toThrow(/desecho_contenedor_fkey/);
      const e = await cabecera();
      e.params[3] = uuidv7();
      await expect(sql(e.texto, e.params)).rejects.toThrow(/desecho_estado_fkey/);
      const id = await insertarDirecto(1);
      await expect(
        sql('UPDATE qhse.desecho SET pozo_id = $2 WHERE id = $1', [id, uuidv7()]),
      ).rejects.toThrow(/desecho_pozo_fkey/);
    });
  });
});
