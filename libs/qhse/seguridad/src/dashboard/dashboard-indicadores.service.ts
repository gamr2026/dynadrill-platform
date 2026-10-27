import { Injectable } from '@nestjs/common';
import { aDia, hoyEcuador } from '../comun/fechas';
import { codigoDerrame } from '../derrames/derrames-consulta.service';
import { codigoDe as codigoEpi } from '../epi/epi-tipos';
import { codigoInvestigacion } from '../investigaciones/plazos';
import { codigoPtw } from '../ptw/ptw-documentos';
import { PrismaService } from '../prisma/prisma.service';

const DIA_MS = 86_400_000;
/** A partir de cuántos días sin actividad un PTW abierto se considera «estancado» (umbral de gestión, no un plazo legal). */
export const DIAS_PTW_SIN_ACTIVIDAD = 3;
/** Horas desde el incidente para notificar a Ministerio del Trabajo / IESS. */
const HORAS_NOTIFICACION_LEGAL = 24;

const FASES_PTW = ['gabinete', 'formalizacion', 'aprobacion'] as const;
const ESTADOS_EPI = ['solicitado', 'aprobado', 'despachado', 'rechazado'] as const;

const redondear = (n: number, decimales: number) => {
  const f = 10 ** decimales;
  return Math.round(n * f) / f;
};
const mismoMes = (a: Date, b: Date) =>
  a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth();

/**
 * Datos del Dashboard Integrado del Sistema (HSE-MASTER-001). Cada indicador se calcula aquí, con consultas sobre las tablas del propio contenedor
 * (una sola fuente de verdad, sin copias). Los que no se pueden calcular (TRIR, LTIR, participación en STOP, personal capacitado y el IPERC por
 * trabajo) no se devuelven: el catálogo `kpi_indicador` los marca como no disponibles y dice por qué. Un indicador sin datos suficientes vale `null`.
 */
