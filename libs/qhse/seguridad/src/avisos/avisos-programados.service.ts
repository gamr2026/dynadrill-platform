import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { currentTraceparent } from '@dyn/common';
import { EventBus } from '@dyn/messaging';
import { aDia, aFecha, diasHasta, horaEcuador, hoyEcuador } from '../comun/fechas';
import {
  EstadoAccionInvestigacion,
  EstadoAspecto,
  EstadoControlAspecto,
  EstadoInvestigacion,
  EstadoObjetivoAmbiental,
  EstadoRequisitoLegal,
  TipoDocumentoPedido,
} from '../generated/client';
import { DesechosAvisosService } from '../desechos/desechos-avisos.service';
import { InspeccionesConsultaService } from '../inspecciones/inspecciones-consulta.service';
import { DIAS_AVISO_VENCIMIENTO } from '../legal/requisitos-legales-consulta.service';
import { codigoAspecto } from '../aspectos-ambientales/aspectos-ambientales-consulta.service';
import { codigoObjetivo } from '../objetivos-ambientales/objetivos-ambientales-consulta.service';
import { calcularPlazos, codigoInvestigacion, diaEcuador } from '../investigaciones/plazos';
import { codigoPtw } from '../ptw/ptw-documentos';
import { PrismaService } from '../prisma/prisma.service';

/** El ART avisa 3 días antes de vencer (igual que la bandeja de documentos). */
export const DIAS_AVISO_ART = 3;
/**
 * Los avisos de documentos de ingreso (recepción, SFI) solo miran servicios con personal asignado y creados en esta ventana: sin ella, el primer
 * barrido avisaría de todo el historial de tickets ya cerrados.
 */
export const DIAS_VENTANA_DOCUMENTOS_INGRESO = 60;
/** Hora (hora local) a la que empieza el servicio si no se configura: el aviso «PTW sin aprobar a la hora de inicio» no sale antes. */
export const HORA_INICIO_SERVICIO = '06:00';
/** Hora desde la que se avisa que mañana falta el PT: antes del mediodía todavía hay tiempo de sobra. */
export const HORA_AVISO_PT_MANANA = '14:00';
const HORA = /^([01]\d|2[0-3]):[0-5]\d$/;
/** Días de anticipación para avisar que vence el informe final de una investigación. */
export const DIAS_AVISO_INFORME_INVESTIGACION = 5;

const DIA_MS = 86_400_000;
const masDias = (dia: string, dias: number): string =>
  new Date(Date.parse(`${dia}T00:00:00Z`) + dias * DIA_MS).toISOString().slice(0, 10);

/** Un hecho por vencimiento que merece aviso. */
export interface Candidato {
  /** Tipo del evento `qhse.aviso.*` que se publica. */
  tipo: string;
  entidadId: string;
  /** Fecha límite que se venció o está por vencer (parte de la clave: si cambia, es otro hecho). */
  fechaLimite: string | null;
  datos: Record<string, unknown>;
}

export interface ResumenAvisos {
  total: number;
  porTipo: Record<string, number>;
}

/**
 * Emisor de avisos por vencimiento. Lo que depende del tiempo no lo dispara ningún evento de negocio, así que esta revisión (cada cierto
 * tiempo, o a pedido) busca lo vencido o por vencer y publica un evento `qhse.aviso.*` por cada hecho **nuevo**; el módulo de Avisos de la plataforma
 * decide a quién y con qué texto (reglas y plantillas). Una tabla de claves (`aviso_programado`) impide avisar dos veces el mismo hecho. El aviso
 * del límite de almacenamiento de desechos y del certificado de disposición los emite `DesechosAvisosService` (con su propia tabla de claves) en esta misma revisión.
 */
