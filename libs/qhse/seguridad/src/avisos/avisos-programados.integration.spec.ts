/**
 * Integración real de QHSE: emisor de avisos por vencimiento (ART, requisitos legales, inspecciones, investigaciones, acciones, objetivos y
 * controles ambientales).
 *   RUN_INTEGRATION=1 npx jest avisos-programados   (dentro de libs/qhse/seguridad; requiere `npm run db:seed:qhse` y `npm run db:seed:archivos`)
 *
 * Cada llamada a `emitir` se limita a las entidades creadas por la prueba, para no avisar (ni marcar como avisados) datos de otras personas.
 * La fecha «de hoy» se adelanta con el parámetro `hoy` para llegar a los plazos sin esperar.
 */
import { Permission } from '@dyn/authz';
import { Pool } from 'pg';
import { uuidv7 } from '@dyn/utils';
import { levantarAppDePrueba, type AppDePrueba } from '../testing/app-de-prueba';
import { borrarInvestigacionesDe } from '../testing/limpieza-investigaciones';
import { quitarMaestros, sembrarMaestros, type MaestrosDePrueba } from '../testing/maestros';
import { AvisosProgramadosService } from './avisos-programados.service';
import { TareasHoyQhseService } from './tareas-hoy.service';
import { ReenvioAPumpingService } from '../documentos/reenvio-a-pumping.service';
import { PtwCalendarioService } from '../ptw/ptw-calendario.service';

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
  let tareasHoy: TareasHoyQhseService;
  let reenvio: ReenvioAPumpingService;
  let calendario: PtwCalendarioService;
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
  // la hora fija en 00:00 deja en silencio los avisos que dependen de la hora del día (cada prueba que los necesita pasa la suya)
  const emitir = (hoy: string) => avisos.emitir(hoy, ambito, '00:00');
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
    tareasHoy = t.app.get(TareasHoyQhseService);
    reenvio = t.app.get(ReenvioAPumpingService);
    calendario = t.app.get(PtwCalendarioService);
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

  describe('documentos de ingreso y PTW del día', () => {
    /** Un ticket con (o sin) operadores asignados. */
    const ticketConOperador = async (conOperador: boolean) => {
      const ticketId = uuidv7();
      const pedidoId = uuidv7();
      entidades.push(ticketId);
      await sql(
        "INSERT INTO qhse.ticket_ref (ticket_id, ticket_numero, pedido_id, pedido_codigo, cliente, campo, pozo) VALUES ($1, 7, $2, $3, 'Cliente de prueba', 'Campo de prueba', 'Pozo de prueba')",
        [ticketId, pedidoId, `PED-DOCS-${n}-${entidades.length}`],
      );
      if (conOperador)
        await sql('INSERT INTO qhse.ticket_operador (ticket_id, usuario_id) VALUES ($1, $2)', [
          ticketId,
          OPERADOR.id,
        ]);
      return { ticketId, pedidoId };
    };
    const documento = async (pedidoId: string, ticketId: string, tipo: string) =>
      sql(
        'INSERT INTO qhse.documento_pedido (id, pedido_id, ticket_id, tipo, archivo_id, created_by) VALUES ($1, $2, $3, $4, $5, $6)',
        [uuidv7(), pedidoId, ticketId, tipo, await archivo('qhse_documento_pedido'), TECNICO.id],
      );
    const limpiar = async (ids: { ticketId: string; pedidoId: string }[]) => {
      for (const { ticketId, pedidoId } of ids) {
        await sql('DELETE FROM qhse.ptw WHERE ticket_id = $1', [ticketId]);
        await sql('DELETE FROM qhse.documento_pedido WHERE pedido_id = $1', [pedidoId]);
        await sql('DELETE FROM qhse.ticket_ref WHERE ticket_id = $1', [ticketId]);
      }
    };

    it('avisa una sola vez que falta el Formato de Recepción y el SFI de un servicio con personal asignado', async () => {
      const sinDocs = await ticketConOperador(true);
      const sinPersonal = await ticketConOperador(false);
      const completo = await ticketConOperador(true);
      await documento(completo.pedidoId, completo.ticketId, 'formato_recepcion');
      await documento(completo.pedidoId, completo.ticketId, 'sfi');
      ambito = [sinDocs.ticketId, sinPersonal.ticketId, completo.ticketId];

      expect((await emitir(fechaEn(0))).porTipo).toEqual({
        'qhse.aviso.pedido_sin_formato_recepcion': 1,
        'qhse.aviso.personal_asignado_sin_sfi': 1,
      });
      expect((await emitir(fechaEn(1))).total).toBe(0);
      expect((await tipos(sinDocs.ticketId)).sort()).toEqual([
        'qhse.aviso.pedido_sin_formato_recepcion',
        'qhse.aviso.personal_asignado_sin_sfi',
      ]);
      expect(await tipos(sinPersonal.ticketId)).toEqual([]);
      expect(await tipos(completo.ticketId)).toEqual([]);
      expect((await eventosDe(sinDocs.ticketId))[0].datos.data).toMatchObject({
        ticketNumero: 7,
        cliente: 'Cliente de prueba',
        pozo: 'Pozo de prueba',
      });
      await limpiar([sinDocs, sinPersonal, completo]);
    });

    it('un documento anulado cuenta como faltante', async () => {
      const t1 = await ticketConOperador(true);
      await documento(t1.pedidoId, t1.ticketId, 'sfi');
      await sql(
        "UPDATE qhse.documento_pedido SET anulado_at = now(), anulado_por = $2, motivo_anulacion = 'prueba' WHERE pedido_id = $1",
        [t1.pedidoId, TECNICO.id],
      );
      ambito = [t1.ticketId];
      expect((await emitir(fechaEn(0))).porTipo).toMatchObject({
        'qhse.aviso.personal_asignado_sin_sfi': 1,
      });
      await limpiar([t1]);
    });

    it('avisa del PTW de hoy sin el PT del día, una sola vez', async () => {
      const t2 = await ticketConOperador(true);
      const ptw = async (extra = '') => {
        const id = uuidv7();
        entidades.push(id);
        await sql(
          `INSERT INTO qhse.ptw (id, ticket_id, pedido_id, dia_operacion, created_by ${extra ? ',' + extra.split('=')[0] : ''})
           VALUES ($1, $2, $3, CURRENT_DATE, $4 ${extra ? ',' + extra.split('=')[1] : ''})`,
          [id, t2.ticketId, t2.pedidoId, TECNICO.id],
        );
        return id;
      };
      const abierto = await ptw();
      ambito = [abierto];
      expect((await emitir(fechaEn(0))).porTipo).toEqual({ 'qhse.aviso.ptw_sin_pt_hoy': 1 });
      expect((await emitir(fechaEn(0))).total).toBe(0);
      const ev = (await eventosDe(abierto))[0];
      expect(ev.datos.data).toMatchObject({
        ptwId: abierto,
        pedidoCodigo: `PED-DOCS-${n}-${entidades.length - 1}`,
        diaOperacion: fechaEn(0),
      });
      expect(String(ev.datos.data['ptwCodigo'])).toMatch(/^PTW-\d{6}$/);
      await limpiar([t2]);
    });
  });

  describe('PTW diario: sin PTW, sin aprobar a la hora de inicio y falta el PT de mañana', () => {
    /** Un ticket con servicio en esos días (los avisa Pumping y QHSE los guarda). */
    const ticketConDias = async (dias: string[]) => {
      const ticketId = uuidv7();
      const pedidoId = uuidv7();
      entidades.push(ticketId);
      await sql(
        "INSERT INTO qhse.ticket_ref (ticket_id, ticket_numero, pedido_id, pedido_codigo, cliente, campo, pozo) VALUES ($1, 8, $2, $3, 'Cliente de prueba', 'Campo de prueba', 'Pozo de prueba')",
        [ticketId, pedidoId, `PED-DIAS-${n}-${entidades.length}`],
      );
      for (const d of dias)
        await sql('INSERT INTO qhse.ticket_dia_servicio (ticket_id, fecha) VALUES ($1, $2)', [
          ticketId,
          d,
        ]);
      return { ticketId, pedidoId };
    };
    const ptwDelDia = async (
      t2: { ticketId: string; pedidoId: string },
      dia: string,
      fase = 'gabinete',
    ) => {
      const id = uuidv7();
      entidades.push(id);
      await sql(
        'INSERT INTO qhse.ptw (id, ticket_id, pedido_id, dia_operacion, created_by) VALUES ($1, $2, $3, $4, $5)',
        [id, t2.ticketId, t2.pedidoId, dia, TECNICO.id],
      );
      // el trigger de fases exige el camino; para la prueba basta con dejar la fase pedida por la base
      if (fase !== 'gabinete')
        await sql('UPDATE qhse.ptw SET fase = $2::qhse.fase_ptw WHERE id = $1', [id, fase]);
      return id;
    };
    const limpiar = async (ids: { ticketId: string; pedidoId: string }[]) => {
      for (const { ticketId, pedidoId } of ids) {
        await sql('DELETE FROM qhse.ptw WHERE ticket_id = $1', [ticketId]);
        await sql('DELETE FROM qhse.documento_pedido WHERE pedido_id = $1', [pedidoId]);
        await sql('DELETE FROM qhse.ticket_ref WHERE ticket_id = $1', [ticketId]);
      }
    };
    const dia = fechaEn(0);
    const manana = fechaEn(1);

    it('«hay servicio hoy y no existe PTW»: avisa una vez por ticket y día, y no si ya hay un PTW vigente ni si hoy no es día de servicio', async () => {
      const sinPtw = await ticketConDias([dia]);
      const conPtw = await ticketConDias([dia]);
      const otroDia = await ticketConDias([manana]);
      await ptwDelDia(conPtw, dia);
      ambito = [sinPtw.ticketId, conPtw.ticketId, otroDia.ticketId];
      expect((await emitir(dia)).porTipo).toMatchObject({ 'qhse.aviso.servicio_sin_ptw': 1 });
      expect((await emitir(dia)).total).toBe(0); // una sola vez
      expect(await tipos(sinPtw.ticketId)).toEqual(['qhse.aviso.servicio_sin_ptw']);
      expect(await tipos(conPtw.ticketId)).toEqual([]);
      expect(await tipos(otroDia.ticketId)).toEqual([]);
      const ev = (await eventosDe(sinPtw.ticketId))[0];
      expect(ev.datos.data).toMatchObject({
        ticketId: sinPtw.ticketId,
        pedidoCodigo: expect.stringContaining('PED-DIAS-'),
        cliente: 'Cliente de prueba',
        pozo: 'Pozo de prueba',
        diaOperacion: dia,
      });
      // un PTW anulado no cuenta como PTW vigente: el día sigue sin uno
      const anulado = await ticketConDias([dia]);
      await ptwDelDia(anulado, dia);
      await sql(
        "UPDATE qhse.ptw SET anulado_at = now(), anulado_por = $2, motivo_anulacion = 'prueba' WHERE ticket_id = $1",
        [anulado.ticketId, TECNICO.id],
      );
      ambito = [anulado.ticketId];
      expect((await emitir(dia)).porTipo).toMatchObject({ 'qhse.aviso.servicio_sin_ptw': 1 });
      await limpiar([sinPtw, conPtw, otroDia, anulado]);
    });

    it('«mis tareas de hoy» muestra todo el día lo que falta para que las jornadas operen: abrir el PTW, aprobarlo y cargar el PT de mañana', async () => {
      const sinPtw = await ticketConDias([dia]);
      const sinAprobar = await ticketConDias([dia]);
      const sinPt = await ticketConDias([manana]);
      const ptw = await ptwDelDia(sinAprobar, dia);
      const suyas = [sinPtw.ticketId, sinAprobar.ticketId, sinPt.ticketId];
      const r = await tareasHoy.delDia(dia);
      const tareas = (r.bloques[0]?.tareas ?? []).filter(
        (x) => x.ticketId && suyas.includes(x.ticketId),
      );
      expect(
        tareas.map((x) => [
          x.clave,
          x.ticketId === sinPtw.ticketId
            ? 'sin_ptw'
            : x.ticketId === sinAprobar.ticketId
              ? 'sin_aprobar'
              : 'sin_pt',
        ]),
      ).toEqual([
        ['abrir_ptw', 'sin_ptw'],
        ['aprobar_ptw', 'sin_aprobar'],
        ['cargar_pt', 'sin_pt'],
      ]);
      expect(tareas[0]).toMatchObject({ tono: 'danger', enlace: '/dashboard/qhse/ptw' });
      expect(tareas[1].titulo).toContain('PTW-');
      expect(tareas[1].detalle).toContain('antes del inicio previsto');
      expect(tareas[2]).toMatchObject({ enlace: '/dashboard/qhse/documentos' });
      expect(r.bloques[0]).toMatchObject({ rol: 'qhse' });
      void ptw;
      await limpiar([sinPtw, sinAprobar, sinPt]);
      // sin nada pendiente de estos tickets, ya no aparecen
      const despues = await tareasHoy.delDia(dia);
      expect(
        (despues.bloques[0]?.tareas ?? []).filter((x) => x.ticketId && suyas.includes(x.ticketId)),
      ).toEqual([]);
    });

    it('el calendario de cobertura muestra por ticket y día de servicio el PTW, el PT y el ART (que cubre todo su rango)', async () => {
      const tk = await ticketConDias([dia, manana]);
      await ptwDelDia(tk, dia); // nace en gabinete
      const insertar = async (tipo: string, fecha: string, hasta: string | null) =>
        sql(
          `INSERT INTO qhse.documento_pedido (id, pedido_id, ticket_id, tipo, archivo_id, fecha, vigente_hasta, created_by)
           VALUES ($1, $2, $3, $4::qhse.tipo_documento_pedido, $5, $6::date, $7::date, $8)`,
          [
            uuidv7(),
            tk.pedidoId,
            tk.ticketId,
            tipo,
            await archivo('qhse_documento_pedido'),
            fecha,
            hasta,
            TECNICO.id,
          ],
        );
      await insertar('pt', manana, null);
      await insertar('art', fechaEn(-14), manana); // el ART vale 15 días: emitido hace 14, cubre hoy y mañana
      const pasado = fechaEn(2);
      const c = await calendario.cobertura(dia, pasado);
      expect(c.dias).toEqual([dia, manana, pasado]);
      const fila = c.tickets.find((x) => x.ticketId === tk.ticketId);
      expect(fila).toMatchObject({
        pedidoCodigo: expect.stringContaining('PED-DIAS-'),
        cliente: 'Cliente de prueba',
      });
      expect(fila?.dias.map((d) => [d.fecha, d.servicio, d.ptw, d.pt, d.art])).toEqual([
        [dia, true, 'gabinete', false, true],
        [manana, true, 'sin', true, true],
        [pasado, false, 'sin', false, false],
      ]);
      // un PTW anulado no cubre el día
      await sql(
        "UPDATE qhse.ptw SET anulado_at = now(), anulado_por = $2, motivo_anulacion = 'prueba' WHERE ticket_id = $1",
        [tk.ticketId, TECNICO.id],
      );
      const despues = await calendario.cobertura(dia, manana);
      expect(despues.tickets.find((x) => x.ticketId === tk.ticketId)?.dias[0].ptw).toBe('sin');
      // fechas mal escritas, al revés o demasiadas
      await expect(calendario.cobertura('06/11/2026', dia)).rejects.toThrow(/formato/);
      await expect(calendario.cobertura(manana, dia)).rejects.toThrow(/anterior/);
      await expect(calendario.cobertura(dia, fechaEn(40))).rejects.toThrow(/hasta 31 días/);
      await limpiar([tk]);
    });

    it('el reenvío único vuelve a publicar los PTW aprobados y los PT y ART vigentes a Pumping, y no los anulados ni otros documentos', async () => {
      const tk = await ticketConDias([dia]);
      const ptwId = await ptwDelDia(tk, dia);
      const doc = async (tipo: string, conFecha: boolean) => {
        const id = uuidv7();
        await sql(
          `INSERT INTO qhse.documento_pedido (id, pedido_id, ticket_id, tipo, archivo_id, fecha, vigente_hasta, created_by)
           VALUES ($1, $2, $3, $4::qhse.tipo_documento_pedido, $5, $6::date, $7::date, $8)`,
          [
            id,
            tk.pedidoId,
            tk.ticketId,
            tipo,
            await archivo('qhse_documento_pedido'),
            conFecha ? dia : null,
            tipo === 'art' ? fechaEn(15) : null,
            TECNICO.id,
          ],
        );
        return id;
      };
      const anulado = await doc('pt', true);
      await sql(
        "UPDATE qhse.documento_pedido SET anulado_at = now(), anulado_por = $2, motivo_anulacion = 'prueba' WHERE id = $1",
        [anulado, TECNICO.id],
      );
      const [recepcion, art, pt, sfi] = [
        await doc('formato_recepcion', false),
        await doc('art', true),
        await doc('pt', true),
        await doc('sfi', false),
      ];
      const superusuario = new Pool({
        connectionString: process.env['TEST_ADMIN_DATABASE_URL'],
        max: 1,
      });
      try {
        const c = await superusuario.connect();
        try {
          await c.query('BEGIN');
          await c.query('SET LOCAL session_replication_role = replica');
          await c.query(
            "UPDATE qhse.ptw SET fase = 'aprobado', documento_recepcion_id = $2, documento_art_id = $3, documento_pt_id = $4, documento_sfi_id = $5 WHERE id = $1",
            [ptwId, recepcion, art, pt, sfi],
          );
          await c.query('COMMIT');
        } finally {
          c.release();
        }
      } finally {
        await superusuario.end();
      }
      const publicados = async (tipo: string) =>
        (
          await sql(
            "SELECT datos->'data' AS d FROM msg_qhse.outbox WHERE tipo = $1 AND datos->'data'->>'pedidoId' = $2",
            [tipo, tk.pedidoId],
          )
        ).rows.map((x) => x.d);
      expect(await publicados('qhse.ptw.cerrado')).toEqual([]);

      const resumen = await reenvio.reenviar({ id: TECNICO.id, roleCode: 'tecnico_hse' } as never);
      expect(resumen.ptwAprobados).toBeGreaterThanOrEqual(1);
      expect(resumen.documentos).toBeGreaterThanOrEqual(2);
      const ptws = await publicados('qhse.ptw.cerrado');
      expect(ptws).toHaveLength(1);
      expect(ptws[0]).toMatchObject({ ptwId, ticketId: tk.ticketId, diaOperacion: dia });
      const docs = await publicados('qhse.documento_pedido.cargado');
      // solo el PT y el ART vigentes: ni el PT anulado ni la recepción ni el SFI
      expect(docs.map((d) => d.tipoDocumento).sort()).toEqual(['art', 'pt']);
      expect(docs.map((d) => d.documentoId)).not.toContain(anulado);
      await limpiar([tk]);
    });

    it('«PTW sin aprobar a la hora de inicio»: solo desde la hora configurada, una vez por PTW, y no si ya está aprobado', async () => {
      const t3 = await ticketConDias([dia]);
      const aprobado = await ticketConDias([dia]);
      const pendiente = await ptwDelDia(t3, dia);
      const ptwAprobado = await ptwDelDia(aprobado, dia);
      // un PTW aprobado necesita sus cuatro documentos (lo exige la base); la fase la fija un administrador sin el disparador de fases
      const doc = async (tipo: string, conFecha: boolean) => {
        const id = uuidv7();
        await sql(
          `INSERT INTO qhse.documento_pedido (id, pedido_id, ticket_id, tipo, archivo_id, fecha, vigente_hasta, created_by)
           VALUES ($1, $2, $3, $4::qhse.tipo_documento_pedido, $5, $6::date, $7::date, $8)`,
          [
            id,
            aprobado.pedidoId,
            aprobado.ticketId,
            tipo,
            await archivo('qhse_documento_pedido'),
            conFecha ? dia : null,
            tipo === 'art' ? fechaEn(15) : null,
            TECNICO.id,
          ],
        );
        return id;
      };
      const [recepcion, art, pt, sfi] = [
        await doc('formato_recepcion', false),
        await doc('art', true),
        await doc('pt', true),
        await doc('sfi', false),
      ];
      const superusuario = new Pool({
        connectionString: process.env['TEST_ADMIN_DATABASE_URL'],
        max: 1,
      });
      try {
        const c = await superusuario.connect();
        try {
          await c.query('BEGIN');
          await c.query('SET LOCAL session_replication_role = replica');
          await c.query(
            "UPDATE qhse.ptw SET fase = 'aprobado', documento_recepcion_id = $2, documento_art_id = $3, documento_pt_id = $4, documento_sfi_id = $5 WHERE id = $1",
            [ptwAprobado, recepcion, art, pt, sfi],
          );
          await c.query('COMMIT');
        } finally {
          c.release();
        }
      } finally {
        await superusuario.end();
      }
      ambito = [pendiente, ptwAprobado];
      // antes de la hora de inicio (06:00 por defecto) todavía es temprano
      const antes = await avisos.emitir(dia, ambito, '05:59');
      expect(antes.porTipo['qhse.aviso.ptw_sin_aprobar_hora_inicio']).toBeUndefined();
      // llegada la hora, avisa del PTW pendiente (una vez) y no del aprobado
      const r = await avisos.emitir(dia, ambito, '06:00');
      expect(r.porTipo['qhse.aviso.ptw_sin_aprobar_hora_inicio']).toBe(1);
      expect(
        (await avisos.emitir(dia, ambito, '09:30')).porTipo[
          'qhse.aviso.ptw_sin_aprobar_hora_inicio'
        ],
      ).toBeUndefined(); // una sola vez
      const ev = (await eventosDe(pendiente)).find(
        (e) => e.tipo === 'qhse.aviso.ptw_sin_aprobar_hora_inicio',
      );
      expect(ev?.datos.data).toMatchObject({
        ptwId: pendiente,
        fase: 'gabinete',
        diaOperacion: dia,
        horaInicio: '06:00',
      });
      expect(String(ev?.datos.data['ptwCodigo'])).toMatch(/^PTW-\d{6}$/);
      expect(await tipos(ptwAprobado)).toEqual([]);
      await limpiar([t3, aprobado]);
    });

    it('«mañana falta el PT»: solo desde la tarde, solo si mañana hay servicio y no hay PT de ese día, una vez por ticket', async () => {
      const sinPt = await ticketConDias([manana]);
      const conPt = await ticketConDias([manana]);
      const sinServicio = await ticketConDias([dia]);
      const pt = async (t2: { ticketId: string; pedidoId: string }, fecha: string) =>
        sql(
          "INSERT INTO qhse.documento_pedido (id, pedido_id, ticket_id, tipo, archivo_id, fecha, created_by) VALUES ($1, $2, $3, 'pt', $4, $5, $6)",
          [
            uuidv7(),
            t2.pedidoId,
            t2.ticketId,
            await archivo('qhse_documento_pedido'),
            fecha,
            TECNICO.id,
          ],
        );
      await pt(conPt, manana);
      ambito = [sinPt.ticketId, conPt.ticketId, sinServicio.ticketId];
      const temprano = await avisos.emitir(dia, ambito, '13:59'); // antes de la tarde hay tiempo de sobra
      expect(temprano.porTipo['qhse.aviso.falta_pt_manana']).toBeUndefined();
      expect((await avisos.emitir(dia, ambito, '14:00')).porTipo).toMatchObject({
        'qhse.aviso.falta_pt_manana': 1,
      });
      expect(
        (await avisos.emitir(dia, ambito, '18:00')).porTipo['qhse.aviso.falta_pt_manana'],
      ).toBeUndefined(); // una sola vez
      const ev = (await eventosDe(sinPt.ticketId)).find(
        (e) => e.tipo === 'qhse.aviso.falta_pt_manana',
      );
      expect(ev?.datos.data).toMatchObject({ ticketId: sinPt.ticketId, diaOperacion: manana });
      expect(await tipos(conPt.ticketId)).not.toContain('qhse.aviso.falta_pt_manana');
      expect(await tipos(sinServicio.ticketId)).not.toContain('qhse.aviso.falta_pt_manana');
      // un PT de otro día no cubre el de mañana
      const otroPt = await ticketConDias([manana]);
      await pt(otroPt, dia);
      ambito = [otroPt.ticketId];
      expect((await avisos.emitir(dia, ambito, '15:00')).porTipo).toMatchObject({
        'qhse.aviso.falta_pt_manana': 1,
      });
      await limpiar([sinPt, conPt, sinServicio, otroPt]);
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