@Injectable()
export class DashboardIndicadoresService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Lo que muestra la tarjeta de QHSE del tablero general: eventos abiertos (investigaciones abiertas, emergencias activas, SWA y derrames
   * activos), equipos cuya última inspección ya venció y matrices IPERC que aún esperan aprobación.
   */
  async resumen() {
    const hoy = hoyEcuador();
    const [investigaciones, emergencias, swa, derrames, ultimas, ipercSinAprobar] = await Promise.all([
      this.prisma.investigacion.count({ where: { estado: 'abierta' } }),
      this.prisma.emergencia.count({ where: { estado: 'activa' } }),
      this.prisma.swa.count({ where: { estado: 'activo' } }),
      this.prisma.derrame.count({ where: { estado: 'activo' } }),
      this.prisma.inspeccion.findMany({
        distinct: ['equipoId'],
        orderBy: [{ equipoId: 'asc' }, { fecha: 'desc' }, { numero: 'desc' }],
        select: { vigenteHasta: true },
      }),
      this.prisma.ipercMatriz.count({ where: { estado: { in: ['borrador', 'en_evaluacion', 'en_revision'] } } }),
    ]);
    return {
      incidentesAbiertos: investigaciones + emergencias + swa + derrames,
      inspeccionesPendientes: ultimas.filter((i) => aDia(i.vigenteHasta) < hoy).length,
      ipercSinAprobar,
    };
  }

  async indicadores() {
    const ahora = new Date();
    const hoy = hoyEcuador();
    const [seguridad, operacional, ambiental, cultura, legal, epi, ptw] = await Promise.all([
      this.seguridad(ahora),
      this.operacional(hoy),
      this.ambiental(ahora),
      this.cultura(),
      this.incumplimientosLegales(ahora),
      this.entregasEpi(),
      this.permisosDeTrabajo(ahora),
    ]);
    return {
      generadoAt: ahora,
      valores: { ...seguridad, ...operacional, ...ambiental, ...cultura },
      incumplimientoLegal: legal,
      epi,
      ptw,
    };
  }

  /** Días sin accidentes con tiempo perdido (fatal, grave o leve) y proporción de cuasi accidentes frente a los incidentes. */
  private async seguridad(ahora: Date) {
    const invs = await this.prisma.investigacion.findMany({
      select: { fechaIncidente: true, resultado: { select: { codigo: true } } },
    });
    const conTiempoPerdido = invs.filter((i) => ['fatal', 'grave', 'leve'].includes(i.resultado.codigo));
    const ultimo = conTiempoPerdido.reduce<Date | null>(
      (max, i) => (!max || i.fechaIncidente > max ? i.fechaIncidente : max),
      null,
    );
    const nearMiss = invs.filter((i) => i.resultado.codigo === 'near_miss').length;
    const incidentes = invs.length - nearMiss;
    return {
      dias_sin_lti: ultimo ? Math.floor((ahora.getTime() - ultimo.getTime()) / DIA_MS) : null,
      ratio_near_miss: incidentes > 0 ? redondear(nearMiss / incidentes, 1) : null,
    };
  }

  /** PTW aprobados (de los no anulados), tiempo medio de apertura a aprobación e inspecciones vigentes (la última de cada equipo). */
  private async operacional(hoy: string) {
    const ptws = await this.prisma.ptw.findMany({
      where: { anuladoAt: null },
      select: {
        fase: true,
        createdAt: true,
        historial: { where: { accion: 'aprobado' }, select: { createdAt: true }, take: 1, orderBy: { createdAt: 'desc' } },
      },
    });
    const aprobados = ptws.filter((p) => p.fase === 'aprobado');
    const dias = aprobados
      .map((p) => (p.historial[0] ? (p.historial[0].createdAt.getTime() - p.createdAt.getTime()) / DIA_MS : null))
      .filter((d): d is number => d !== null);
    const ultimas = await this.prisma.inspeccion.findMany({
      distinct: ['equipoId'],
      orderBy: [{ equipoId: 'asc' }, { fecha: 'desc' }, { numero: 'desc' }],
      select: { vigenteHasta: true },
    });
    return {
      ptw_cerrados_pct: ptws.length ? Math.round((aprobados.length / ptws.length) * 100) : null,
      ptw_tiempo_prom_dias: dias.length ? redondear(dias.reduce((a, d) => a + d, 0) / dias.length, 1) : null,
      inspecciones_vigentes_pct: ultimas.length
        ? Math.round((ultimas.filter((i) => aDia(i.vigenteHasta) >= hoy).length / ultimas.length) * 100)
        : null,
    };
  }

  /** Desechos (en galones, que es lo que se registra), reciclaje por contenedor azul y derrames. */
  private async ambiental(ahora: Date) {
    const items = await this.prisma.desechoItem.findMany({
      select: {
        cantidadGalones: true,
        desecho: { select: { clasificacion: true, registradoEl: true, contenedor: { select: { codigo: true } } } },
      },
    });
    const galones = (i: (typeof items)[number]) => Number(i.cantidadGalones);
    const total = items.reduce((a, i) => a + galones(i), 0);
    const azul = items.filter((i) => i.desecho.contenedor.codigo === 'azul').reduce((a, i) => a + galones(i), 0);
    const peligrososDelMes = items
      .filter((i) => i.desecho.clasificacion === 'peligroso' && mismoMes(i.desecho.registradoEl, ahora))
      .reduce((a, i) => a + galones(i), 0);

    const hace90Dias = new Date(ahora.getTime() - 90 * DIA_MS);
    const derrames = await this.prisma.derrame.findMany({
      where: { activadoAt: { gte: new Date(Date.UTC(ahora.getUTCFullYear() - 1, 11, 31)) } },
      select: { activadoAt: true, volumenRealBarriles: true },
    });
    return {
      desechos_peligrosos_kg_mes: redondear(peligrososDelMes, 3),
      reciclaje_pct: total > 0 ? Math.round((azul / total) * 100) : null,
      derrames_trimestre: derrames.filter((d) => d.activadoAt >= hace90Dias).length,
      derrames_volumen_barriles_year: redondear(
        derrames
          .filter((d) => d.activadoAt.getUTCFullYear() === ahora.getUTCFullYear())
          .reduce((a, d) => a + Number(d.volumenRealBarriles ?? 0), 0),
        3,
      ),
    };
  }

  /** Eventos de Stop Work Authority (indicador positivo) y tarjetas STOP por persona activa del sistema. */
  private async cultura() {
    const [swa, stop, activos] = await Promise.all([
      this.prisma.swa.count(),
      this.prisma.stopTarjeta.count(),
      this.prisma.idUsuario.count({ where: { activo: true } }),
    ]);
    return {
      swa_eventos: swa,
      stop_per_capita: activos > 0 ? redondear(stop / activos, 2) : null,
    };
  }

  /** Lo que pone el semáforo en rojo: derrames que exigen notificar al MAE y no se notificaron, e investigaciones con la notificación legal vencida. */
  private async incumplimientosLegales(ahora: Date): Promise<string[]> {
    const [derrames, investigaciones] = await Promise.all([
      this.prisma.derrame.findMany({
        where: { estado: { not: 'cerrado' }, notificadoMaeAt: null, banda: { exigeNotificacionMae: true } },
        orderBy: { numero: 'asc' },
        select: { numero: true },
      }),
      this.prisma.investigacion.findMany({
        where: {
          estado: 'abierta',
          resultado: { sugiereNotificacionLegal: true },
          ministerioTrabajoNotificadoAt: null,
          iessNotificadoAt: null,
          fechaIncidente: { lt: new Date(ahora.getTime() - HORAS_NOTIFICACION_LEGAL * 3_600_000) },
        },
        orderBy: { numero: 'asc' },
        select: { numero: true },
      }),
    ]);
    return [
      ...derrames.map((d) => `Derrame ${codigoDerrame(d.numero)}: notificación al MAE pendiente.`),
      ...investigaciones.map(
        (i) => `Investigación ${codigoInvestigacion(i.numero)}: notificación a Ministerio del Trabajo / IESS vencida (24h).`,
      ),
    ];
  }

  /** Entregas de EPI por estado y las que esperan decisión de QHSE. */
  private async entregasEpi() {
    const [porEstado, pendientes] = await Promise.all([
      this.prisma.epiEntrega.groupBy({ by: ['estado'], _count: { _all: true } }),
      this.prisma.epiEntrega.findMany({
        where: { estado: 'solicitado' },
        orderBy: { numero: 'asc' },
        select: {
          id: true,
          numero: true,
          trabajador: { select: { nombre: true, perfil: { select: { cargo: true } } } },
        },
      }),
    ]);
    return {
      total: porEstado.reduce((a, e) => a + e._count._all, 0),
      porEstado: ESTADOS_EPI.map((estado) => ({
        estado,
        cantidad: porEstado.find((e) => e.estado === estado)?._count._all ?? 0,
      })),
      pendientes: pendientes.map((e) => ({
        id: e.id,
        codigo: codigoEpi(e.numero),
        trabajador: e.trabajador.nombre,
        cargo: e.trabajador.perfil?.cargo ?? null,
      })),
    };
  }

  /** PTW abiertos (ni aprobados ni anulados) por fase y los que llevan {@link DIAS_PTW_SIN_ACTIVIDAD} días o más sin actividad. */
  private async permisosDeTrabajo(ahora: Date) {
    const abiertos = await this.prisma.ptw.findMany({
      where: { anuladoAt: null, fase: { not: 'aprobado' } },
      orderBy: { updatedAt: 'asc' },
      select: {
        id: true,
        numero: true,
        fase: true,
        updatedAt: true,
        diaOperacion: true,
        ticket: { select: { pedidoCodigo: true } },
      },
    });
    const estancados = abiertos
      .map((p) => ({ p, dias: Math.floor((ahora.getTime() - p.updatedAt.getTime()) / DIA_MS) }))
      .filter(({ dias }) => dias >= DIAS_PTW_SIN_ACTIVIDAD)
      .sort((a, b) => b.dias - a.dias);
    return {
      abiertos: abiertos.length,
      porFase: FASES_PTW.map((fase) => ({ fase, cantidad: abiertos.filter((p) => p.fase === fase).length })),
      estancados: estancados.map(({ p, dias }) => ({
        id: p.id,
        codigo: codigoPtw(p.numero),
        pedido: p.ticket.pedidoCodigo,
        diaOperacion: aDia(p.diaOperacion),
        fase: p.fase,
        diasSinActividad: dias,
      })),
    };
  }
}