@Injectable()
export class AvisosProgramadosService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(AvisosProgramadosService.name);
  private readonly intervaloMin: number;
  /** Hora (HH:mm, hora local) a la que empieza el servicio: `QHSE_HORA_INICIO_SERVICIO`, por defecto 06:00. */
  private readonly horaInicio: string;
  /** Hora desde la que se avisa que mañana falta el PT: `QHSE_AVISO_PT_MANANA_DESDE`, por defecto 14:00. */
  private readonly horaPtManana: string;
  private timer?: NodeJS.Timeout;
  private enCurso = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: EventBus,
    private readonly inspecciones: InspeccionesConsultaService,
    private readonly desechos: DesechosAvisosService,
    cfg: ConfigService,
  ) {
    const hora = (clave: string, defecto: string): string => {
      const v = String(cfg.get(clave) ?? '').trim();
      if (!v) return defecto;
      if (HORA.test(v)) return v;
      this.logger.warn(`${clave}="${v}" no es una hora HH:mm; se usa ${defecto}`);
      return defecto;
    };
    this.horaInicio = hora('QHSE_HORA_INICIO_SERVICIO', HORA_INICIO_SERVICIO);
    this.horaPtManana = hora('QHSE_AVISO_PT_MANANA_DESDE', HORA_AVISO_PT_MANANA);
    // 0 apaga la revisión programada (en pruebas está apagada por defecto); sin valor, cada hora
    const configurado = cfg.get('QHSE_AVISOS_INTERVAL_MINUTES');
    this.intervaloMin =
      configurado !== undefined && configurado !== ''
        ? Number(configurado)
        : process.env['NODE_ENV'] === 'test'
          ? 0
          : 60;
  }

  onApplicationBootstrap(): void {
    if (!(this.intervaloMin > 0)) return;
    this.timer = setInterval(() => {
      this.emitir().catch((e: Error) =>
        this.logger.warn(`La revisión programada de avisos falló: ${e.message}`),
      );
    }, this.intervaloMin * 60_000);
    this.timer.unref();
    this.logger.log(`Revisión de avisos por vencimiento cada ${this.intervaloMin} min`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Revisa todo y publica los avisos nuevos. `hoy` (AAAA-MM-DD) solo se cambia en pruebas. */
  async emitir(
    hoy: string = hoyEcuador(),
    /** Limita la revisión a esas entidades (pruebas); sin valor, revisa todo. */
    entidades?: readonly string[],
    /** Hora local (HH:mm); solo se cambia en pruebas. */
    hora: string = horaEcuador(),
  ): Promise<ResumenAvisos> {
    if (this.enCurso) return { total: 0, porTipo: {} };
    this.enCurso = true;
    try {
      const candidatos = (
        await Promise.all([
          this.art(hoy),
          this.documentosDeIngresoFaltantes(hoy),
          this.ptwSinPtDeHoy(hoy),
          this.servicioSinPtw(hoy),
          this.ptwSinAprobarALaHora(hoy, hora),
          this.faltaPtManana(hoy, hora),
          this.requisitosLegales(hoy),
          this.inspeccionesVencidas(hoy),
          this.investigaciones(hoy),
          this.accionesDeInvestigacion(hoy),
          this.objetivos(hoy),
          this.controlesAmbientales(hoy),
        ])
      )
        .flat()
        .filter((c) => !entidades || entidades.includes(c.entidadId));
      const porTipo: Record<string, number> = {};
      let total = 0;
      for (const c of candidatos) {
        if (await this.emitirUno(c)) {
          porTipo[c.tipo] = (porTipo[c.tipo] ?? 0) + 1;
          total++;
        }
      }
      // desechos: límite de 12 meses próximo o vencido y certificado de disposición fuera de plazo (los emite el propio servicio de desechos)
      const d = await this.desechos.revisar(null, entidades);
      for (const [tipo, n] of [
        ['qhse.desecho.limite_proximo', d.limiteProximo],
        ['qhse.desecho.limite_vencido', d.limiteVencido],
        ['qhse.desecho.certificado_vencido', d.certificadoVencido],
      ] as const) {
        if (!n) continue;
        porTipo[tipo] = n;
        total += n;
      }
      if (total) this.logger.log(`Avisos por vencimiento emitidos: ${JSON.stringify(porTipo)}`);
      return { total, porTipo };
    } finally {
      this.enCurso = false;
    }
  }

  /** Guarda la clave y publica el evento en la misma transacción; si la clave ya existía, no hace nada. */
  private async emitirUno(c: Candidato): Promise<boolean> {
    const clave = `${c.tipo}:${c.entidadId}:${c.fechaLimite ?? '-'}`;
    return this.prisma.$transaction(async (tx) => {
      const r = await tx.avisoProgramado.createMany({
        data: [
          {
            clave,
            tipo: c.tipo,
            entidadId: c.entidadId,
            fechaLimite: c.fechaLimite ? aFecha(c.fechaLimite) : null,
          },
        ],
        skipDuplicates: true,
      });
      if (r.count !== 1) return false;
      await this.bus.publish(
        tx,
        this.bus.create({
          type: c.tipo,
          subject: { type: 'aviso', id: c.entidadId },
          data: c.datos,
          traceparent: currentTraceparent(),
        }),
      );
      return true;
    });
  }

  // ---------------------------------------------------------------------------------------------- qué merece aviso

  /** ART: el vigente de cada pedido (el de vencimiento más lejano) que vence en 3 días o ya venció. */
  private async art(hoy: string): Promise<Candidato[]> {
    const docs = await this.prisma.documentoPedido.findMany({
      where: { tipo: TipoDocumentoPedido.art, anuladoAt: null, vigenteHasta: { not: null } },
      select: { id: true, pedidoId: true, vigenteHasta: true },
    });
    // si el pedido ya tiene otro ART que vence después, el vencido no es motivo de aviso
    const ultimo = new Map<string, (typeof docs)[number]>();
    for (const d of docs) {
      const actual = ultimo.get(d.pedidoId);
      if (!actual || (d.vigenteHasta as Date) > (actual.vigenteHasta as Date))
        ultimo.set(d.pedidoId, d);
    }
    const limite = masDias(hoy, DIAS_AVISO_ART);
    const aviso = [...ultimo.values()].filter((d) => aDia(d.vigenteHasta as Date) <= limite);
    if (!aviso.length) return [];
    const tickets = await this.prisma.ticketRef.findMany({
      where: { pedidoId: { in: aviso.map((d) => d.pedidoId) } },
      select: { pedidoId: true, pedidoCodigo: true, cliente: true, campo: true, pozo: true },
    });
    return aviso.map((d) => {
      const vence = aDia(d.vigenteHasta as Date);
      const t = tickets.find((x) => x.pedidoId === d.pedidoId);
      const dias = diasHasta(vence, hoy);
      return {
        tipo: dias < 0 ? 'qhse.aviso.art_vencido' : 'qhse.aviso.art_por_vencer',
        entidadId: d.id,
        fechaLimite: vence,
        datos: {
          documentoId: d.id,
          pedidoId: d.pedidoId,
          pedidoCodigo: t?.pedidoCodigo ?? null,
          cliente: t?.cliente ?? null,
          campo: t?.campo ?? null,
          pozo: t?.pozo ?? null,
          vigenteHasta: vence,
          diasParaVencer: dias,
        },
      };
    });
  }

  /**
   * Formato de Recepción y SFI de los servicios con personal asignado: si el ticket ya tiene operadores y no tiene el documento (no anulado),
   * se avisa una sola vez por ticket y documento.
   */
  private async documentosDeIngresoFaltantes(hoy: string): Promise<Candidato[]> {
    const desde = aFecha(masDias(hoy, -DIAS_VENTANA_DOCUMENTOS_INGRESO));
    const tickets = await this.prisma.ticketRef.findMany({
      where: { createdAt: { gte: desde }, operadores: { some: {} } },
      select: {
        ticketId: true,
        ticketNumero: true,
        pedidoId: true,
        pedidoCodigo: true,
        cliente: true,
        campo: true,
        pozo: true,
        documentos: {
          where: {
            anuladoAt: null,
            tipo: { in: [TipoDocumentoPedido.formato_recepcion, TipoDocumentoPedido.sfi] },
          },
          select: { tipo: true },
        },
      },
    });
    const faltantes: Array<[TipoDocumentoPedido, string]> = [
      [TipoDocumentoPedido.formato_recepcion, 'qhse.aviso.pedido_sin_formato_recepcion'],
      [TipoDocumentoPedido.sfi, 'qhse.aviso.personal_asignado_sin_sfi'],
    ];
    return tickets.flatMap((t) =>
      faltantes
        .filter(([tipo]) => !t.documentos.some((d) => d.tipo === tipo))
        .map(([, evento]) => ({
          tipo: evento,
          entidadId: t.ticketId,
          fechaLimite: null,
          datos: {
            ticketId: t.ticketId,
            ticketNumero: t.ticketNumero,
            pedidoId: t.pedidoId,
            pedidoCodigo: t.pedidoCodigo,
            cliente: t.cliente,
            campo: t.campo,
            pozo: t.pozo,
          },
        })),
    );
  }

  /** PTW del día todavía sin su PT: un aviso por PTW (la fecha forma parte de la clave, así que cada día es un hecho distinto). */
  private async ptwSinPtDeHoy(hoy: string): Promise<Candidato[]> {
    const filas = await this.prisma.ptw.findMany({
      where: {
        diaOperacion: aFecha(hoy),
        anuladoAt: null,
        documentoPtId: null,
        fase: { not: 'aprobado' },
      },
      select: {
        id: true,
        numero: true,
        ticketId: true,
        pedidoId: true,
        ticket: {
          select: {
            ticketNumero: true,
            pedidoCodigo: true,
            cliente: true,
            campo: true,
            pozo: true,
          },
        },
      },
    });
    return filas.map((p) => ({
      tipo: 'qhse.aviso.ptw_sin_pt_hoy',
      entidadId: p.id,
      fechaLimite: hoy,
      datos: {
        ptwId: p.id,
        ptwCodigo: codigoPtw(p.numero),
        ticketId: p.ticketId,
        ticketNumero: p.ticket.ticketNumero,
        pedidoId: p.pedidoId,
        pedidoCodigo: p.ticket.pedidoCodigo,
        cliente: p.ticket.cliente,
        campo: p.ticket.campo,
        pozo: p.ticket.pozo,
        diaOperacion: hoy,
      },
    }));
  }

  /** Datos de un ticket que llevan los avisos de servicio (los mismos para los tres de abajo). */
  private datosTicket(t: {
    ticketId: string;
    ticketNumero: number | null;
    pedidoId: string;
    pedidoCodigo: string;
    cliente: string | null;
    campo: string | null;
    pozo: string | null;
  }) {
    return {
      ticketId: t.ticketId,
      ticketNumero: t.ticketNumero,
      pedidoId: t.pedidoId,
      pedidoCodigo: t.pedidoCodigo,
      cliente: t.cliente,
      campo: t.campo,
      pozo: t.pozo,
    };
  }

  /**
   * «Hay servicio hoy y no existe PTW»: el ticket tiene hoy como día de servicio y el día no tiene ningún PTW vigente. Normalmente la tarea
   * programada lo abre a medianoche; este aviso sale si no se abrió (o se anuló) y nadie lo repuso. Un aviso por ticket y día.
   */
  async servicioSinPtw(hoy: string): Promise<Candidato[]> {
    const dias = await this.prisma.ticketDiaServicio.findMany({
      where: { fecha: aFecha(hoy) },
      select: { ticket: { select: this.seleccionTicket } },
    });
    if (!dias.length) return [];
    const conPtw = new Set(
      (
        await this.prisma.ptw.findMany({
          where: {
            pedidoId: { in: dias.map((d) => d.ticket.pedidoId) },
            diaOperacion: aFecha(hoy),
            anuladoAt: null,
          },
          select: { pedidoId: true },
        })
      ).map((p) => p.pedidoId),
    );
    return dias
      .filter((d) => !conPtw.has(d.ticket.pedidoId))
      .map((d) => ({
        tipo: 'qhse.aviso.servicio_sin_ptw',
        entidadId: d.ticket.ticketId,
        fechaLimite: hoy,
        datos: { ...this.datosTicket(d.ticket), diaOperacion: hoy },
      }));
  }

  /** «PTW sin aprobar a la hora de inicio»: llegada la hora de inicio del servicio, el PTW de hoy sigue sin aprobarse. Un aviso por PTW. */
  async ptwSinAprobarALaHora(hoy: string, hora: string): Promise<Candidato[]> {
    if (hora < this.horaInicio) return [];
    const filas = await this.prisma.ptw.findMany({
      where: { diaOperacion: aFecha(hoy), anuladoAt: null, fase: { not: 'aprobado' } },
      select: {
        id: true,
        numero: true,
        fase: true,
        ticket: { select: this.seleccionTicket },
      },
    });
    return filas.map((p) => ({
      tipo: 'qhse.aviso.ptw_sin_aprobar_hora_inicio',
      entidadId: p.id,
      fechaLimite: hoy,
      datos: {
        ...this.datosTicket(p.ticket),
        ptwId: p.id,
        ptwCodigo: codigoPtw(p.numero),
        fase: p.fase,
        diaOperacion: hoy,
        horaInicio: this.horaInicio,
      },
    }));
  }

  /**
   * «Mañana falta el PT»: el ticket tiene servicio mañana y todavía no se cargó el PT de ese día. Sin él la jornada de mañana quedaría bloqueada.
   * Sale desde la hora configurada de la tarde (antes todavía hay tiempo de sobra). Un aviso por ticket y día.
   */
  async faltaPtManana(hoy: string, hora: string): Promise<Candidato[]> {
    if (hora < this.horaPtManana) return [];
    const manana = masDias(hoy, 1);
    const dias = await this.prisma.ticketDiaServicio.findMany({
      where: { fecha: aFecha(manana) },
      select: { ticket: { select: this.seleccionTicket } },
    });
    if (!dias.length) return [];
    const conPt = new Set(
      (
        await this.prisma.documentoPedido.findMany({
          where: {
            pedidoId: { in: dias.map((d) => d.ticket.pedidoId) },
            tipo: TipoDocumentoPedido.pt,
            fecha: aFecha(manana),
            anuladoAt: null,
          },
          select: { pedidoId: true },
        })
      ).map((d) => d.pedidoId),
    );
    return dias
      .filter((d) => !conPt.has(d.ticket.pedidoId))
      .map((d) => ({
        tipo: 'qhse.aviso.falta_pt_manana',
        entidadId: d.ticket.ticketId,
        fechaLimite: manana,
        datos: { ...this.datosTicket(d.ticket), diaOperacion: manana },
      }));
  }

  private readonly seleccionTicket = {
    ticketId: true,
    ticketNumero: true,
    pedidoId: true,
    pedidoCodigo: true,
    cliente: true,
    campo: true,
    pozo: true,
  } as const;

  /** Requisitos legales: la revisión vigente de cada matriz que vence en 30 días o ya venció. */
  private async requisitosLegales(hoy: string): Promise<Candidato[]> {
    const filas = await this.prisma.requisitoLegal.findMany({
      where: {
        estado: EstadoRequisitoLegal.vigente,
        vigenteHasta: { not: null, lte: aFecha(masDias(hoy, DIAS_AVISO_VENCIMIENTO)) },
      },
      include: { tipo: { select: { codigo: true, nombre: true } } },
    });
    return filas.map((f) => {
      const vence = aDia(f.vigenteHasta as Date);
      const dias = diasHasta(vence, hoy);
      return {
        tipo:
          dias < 0 ? 'qhse.aviso.requisito_legal_vencido' : 'qhse.aviso.requisito_legal_por_vencer',
        entidadId: f.id,
        fechaLimite: vence,
        datos: {
          requisitoLegalId: f.id,
          tipo: f.tipo.codigo,
          tipoNombre: f.tipo.nombre,
          revision: f.revision,
          vigenteHasta: vence,
          diasParaVencer: dias,
        },
      };
    });
  }

  /** Inspecciones: equipos cuya última inspección (aprobada) ya pasó su vigencia. Los rechazados ya avisaron su cuarentena. */
  private async inspeccionesVencidas(hoy: string): Promise<Candidato[]> {
    const equipos = await this.inspecciones.equipos();
    return equipos
      .filter((e) => e.vigenteHasta < hoy && !e.enCuarentena)
      .map((e) => ({
        tipo: 'qhse.aviso.inspeccion_vencida',
        entidadId: e.ultimaInspeccion.id,
        fechaLimite: e.vigenteHasta,
        datos: {
          inspeccionId: e.ultimaInspeccion.id,
          codigo: e.ultimaInspeccion.codigo,
          tipoNombre: e.tipo.nombre,
          equipoCodigo: e.equipoCodigo,
          vigenteHasta: e.vigenteHasta,
        },
      }));
  }

  /** Investigaciones: inicio vencido (sigue abierta), y el informe final por vencer o vencido (hasta que se cierre). */
  private async investigaciones(hoy: string): Promise<Candidato[]> {
    const filas = await this.prisma.investigacion.findMany({
      where: { estado: { not: EstadoInvestigacion.cerrada } },
      include: { resultado: true },
    });
    const salida: Candidato[] = [];
    for (const i of filas) {
      const p = calcularPlazos(i.fechaIncidente, i.resultado, i.escenaAseguradaAt, false);
      const base = {
        investigacionId: i.id,
        codigo: codigoInvestigacion(i.numero),
        resultado: i.resultado.codigo,
        resultadoNombre: i.resultado.nombre,
        ubicacion: i.ubicacion,
      };
      if (i.estado === EstadoInvestigacion.abierta && Date.now() > p.inicioLimite.getTime()) {
        const limite = diaEcuador(p.inicioLimite);
        salida.push({
          tipo: 'qhse.aviso.investigacion_inicio_vencido',
          entidadId: i.id,
          fechaLimite: limite,
          datos: { ...base, limite },
        });
      }
      const limite = diaEcuador(p.finalLimite);
      const dias = diasHasta(limite, hoy);
      if (dias < 0 || (dias >= 0 && dias <= DIAS_AVISO_INFORME_INVESTIGACION))
        salida.push({
          tipo:
            dias < 0
              ? 'qhse.aviso.investigacion_final_vencido'
              : 'qhse.aviso.investigacion_final_por_vencer',
          entidadId: i.id,
          fechaLimite: limite,
          datos: { ...base, limite, diasParaVencer: dias },
        });
    }
    return salida;
  }

  /** Acciones de investigación pendientes con el plazo pasado: aviso al equipo HSE y otro a quien debe implementarlas. */
  private async accionesDeInvestigacion(hoy: string): Promise<Candidato[]> {
    const filas = await this.prisma.investigacionAccion.findMany({
      where: { estado: EstadoAccionInvestigacion.pendiente, plazo: { lt: aFecha(hoy) } },
      include: {
        investigacion: { select: { numero: true } },
        responsable: { select: { nombre: true } },
      },
    });
    return filas.flatMap((a) => {
      const plazo = aDia(a.plazo);
      const datos = {
        investigacionId: a.investigacionId,
        investigacionCodigo: codigoInvestigacion(a.investigacion.numero),
        accionId: a.id,
        orden: a.orden,
        descripcion: a.descripcion,
        responsable: a.responsable.nombre,
        plazo,
      };
      return [
        {
          tipo: 'qhse.aviso.accion_investigacion_vencida',
          entidadId: a.id,
          fechaLimite: plazo,
          datos,
        },
        {
          // con `asignados` el aviso es solo para esa persona (la regla del rol «responsable_accion»)
          tipo: 'qhse.aviso.accion_investigacion_vencida_responsable',
          entidadId: a.id,
          fechaLimite: plazo,
          datos: {
            ...datos,
            asignados: [{ usuarioId: a.responsableId, rolCodigo: 'responsable_accion' }],
          },
        },
      ];
    });
  }

  /** Objetivos ambientales en curso que vencen en 30 días o ya vencieron. */
  private async objetivos(hoy: string): Promise<Candidato[]> {
    const filas = await this.prisma.objetivoAmbiental.findMany({
      where: {
        estado: EstadoObjetivoAmbiental.en_curso,
        plazo: { not: null, lte: aFecha(masDias(hoy, DIAS_AVISO_VENCIMIENTO)) },
      },
    });
    return filas.map((o) => {
      const plazo = aDia(o.plazo as Date);
      const dias = diasHasta(plazo, hoy);
      return {
        tipo:
          dias < 0
            ? 'qhse.aviso.objetivo_ambiental_vencido'
            : 'qhse.aviso.objetivo_ambiental_por_vencer',
        entidadId: o.id,
        fechaLimite: plazo,
        datos: {
          objetivoId: o.id,
          codigo: codigoObjetivo(o.numero),
          titulo: o.titulo,
          plazo,
          diasParaVencer: dias,
        },
      };
    });
  }

  /** Controles de aspectos ambientales sin implementar con el plazo pasado. */
  private async controlesAmbientales(hoy: string): Promise<Candidato[]> {
    const filas = await this.prisma.aspectoAmbiental.findMany({
      where: {
        estado: EstadoAspecto.vigente,
        estadoControl: { not: EstadoControlAspecto.implementado },
        plazo: { lt: aFecha(hoy) },
      },
    });
    return filas.map((a) => {
      const plazo = aDia(a.plazo as Date);
      return {
        tipo: 'qhse.aviso.control_ambiental_vencido',
        entidadId: a.id,
        fechaLimite: plazo,
        datos: {
          aspectoId: a.id,
          codigo: codigoAspecto(a.numero),
          actividad: a.actividad,
          clasificacion: a.clasificacion,
          plazo,
        },
      };
    });
  }
}
