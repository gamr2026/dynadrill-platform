import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/** Consecutivo visible de la emergencia: EME-000001. */
export const codigoEmergencia = (numero: number): string =>
  `EME-${String(numero).padStart(6, '0')}`;

const codigoSwa = (numero: number) => `SWA-${String(numero).padStart(6, '0')}`;
const codigoDerrame = (numero: number) => `DER-${String(numero).padStart(6, '0')}`;

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
