/**
 * Integración real de QHSE: emisor de avisos por vencimiento (ART, requisitos legales, inspecciones, investigaciones, acciones, objetivos y
 * controles ambientales).
 *   RUN_INTEGRATION=1 npx jest avisos-programados   (dentro de libs/qhse/seguridad; requiere `npm run db:seed:qhse` y `npm run db:seed:archivos`)
 *
 * Cada llamada a `emitir` se limita a las entidades creadas por la prueba, para no avisar (ni marcar como avisados) datos de otras personas.
 * La fecha «de hoy» se adelanta con el parámetro `hoy` para llegar a los plazos sin esperar.
 */
import { Permission } from '@dyn/authz';
import { uuidv7 } from '@dyn/utils';
import { levantarAppDePrueba, type AppDePrueba } from '../testing/app-de-prueba';
import { borrarInvestigacionesDe } from '../testing/limpieza-investigaciones';
import { quitarMaestros, sembrarMaestros, type MaestrosDePrueba } from '../testing/maestros';
import { AvisosProgramadosService } from './avisos-programados.service';

const run = process.env['RUN_INTEGRATION'] ? describe : describe.skip;
const P = Permission;
const H = 3_600_000;
const n = Date.now();

const TECNICO = { id: uuidv7(), nombre: 'Tania Técnica HSE' };
const RESPONSABLE = { id: uuidv7(), nombre: 'Rolando Responsable' };
const OPERADOR = { id: uuidv7(), nombre: 'Oscar Operador' };
const MAESTROS: MaestrosDePrueba = {
  usuarios: [
    { ...TECNICO, rol: 'tecnico_hse' },
    { ...RESPONSABLE, rol: 'operador' },
    { ...OPERADOR, rol: 'operador' },
  ],
};

type Salida = { tipo: string; datos: { data: Record<string, unknown> } };
const fechaEn = (dias: number) =>
  new Date(Date.now() + dias * 86_400_000).toLocaleDateString('en-CA', {
    timeZone: 'America/Guayaquil',
  });

