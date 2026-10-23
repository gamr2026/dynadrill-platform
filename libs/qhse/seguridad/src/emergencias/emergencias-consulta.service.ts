import { Injectable, NotFoundException } from '@nestjs/common';
import type { Tx } from '../epi/epi-tipos';
import { PrismaService } from '../prisma/prisma.service';

/** Consecutivo visible de la emergencia: EME-000001. */
export const codigoEmergencia = (numero: number): string =>
  `EME-${String(numero).padStart(6, '0')}`;

const codigoSwa = (numero: number) => `SWA-${String(numero).padStart(6, '0')}`;
const codigoDerrame = (numero: number) => `DER-${String(numero).padStart(6, '0')}`;

/** HSE-TRIAGE-001: el Reporte Flash se emite dentro de las 2 horas desde la activación (se informa; no bloquea). */
export const PLAZO_REPORTE_FLASH_MINUTOS = 120;

/** Minutos entre dos instantes, con un decimal. */
export const minutosEntre = (desde: Date, hasta: Date): number =>
  Math.max(0, Math.round(((hasta.getTime() - desde.getTime()) / 60_000) * 10) / 10);

export interface FiltroEmergencias {
  estado?: 'activa' | 'controlada' | 'cerrada';
  ticketId?: string;
  q?: string;
}

/** Lectura de emergencias: catálogos del formulario, bandeja y detalle con el cronómetro. */
@Injectable()
export class EmergenciasConsultaService {
  constructor(private readonly prisma: PrismaService) {}

  /** Catálogos del formulario de activación (los usa quien reporta, aunque no vea la bandeja). */
  async catalogos() {
    const [tipos, tickets] = await Promise.all([
      this.prisma.emergenciaTipo.findMany({
        where: { activo: true },
        orderBy: { orden: 'asc' },
        select: { id: true, codigo: true, nombre: true },
      }),
      this.prisma.ticketRef.findMany({
        orderBy: { updatedAt: 'desc' },
        take: 100,
        select: {
          ticketId: true,
          ticketNumero: true,
          pedidoCodigo: true,
          cliente: true,
          pozo: true,
        },
      }),
    ]);
    return { tipos, tickets };
  }