run('QHSE: avisos por vencimiento (base de datos real)', () => {
  jest.setTimeout(300000);
  let t: AppDePrueba;
  let avisos: AvisosProgramadosService;
  const entidades: string[] = [];
  const archivos: string[] = [];
  const pedido = uuidv7();
  const tipoLegal = uuidv7();
  const proceso = uuidv7();
  let modulo: Record<string, string> = {};
  const sql = (texto: string, params: unknown[] = []) => t.admin.query(texto, params);

  const tecnico = () =>
    t.token(
      'tecnico_hse',
      TECNICO.nombre,
      [
        P.INVESTIGACIONES_VER,
        P.INVESTIGACIONES_GESTIONAR,
        P.OBJETIVOS_AMBIENTALES_GESTIONAR,
        P.ASPECTOS_AMBIENTALES_VER,
        P.ASPECTOS_AMBIENTALES_GESTIONAR,
        P.QHSE_GESTIONAR,
      ],
      TECNICO.id,
    );
  const operador = () => t.token('operador', OPERADOR.nombre, [P.QHSE_REPORTAR], OPERADOR.id);

  /** Emite limitado a las entidades de la prueba. */
  // cada prueba fija las entidades que le corresponden: así lo que adelanta la fecha «de hoy» en una no hace vencer lo de otra
  let ambito: string[] = [];
  const emitir = (hoy: string) => avisos.emitir(hoy, ambito);
  const eventosDe = async (id: string) =>
    (
      await sql(
        "SELECT tipo, datos FROM msg_qhse.outbox WHERE tipo LIKE 'qhse.aviso.%' AND datos->'subject'->>'id' = $1 ORDER BY ocurrido_at, id",
        [id],
      )
    ).rows as Salida[];
  const tipos = async (id: string) => (await eventosDe(id)).map((e) => e.tipo);

  beforeAll(async () => {
    t = await levantarAppDePrueba('3180');
    avisos = t.app.get(AvisosProgramadosService);
    await sembrarMaestros(t.admin, MAESTROS);
    const r = await sql(
      "SELECT id, codigo FROM archivos.modulo_archivo WHERE codigo IN ('qhse_requisito_legal','qhse_documento_pedido')",
    );
    modulo = Object.fromEntries(
      r.rows.map((f: { id: string; codigo: string }) => [f.codigo, f.id]),
    );
    expect(Object.keys(modulo)).toHaveLength(2);
    await sql(
      "INSERT INTO qhse.requisito_legal_tipo (id, codigo, nombre, orden, created_by) VALUES ($1, $2, 'Matriz de prueba de avisos', $3, $4)",
      [tipoLegal, `avisos-${n}`, 600000 + (n % 90000), TECNICO.id],
    );
    await sql(
      "INSERT INTO qhse.iperc_proceso (id, codigo, nombre, orden, created_by) VALUES ($1, $2, 'Proceso de prueba de avisos', $3, $4)",
      [proceso, `TV-${n}`, 650000 + (n % 90000), TECNICO.id],
    );
    await sql(
      "INSERT INTO qhse.ticket_ref (ticket_id, pedido_id, pedido_codigo, cliente, campo, pozo) VALUES ($1, $2, $3, 'Cliente de prueba', 'Campo de prueba', 'Pozo de prueba')",
      [uuidv7(), pedido, `PED-AVISOS-${n}`],
    );
  });

  afterAll(async () => {
    await borrarInvestigacionesDe(t.admin, [TECNICO.id]);
    await sql('DELETE FROM qhse.documento_pedido WHERE pedido_id = $1', [pedido]);
    await sql('DELETE FROM qhse.ticket_ref WHERE pedido_id = $1', [pedido]);
    await sql('DELETE FROM qhse.requisito_legal WHERE tipo_id = $1', [tipoLegal]);
    await sql('DELETE FROM qhse.requisito_legal_tipo WHERE id = $1', [tipoLegal]);
    await sql('DELETE FROM qhse.inspeccion WHERE inspector_id = $1', [OPERADOR.id]);
    await sql('DELETE FROM qhse.equipo WHERE created_by = $1', [OPERADOR.id]);
    await sql('DELETE FROM qhse.objetivo_ambiental_accion WHERE created_by = $1', [TECNICO.id]);
    await sql('DELETE FROM qhse.objetivo_ambiental WHERE created_by = $1', [TECNICO.id]);
    await sql('DELETE FROM qhse.aspecto_ambiental WHERE created_by = $1', [TECNICO.id]);
    await sql('DELETE FROM qhse.iperc_proceso WHERE id = $1', [proceso]);
    await sql(
      "DELETE FROM msg_qhse.outbox WHERE tipo LIKE 'qhse.aviso.%' AND datos->'subject'->>'id' = ANY($1::text[])",
      [entidades],
    );
    await sql('DELETE FROM qhse.aviso_programado WHERE entidad_id = ANY($1::uuid[])', [entidades]);
    await sql('DELETE FROM archivos.archivo WHERE id = ANY($1::uuid[])', [archivos]);
    await quitarMaestros(t.admin, MAESTROS);
    await t.cerrar();
  });

  /** Un archivo ya subido por el módulo de archivos. */
  const archivo = async (codigoModulo: string) => {
    const id = uuidv7();
    archivos.push(id);
    await sql(
      `INSERT INTO archivos.archivo (id, modulo_id, nombre_original, mime_type, tamano_bytes, sha256, blob_key, escaneo, subido_por)
       VALUES ($1, $2, 'doc.pdf', 'application/pdf', 10, $3, $4, 'omitido', $5)`,
      [
        id,
        modulo[codigoModulo],
        id.replace(/-/g, '').padEnd(64, '0'),
        `qhse-test/${n}/${id}`,
        TECNICO.id,
      ],
    );
    return id;
  };

  describe('ART', () => {
    it('avisa 3 días antes (por vencer) y cuando vence (vencido), una sola vez cada hecho', async () => {
      const id = uuidv7();
      entidades.push(id);
      ambito = [id];
      // el ART vence a los 15 días de su emisión (CHECK de la base)
      await sql(
        "INSERT INTO qhse.documento_pedido (id, pedido_id, tipo, archivo_id, fecha, vigente_hasta, created_by) VALUES ($1, $2, 'art', $3, CURRENT_DATE, CURRENT_DATE + 15, $4)",
        [id, pedido, await archivo('qhse_documento_pedido'), TECNICO.id],
      );
      // 20 días antes del vencimiento no hay nada que avisar
      expect((await emitir(fechaEn(-5))).total).toBe(0);
      // a 2 días de vencer
      expect((await emitir(fechaEn(13))).porTipo).toEqual({ 'qhse.aviso.art_por_vencer': 1 });
      expect((await emitir(fechaEn(14))).total).toBe(0);
      // vencido
      expect((await emitir(fechaEn(20))).porTipo).toEqual({ 'qhse.aviso.art_vencido': 1 });
      expect((await emitir(fechaEn(30))).total).toBe(0);
      const ev = await eventosDe(id);
      expect(ev.map((e) => e.tipo)).toEqual([
        'qhse.aviso.art_por_vencer',
        'qhse.aviso.art_vencido',
      ]);
      expect(ev[0].datos.data).toMatchObject({
        pedidoCodigo: `PED-AVISOS-${n}`,
        cliente: 'Cliente de prueba',
        campo: 'Campo de prueba',
        pozo: 'Pozo de prueba',
        vigenteHasta: fechaEn(15),
        diasParaVencer: 2,
      });
    });

    it('un ART vencido no avisa si el pedido ya tiene otro ART que vence después', async () => {
      const viejo = uuidv7();
      const nuevo = uuidv7();
      const otroPedido = uuidv7();
      entidades.push(viejo, nuevo);
      ambito = [viejo, nuevo];
      await sql(
        'INSERT INTO qhse.ticket_ref (ticket_id, pedido_id, pedido_codigo) VALUES ($1, $2, $3)',
        [uuidv7(), otroPedido, `PED-AVISOS-B-${n}`],
      );
      for (const [id, dias] of [
        [viejo, -20],
        [nuevo, 0],
      ] as const)
        await sql(
          `INSERT INTO qhse.documento_pedido (id, pedido_id, tipo, archivo_id, fecha, vigente_hasta, created_by)
           VALUES ($1, $2, 'art', $3, CURRENT_DATE + $5::int, CURRENT_DATE + $5::int + 15, $4)`,
          [id, otroPedido, await archivo('qhse_documento_pedido'), TECNICO.id, dias],
        );
      await emitir(fechaEn(0));
      expect(await tipos(viejo)).toEqual([]);
      expect(await tipos(nuevo)).toEqual([]);
      await sql('DELETE FROM qhse.documento_pedido WHERE pedido_id = $1', [otroPedido]);
      await sql('DELETE FROM qhse.ticket_ref WHERE pedido_id = $1', [otroPedido]);
    });
  });

  describe('requisitos legales', () => {
    it('avisa por vencer (30 días) y vencido; una revisión nueva con otra vigencia vuelve a avisar', async () => {
      const id = uuidv7();
      entidades.push(id);
      ambito = [id];
      await sql(
        "INSERT INTO qhse.requisito_legal (id, tipo_id, revision, fecha_aprobacion, vigente_hasta, archivo_id, created_by) VALUES ($1, $2, 'Rev. 01', CURRENT_DATE - 10, CURRENT_DATE + 40, $3, $4)",
        [id, tipoLegal, await archivo('qhse_requisito_legal'), TECNICO.id],
      );
      expect((await emitir(fechaEn(0))).total).toBe(0);
      expect((await emitir(fechaEn(15))).porTipo).toEqual({
        'qhse.aviso.requisito_legal_por_vencer': 1,
      });
      expect((await emitir(fechaEn(16))).total).toBe(0);
      expect((await emitir(fechaEn(45))).porTipo).toEqual({
        'qhse.aviso.requisito_legal_vencido': 1,
      });
      const ev = await eventosDe(id);
      expect(ev[0].datos.data).toMatchObject({
        tipo: `avisos-${n}`,
        tipoNombre: 'Matriz de prueba de avisos',
        revision: 'Rev. 01',
        vigenteHasta: fechaEn(40),
        diasParaVencer: 25,
      });
      // una revisión reemplazada ya no vence: no hay más avisos de ella
      await sql(
        "UPDATE qhse.requisito_legal SET estado = 'reemplazado', reemplazado_at = now(), reemplazado_por = $2 WHERE id = $1",
        [id, TECNICO.id],
      );
      const nueva = uuidv7();
      entidades.push(nueva);
      ambito = [id, nueva];
      await sql(
        "INSERT INTO qhse.requisito_legal (id, tipo_id, revision, fecha_aprobacion, vigente_hasta, archivo_id, created_by) VALUES ($1, $2, 'Rev. 02', CURRENT_DATE, CURRENT_DATE + 50, $3, $4)",
        [nueva, tipoLegal, await archivo('qhse_requisito_legal'), TECNICO.id],
      );
      expect((await emitir(fechaEn(45))).porTipo).toEqual({
        'qhse.aviso.requisito_legal_por_vencer': 1,
      });
      expect(await tipos(id)).toHaveLength(2);
    });
  });

  describe('inspecciones', () => {
    it('avisa cuando vence la vigencia de la última inspección aprobada de un equipo', async () => {
      const ts = (await t.http().get('/api/qhse/inspecciones/tipos').set(operador()))
        .body as Array<{
        id: string;
        codigo: string;
        criterios: Array<{ id: string }>;
      }>;
      const eslinga = ts.find((x) => x.codigo === 'eslinga_cable') as (typeof ts)[number];
      const r = await t
        .http()
        .post('/api/qhse/inspecciones')
        .set(operador())
        .send({
          tipoId: eslinga.id,
          equipoCodigo: `EQ-AVISOS-${n}`,
          resultados: eslinga.criterios.map((c) => ({ criterioId: c.id, cumple: true })),
        });
      expect(r.status).toBe(201);
      entidades.push(r.body.id);
      ambito = [r.body.id];
      expect((await emitir(fechaEn(0))).total).toBe(0);
      // la vigencia es trimestral: a los 4 meses está vencida
      const resultado = await emitir(fechaEn(125));
      expect(resultado.porTipo).toEqual({ 'qhse.aviso.inspeccion_vencida': 1 });
      expect((await emitir(fechaEn(126))).total).toBe(0);
      const ev = await eventosDe(r.body.id);
      expect(ev[0].datos.data).toMatchObject({
        equipoCodigo: `EQ-AVISOS-${n}`,
        tipoNombre: expect.any(String),
      });
    });
  });

  describe('investigaciones', () => {
    const abrir = async (diasAtras: number, iniciar: boolean) => {
      const nearMiss = (
        await t.http().get('/api/qhse/investigaciones/resultados').set(tecnico())
      ).body.find((x: { codigo: string }) => x.codigo === 'near_miss').id;
      const r = await t
        .http()
        .post('/api/qhse/investigaciones')
        .set(tecnico())
        .send({
          resultadoId: nearMiss,
          descripcionEvento: 'Evento de prueba de avisos',
          fechaIncidente: new Date(Date.now() - diasAtras * 24 * H).toISOString(),
          ubicacion: 'Locación de avisos',
        });
      expect(r.status).toBe(201);
      entidades.push(r.body.id);
      if (iniciar)
        await t
          .http()
          .post(`/api/qhse/investigaciones/${r.body.id}/iniciar`)
          .set(tecnico())
          .send({ liderId: TECNICO.id });
      return r.body.id as string;
    };

    it('avisa que no se inició a tiempo y que el informe final está por vencer y luego vencido', async () => {
      // near miss: 72 h para iniciar y 30 días para el informe final
      const id = await abrir(27, false);
      ambito = [id];
      const r1 = await emitir(fechaEn(0));
      expect(r1.porTipo).toEqual({
        'qhse.aviso.investigacion_inicio_vencido': 1,
        'qhse.aviso.investigacion_final_por_vencer': 1,
      });
      expect((await emitir(fechaEn(0))).total).toBe(0);
      expect((await emitir(fechaEn(5))).porTipo).toEqual({
        'qhse.aviso.investigacion_final_vencido': 1,
      });
      const ev = await eventosDe(id);
      expect(ev.map((e) => e.tipo).sort()).toEqual([
        'qhse.aviso.investigacion_final_por_vencer',
        'qhse.aviso.investigacion_final_vencido',
        'qhse.aviso.investigacion_inicio_vencido',
      ]);
      expect(ev.find((e) => e.tipo.endsWith('final_por_vencer'))?.datos.data).toMatchObject({
        codigo: expect.stringMatching(/^INV-\d{6}$/),
        resultadoNombre: expect.stringContaining('Near Miss'),
        ubicacion: 'Locación de avisos',
        limite: fechaEn(3),
        diasParaVencer: 3,
      });
    });

    it('una investigación ya iniciada no avisa «sin iniciar»; una reciente no avisa nada; una cerrada tampoco', async () => {
      const iniciada = await abrir(10, true);
      const reciente = await abrir(0, false);
      ambito = [iniciada, reciente];
      await emitir(fechaEn(0));
      expect(await tipos(iniciada)).toEqual([]);
      expect(await tipos(reciente)).toEqual([]);
    });

    it('avisa al equipo HSE y a quien debe implementar una acción que pasó su plazo', async () => {
      const id = await abrir(2, true);
      ambito = [id];
      const a = await t
        .http()
        .post(`/api/qhse/investigaciones/${id}/acciones`)
        .set(tecnico())
        .send({
          descripcion: 'Reponer la señalización',
          tipo: 'correctiva',
          responsableId: RESPONSABLE.id,
          plazo: fechaEn(10),
        });
      const accionId = a.body.acciones[0].id as string;
      entidades.push(accionId);
      ambito = [id, accionId];
      expect((await emitir(fechaEn(5))).total).toBe(0);
      const r = await emitir(fechaEn(11));
      expect(r.porTipo).toEqual({
        'qhse.aviso.accion_investigacion_vencida': 1,
        'qhse.aviso.accion_investigacion_vencida_responsable': 1,
      });
      const ev = await eventosDe(accionId);
      const hse = ev.find((e) => e.tipo === 'qhse.aviso.accion_investigacion_vencida');
      const responsable = ev.find((e) => e.tipo.endsWith('_responsable'));
      expect(hse?.datos.data).toMatchObject({
        descripcion: 'Reponer la señalización',
        responsable: RESPONSABLE.nombre,
        plazo: fechaEn(10),
        orden: 1,
      });
      // solo el aviso del responsable lleva `asignados` (con él, el aviso es únicamente para esa persona)
      expect(hse?.datos.data['asignados']).toBeUndefined();
      expect(responsable?.datos.data['asignados']).toEqual([
        { usuarioId: RESPONSABLE.id, rolCodigo: 'responsable_accion' },
      ]);
      // una acción implementada ya no vence
      const otra = await t
        .http()
        .post(`/api/qhse/investigaciones/${id}/acciones`)
        .set(tecnico())
        .send({
          descripcion: 'Otra',
          tipo: 'preventiva',
          responsableId: RESPONSABLE.id,
          plazo: fechaEn(10),
        });
      const otraId = otra.body.acciones[1].id as string;
      entidades.push(otraId);
      ambito = [id, accionId, otraId];
      await t
        .http()
        .post(`/api/qhse/investigaciones/${id}/acciones/${otraId}/implementar`)
        .set(tecnico())
        .send({});
      await emitir(fechaEn(11));
      expect(await tipos(otraId)).toEqual([]);
    });
  });

  describe('gestión ambiental', () => {
    it('objetivos ambientales: por vencer a 30 días y vencido; uno cerrado no avisa', async () => {
      const crear = async (plazo: string) => {
        const r = await t.http().post('/api/qhse/objetivos-ambientales').set(tecnico()).send({
          titulo: 'Objetivo de prueba de avisos',
          objetivo: 'o',
          meta: 'm',
          indicador: 'i',
          plazo,
        });
        expect(r.status).toBe(201);
        entidades.push(r.body.id);
        return r.body.id as string;
      };
      const proximo = await crear(fechaEn(20));
      const cerrado = await crear(fechaEn(20));
      ambito = [proximo, cerrado];
      await t
        .http()
        .post(`/api/qhse/objetivos-ambientales/${cerrado}/cerrar`)
        .set(tecnico())
        .send({ estado: 'cumplido', resultado: 'Logrado' });
      expect((await emitir(fechaEn(0))).porTipo).toEqual({
        'qhse.aviso.objetivo_ambiental_por_vencer': 1,
      });
      expect((await emitir(fechaEn(25))).porTipo).toEqual({
        'qhse.aviso.objetivo_ambiental_vencido': 1,
      });
      expect(await tipos(cerrado)).toEqual([]);
      const ev = await eventosDe(proximo);
      expect(ev[0].datos.data).toMatchObject({
        codigo: expect.stringMatching(/^OBJ-\d{6}$/),
        titulo: 'Objetivo de prueba de avisos',
        plazo: fechaEn(20),
        diasParaVencer: 20,
      });
    });

    it('controles de aspectos ambientales: vencido si no se implementó; implementado no avisa', async () => {
      const cat = (await t.http().get('/api/qhse/aspectos-ambientales/catalogos').set(tecnico()))
        .body;
      const crear = async (cuerpo: Record<string, unknown>) => {
        const r = await t
          .http()
          .post('/api/qhse/aspectos-ambientales')
          .set(tecnico())
          .send({
            etapaId: cat.etapas[0].id,
            procesoId: proceso,
            actividad: 'Actividad de prueba de avisos',
            aspecto: 'a',
            impacto: 'i',
            probabilidad: 2,
            consecuencia: 3,
            clasificacion: 'moderado',
            plazo: fechaEn(5),
            ...cuerpo,
          });
        expect(r.status).toBe(201);
        entidades.push(r.body.id);
        return r.body.id as string;
      };
      const pendiente = await crear({});
      const hecho = await crear({ estadoControl: 'implementado' });
      ambito = [pendiente, hecho];
      expect((await emitir(fechaEn(0))).total).toBe(0);
      expect((await emitir(fechaEn(10))).porTipo).toEqual({
        'qhse.aviso.control_ambiental_vencido': 1,
      });
      expect(await tipos(hecho)).toEqual([]);
      expect((await eventosDe(pendiente))[0].datos.data).toMatchObject({
        codigo: expect.stringMatching(/^ASP-\d{6}$/),
        actividad: 'Actividad de prueba de avisos',
        clasificacion: 'moderado',
        plazo: fechaEn(5),
      });
    });
  });

  describe('a pedido y reglas de la base', () => {
    it('la revisión a pedido exige el permiso de gestión de QHSE', async () => {
      // solo se prueba el rechazo: ejecutarla de verdad avisaría (y marcaría como avisados) datos de otras personas en la base compartida
      expect((await t.http().post('/api/qhse/avisos/ejecutar').set(operador())).status).toBe(403);
      // limitada a entidades que no existen, devuelve el resumen vacío
      expect(await avisos.emitir(fechaEn(0), [uuidv7()])).toEqual({ total: 0, porTipo: {} });
    });

    it('la clave de un hecho avisado no se reescribe ni se borra (solo se agrega)', async () => {
      const algo = (
        await sql(
          'SELECT clave FROM qhse.aviso_programado WHERE entidad_id = ANY($1::uuid[]) LIMIT 1',
          [entidades],
        )
      ).rows[0];
      expect(algo).toBeDefined();
      await expect(
        t.prisma.avisoProgramado.deleteMany({ where: { clave: algo.clave } }),
      ).rejects.toThrow(/permission denied|denegado/i);
      await expect(
        t.prisma.avisoProgramado.updateMany({
          where: { clave: algo.clave },
          data: { tipo: 'otro' },
        }),
      ).rejects.toThrow(/permission denied|denegado/i);
      await expect(
        sql("INSERT INTO qhse.aviso_programado (clave, tipo, entidad_id) VALUES (' ', 'x', $1)", [
          uuidv7(),
        ]),
      ).rejects.toThrow(/aviso_programado_clave_check/);
    });
  });
});