  async listar(filtro: FiltroEmergencias = {}) {
    const q = filtro.q?.trim();
    const filas = await this.prisma.emergencia.findMany({
      where: {
        ...(filtro.estado ? { estado: filtro.estado } : {}),
        ...(filtro.ticketId ? { ticketId: filtro.ticketId } : {}),
        ...(q
          ? {
              OR: [
                { descripcion: { contains: q, mode: 'insensitive' } },
                { ubicacion: { contains: q, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      orderBy: { numero: 'desc' },
      include: { tipo: { select: { codigo: true, nombre: true } } },
      take: 300,
    });
    const tickets = await this.tickets(filas.map((f) => f.ticketId));
    return filas.map((e) => ({
      id: e.id,
      numero: e.numero,
      codigo: codigoEmergencia(e.numero),
      estado: e.estado,
      tipo: e.tipo,
      descripcion: e.descripcion,
      ubicacion: e.ubicacion,
      origen: e.swaId ? 'swa' : e.derrameId ? 'derrame' : null,
      ticketId: e.ticketId,
      ticketNumero: e.ticketId ? (tickets.get(e.ticketId)?.ticketNumero ?? null) : null,
      pedidoCodigo: e.ticketId ? (tickets.get(e.ticketId)?.pedidoCodigo ?? null) : null,
      activadoAt: e.activadoAt,
    }));
  }

  async detalle(id: string) {
    const e = await this.prisma.emergencia.findUnique({
      where: { id },
      include: {
        tipo: { select: { codigo: true, nombre: true } },
        lineas: { orderBy: [{ at: 'asc' }, { id: 'asc' }] },
        historial: { orderBy: { createdAt: 'asc' } },
        notificaciones: true,
        niveles: { orderBy: { createdAt: 'asc' } },
        conteos: { orderBy: { createdAt: 'asc' } },
        reporteFlash: true,
        heridos: {
          orderBy: { createdAt: 'asc' },
          include: {
            hospital: { select: { id: true, nombre: true, ciudad: true, telefono: true } },
            signos: { orderBy: { registradoAt: 'asc' } },
            triajes: { orderBy: { createdAt: 'asc' } },
          },
        },
      },
    });
    if (!e) throw new NotFoundException('La emergencia no existe');
    const pasos = await this.prisma.emergenciaPasoNotificacion.findMany({
      where: { activo: true },
      orderBy: { orden: 'asc' },
    });
    const [tickets, swa, derrame] = await Promise.all([
      this.tickets([e.ticketId]),
      e.swaId
        ? this.prisma.swa.findUnique({
            where: { id: e.swaId },
            select: { id: true, numero: true, estado: true },
          })
        : null,
      e.derrameId
        ? this.prisma.derrame.findUnique({
            where: { id: e.derrameId },
            select: { id: true, numero: true, estado: true },
          })
        : null,
    ]);
    const nombres = await this.nombres([
      e.activadoPor,
      ...e.lineas.map((l) => l.actorId),
      ...e.historial.map((h) => h.actorId),
      ...e.notificaciones.map((n) => n.notificadoPor),
      ...e.niveles.map((n) => n.actorId),
      ...e.conteos.map((c) => c.actorId),
      ...(e.nivelDeclaradoPor ? [e.nivelDeclaradoPor] : []),
      ...(e.conteoPor ? [e.conteoPor] : []),
      ...(e.reporteFlash ? [e.reporteFlash.emitidoPor] : []),
      ...(e.controladaPor ? [e.controladaPor] : []),
      ...(e.cerradaPor ? [e.cerradaPor] : []),
      ...e.heridos.flatMap((h) => [
        h.createdBy,
        ...(h.medevacPor ? [h.medevacPor] : []),
        ...(h.hospitalNotificadoPor ? [h.hospitalNotificadoPor] : []),
        ...(h.transferidoPor ? [h.transferidoPor] : []),
        ...h.signos.map((s) => s.registradoPor),
        ...h.triajes.map((x) => x.actorId),
      ]),
    ]);
    const t = e.ticketId ? tickets.get(e.ticketId) : undefined;
    const flash = e.reporteFlash;
    const flashMinutos = flash ? minutosEntre(e.activadoAt, flash.emitidoAt) : null;
    // manda el nivel MÁS ALTO declarado (bajarlo antes de cerrar no evita la investigación)
    const nivelMaximo = Math.max(e.nivel ?? 0, ...e.niveles.map((n) => n.nivel));
    const requiereInvestigacion = nivelMaximo >= 2;
    const investigacion = requiereInvestigacion
      ? await this.tieneInvestigacion(this.prisma, id)
      : null;
    const cascada = pasos.map((p) => {
      const n = e.notificaciones.find((x) => x.pasoId === p.id);
      const limite = e.activadoAt.getTime() + p.plazoMinutos * 60_000;
      return {
        pasoId: p.id,
        orden: p.orden,
        desde: p.desde,
        hacia: p.hacia,
        plazoMinutos: p.plazoMinutos,
        notificadoAt: n?.notificadoAt ?? null,
        notificadoPor: n ? (nombres.get(n.notificadoPor) ?? null) : null,
        /** Minutos entre la activación y la notificación. */
        minutos: n ? minutosEntre(e.activadoAt, n.notificadoAt) : null,
        /** Verdadero si se notificó dentro del plazo; nulo mientras no se notifique. */
        enPlazo: n ? n.notificadoAt.getTime() <= limite : null,
        /** Sin notificar y con el plazo ya vencido (solo mientras la emergencia siga abierta). */
        vencido: !n && e.estado !== 'cerrada' && Date.now() > limite,
      };
    });
    return {
      id: e.id,
      numero: e.numero,
      codigo: codigoEmergencia(e.numero),
      estado: e.estado,
      tipo: e.tipo,
      descripcion: e.descripcion,
      ubicacion: e.ubicacion,
      /** De dónde escaló (una SWA o un derrame mayor); nulo si se activó directo. */
      origen: swa
        ? { tipo: 'swa' as const, id: swa.id, codigo: codigoSwa(swa.numero), estado: swa.estado }
        : derrame
          ? {
              tipo: 'derrame' as const,
              id: derrame.id,
              codigo: codigoDerrame(derrame.numero),
              estado: derrame.estado,
            }
          : null,
      ticketId: e.ticketId,
      ticketNumero: t?.ticketNumero ?? null,
      pedidoCodigo: t?.pedidoCodigo ?? null,
      cliente: t?.cliente ?? null,
      campo: t?.campo ?? null,
      pozo: t?.pozo ?? null,
      activadoPor: nombres.get(e.activadoPor) ?? null,
      activadoAt: e.activadoAt,
      /** Nivel declarado por Base HSE (1 a 3); nulo hasta declararlo. */
      nivel:
        e.nivel === null
          ? null
          : {
              valor: e.nivel,
              declaradoPor: e.nivelDeclaradoPor ? (nombres.get(e.nivelDeclaradoPor) ?? null) : null,
              declaradoAt: e.nivelDeclaradoAt,
            },
      niveles: e.niveles.map((n) => ({
        nivel: n.nivel,
        actor: nombres.get(n.actorId) ?? null,
        at: n.createdAt,
      })),
      /** Conteo de personal; los faltantes se calculan (en locación menos evacuados). */
      conteo:
        e.totalEnLocacion === null || e.evacuados === null
          ? null
          : {
              totalEnLocacion: e.totalEnLocacion,
              evacuados: e.evacuados,
              faltantes: e.totalEnLocacion - e.evacuados,
              por: e.conteoPor ? (nombres.get(e.conteoPor) ?? null) : null,
              at: e.conteoAt,
            },
      conteos: e.conteos.map((c) => ({
        totalEnLocacion: c.totalEnLocacion,
        evacuados: c.evacuados,
        faltantes: c.totalEnLocacion - c.evacuados,
        actor: nombres.get(c.actorId) ?? null,
        at: c.createdAt,
      })),
      /** Cascada de notificación: cada paso con su plazo desde la activación. */
      cascada,
      notificacionCompleta: cascada.every((c) => c.notificadoAt !== null),
      /** Reporte Flash: plazo de 2 horas desde la activación (se informa; no bloquea). */
      reporteFlash: flash
        ? {
            resumenEjecutivo: flash.resumenEjecutivo,
            personalAfectado: flash.personalAfectado,
            accionesTomadas: flash.accionesTomadas,
            estadoActual: flash.estadoActual,
            proximosPasos: flash.proximosPasos,
            emitidoAt: flash.emitidoAt,
            emitidoPor: nombres.get(flash.emitidoPor) ?? null,
            minutos: flashMinutos,
            fueraDePlazo: (flashMinutos ?? 0) > PLAZO_REPORTE_FLASH_MINUTOS,
          }
        : null,
      plazoReporteFlashMinutos: PLAZO_REPORTE_FLASH_MINUTOS,
      /** Sin emitir y con el plazo de 2 horas ya vencido (solo mientras la emergencia siga abierta). */
      reporteFlashVencido:
        !flash &&
        e.estado !== 'cerrada' &&
        Date.now() > e.activadoAt.getTime() + PLAZO_REPORTE_FLASH_MINUTOS * 60_000,
      controladaAt: e.controladaAt,
      controladaPor: e.controladaPor ? (nombres.get(e.controladaPor) ?? null) : null,
      cerradaAt: e.cerradaAt,
      cerradaPor: e.cerradaPor ? (nombres.get(e.cerradaPor) ?? null) : null,
      /** Nivel 2 o 3: siempre origina una investigación de incidentes (HSE-TRIAGE-002). */
      requiereInvestigacion,
      /** ¿Ya está abierta la investigación? Nulo si no aplica o si el módulo de investigaciones no está instalado. */
      investigacionAbierta: investigacion,
      puedeControlar: e.estado === 'activa',
      /** Controlada, con el Reporte Flash emitido, el nivel declarado y (nivel 2 o 3) la investigación abierta. */
      puedeCerrar:
        e.estado === 'controlada' &&
        !!flash &&
        e.nivel !== null &&
        (!requiereInvestigacion || investigacion !== false),
      /** Resumen del triage de los heridos. */
      triage: {
        rojo: e.heridos.filter((h) => h.triage === 'rojo').length,
        amarillo: e.heridos.filter((h) => h.triage === 'amarillo').length,
        verde: e.heridos.filter((h) => h.triage === 'verde').length,
        negro: e.heridos.filter((h) => h.triage === 'negro').length,
      },
      /** Heridos con MEDEVAC activado y aún sin transferir. */
      medevacEnCurso: e.heridos.filter((h) => h.medevacAt && !h.transferidoAt).length,
      heridos: e.heridos.map((h) => ({
        id: h.id,
        nombreCompleto: h.nombreCompleto,
        cedula: h.cedula,
        triage: h.triage,
        mecanismoLesion: h.mecanismoLesion,
        lesiones: h.lesiones,
        tratamientoCampo: h.tratamientoCampo,
        registradoPor: nombres.get(h.createdBy) ?? null,
        triajes: h.triajes.map((x) => ({
          triage: x.triage,
          actor: nombres.get(x.actorId) ?? null,
          at: x.createdAt,
        })),
        signosVitales: h.signos.map((s) => ({
          registradoAt: s.registradoAt,
          registradoPor: nombres.get(s.registradoPor) ?? null,
          pulso: s.pulso,
          presionSistolica: s.presionSistolica,
          presionDiastolica: s.presionDiastolica,
          respiracion: s.respiracion,
          consciencia: s.consciencia,
        })),
        /** Criterios MEDEVAC: lesión que amenaza la vida, atención hospitalaria en menos de 2 horas, no tratable en campo. */
        medevac: h.medevacAt
          ? {
              activadoAt: h.medevacAt,
              activadoPor: h.medevacPor ? (nombres.get(h.medevacPor) ?? null) : null,
              medioTransporte: h.medioTransporte,
              hospital: h.hospital,
              etaMinutos: h.etaMinutos,
              hospitalNotificadoAt: h.hospitalNotificadoAt,
              hospitalNotificadoPor: h.hospitalNotificadoPor
                ? (nombres.get(h.hospitalNotificadoPor) ?? null)
                : null,
              transferidoAt: h.transferidoAt,
              transferidoPor: h.transferidoPor ? (nombres.get(h.transferidoPor) ?? null) : null,
              etapa: h.transferidoAt
                ? ('transferido' as const)
                : h.hospitalNotificadoAt
                  ? ('hospital_notificado' as const)
                  : h.medioTransporte && h.hospital
                    ? ('listo_para_notificar' as const)
                    : ('activado' as const),
            }
          : null,
      })),
      /** Cronómetro: cada línea con los minutos transcurridos desde la activación. */
      cronometro: e.lineas.map((l) => ({
        at: l.at,
        minutos: Math.max(
          0,
          Math.round(((l.at.getTime() - e.activadoAt.getTime()) / 60_000) * 10) / 10,
        ),
        texto: l.texto,
        automatica: l.automatica,
        actor: nombres.get(l.actorId) ?? null,
      })),
      historial: e.historial.map((h) => ({
        estado: h.estadoNuevo,
        actor: nombres.get(h.actorId) ?? null,
        at: h.createdAt,
      })),
    };
  }

  /**
   * ¿Hay una investigación de incidentes abierta por esta emergencia? Es la tabla de otra sesión (`investigacion`): solo se consulta si existe;
   * si el módulo no está instalado devuelve `true` (no hay nada que exigir).
   */
  async tieneInvestigacion(
    db: Pick<PrismaService, '$queryRaw'> | Tx,
    emergenciaId: string,
  ): Promise<boolean> {
    const existe = await db.$queryRaw<
      Array<{ r: string | null }>
    >`SELECT to_regclass('qhse.investigacion')::text AS r`;
    if (!existe[0]?.r) return true;
    const filas = await db.$queryRaw<
      Array<{ n: number }>
    >`SELECT count(*)::int AS n FROM qhse.investigacion WHERE origen_emergencia_id = ${emergenciaId}::uuid`;
    return (filas[0]?.n ?? 0) > 0;
  }

  /** Tablero de emergencias del año: por estado y nivel, heridos por triage, MEDEVAC y Reporte Flash. */
  async tablero(
    anio = Number(
      new Date().toLocaleDateString('en-CA', { timeZone: 'America/Guayaquil' }).slice(0, 4),
    ),
  ) {
    const desde = new Date(`${anio}-01-01T00:00:00-05:00`);
    const hasta = new Date(`${anio + 1}-01-01T00:00:00-05:00`);
    const filas = await this.prisma.emergencia.findMany({
      where: { activadoAt: { gte: desde, lt: hasta } },
      include: { reporteFlash: true, heridos: true },
    });
    const porEstado = { activa: 0, controlada: 0, cerrada: 0 };
    const porNivel = { sinDeclarar: 0, nivel1: 0, nivel2: 0, nivel3: 0 };
    const triage = { rojo: 0, amarillo: 0, verde: 0, negro: 0 };
    let medevacActivados = 0;
    let medevacTransferidos = 0;
    let flashPendientes = 0;
    let flashFueraDePlazo = 0;
    for (const e of filas) {
      porEstado[e.estado]++;
      if (e.nivel === null) porNivel.sinDeclarar++;
      else porNivel[`nivel${e.nivel}` as 'nivel1' | 'nivel2' | 'nivel3']++;
      for (const h of e.heridos) {
        triage[h.triage]++;
        if (h.medevacAt) medevacActivados++;
        if (h.transferidoAt) medevacTransferidos++;
      }
      if (e.reporteFlash) {
        if (minutosEntre(e.activadoAt, e.reporteFlash.emitidoAt) > PLAZO_REPORTE_FLASH_MINUTOS)
          flashFueraDePlazo++;
      } else if (e.estado !== 'cerrada') flashPendientes++;
    }
    return {
      anio,
      total: filas.length,
      porEstado,
      porNivel,
      heridosPorTriage: triage,
      medevacActivados,
      medevacTransferidos,
      reporteFlashPendientes: flashPendientes,
      reporteFlashFueraDePlazo: flashFueraDePlazo,
      plazoReporteFlashMinutos: PLAZO_REPORTE_FLASH_MINUTOS,
    };
  }

  private async tickets(ids: Array<string | null>) {
    const lista = [...new Set(ids.filter((x): x is string => !!x))];
    const filas = lista.length
      ? await this.prisma.ticketRef.findMany({
          where: { ticketId: { in: lista } },
          select: {
            ticketId: true,
            ticketNumero: true,
            pedidoCodigo: true,
            cliente: true,
            campo: true,
            pozo: true,
          },
        })
      : [];
    return new Map(filas.map((f) => [f.ticketId, f]));
  }

  /** Nombre de cada cuenta (las columnas de personas no tienen relación de Prisma: ver schema.prisma). */
  private async nombres(ids: string[]): Promise<Map<string, string>> {
    const filas = await this.prisma.idUsuario.findMany({
      where: { id: { in: [...new Set(ids)] } },
      select: { id: true, nombre: true },
    });
    return new Map(filas.map((f) => [f.id, f.nombre]));
  }
}
