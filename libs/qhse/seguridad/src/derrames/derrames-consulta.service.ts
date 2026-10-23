import { Injectable, NotFoundException } from '@nestjs/common';
import { codigoDesecho } from '../desechos/desechos-consulta.service';
import { PrismaService } from '../prisma/prisma.service';

/** Consecutivo visible del derrame: DER-000001. */
export const codigoDerrame = (numero: number): string => `DER-${String(numero).padStart(6, '0')}`;

/** HSE-AMBIENTAL-002: la contención se hace en los primeros 5 minutos desde la alerta (se informa; no bloquea). */
export const PLAZO_CONTENCION_MINUTOS = 5;

type Efecto = { exigeNotificacionMae: boolean; escalaAEmergencia: boolean };

/** Banda de volumen con su rango, para ubicar el volumen real (barriles) en la banda que le corresponde. */
export interface BandaConRango extends Efecto {
  id: string;
  codigo: string;
  nombre: string;
  desdeBarriles: number;
  hastaBarriles: number | null;
}

/**
 * Lo que decide si un derrame obliga a notificar al MAE o a escalar a emergencia: la ubicación o la banda de volumen (columnas, no nombres).
 * Si QHSE confirmó el volumen real, **manda la banda más grave entre la reportada y la real** (decisión del 24/10/2026).
 */
export interface ReglasDerrame {
  ubicacion: Efecto;
  banda: Efecto;
  bandaReal?: Efecto | null;
}

/** HSE-AMBIENTAL-002: la notificación al MAE es obligatoria si la banda (reportada o real) o la ubicación la exigen. */
export const requiereNotificacionMae = (d: ReglasDerrame): boolean =>
  d.banda.exigeNotificacionMae ||
  d.ubicacion.exigeNotificacionMae ||
  (d.bandaReal?.exigeNotificacionMae ?? false);

/** HSE-MASTER-001: un derrame mayor o en cuerpo de agua escala a Emergencia Mayor. */
export const escalaAEmergencia = (d: ReglasDerrame): boolean =>
  d.banda.escalaAEmergencia ||
  d.ubicacion.escalaAEmergencia ||
  (d.bandaReal?.escalaAEmergencia ?? false);

/** La banda activa que contiene al volumen: [desde, hasta). */
export const bandaDeVolumen = (
  bandas: BandaConRango[],
  barriles: number | null | undefined,
): BandaConRango | null => {
  if (barriles === null || barriles === undefined) return null;
  return (
    bandas.find(
      (b) =>
        barriles >= b.desdeBarriles && (b.hastaBarriles === null || barriles < b.hastaBarriles),
    ) ?? null
  );
};

/** Minutos entre la alerta y la contención (1 decimal) y si cumplió el plazo de {@link PLAZO_CONTENCION_MINUTOS}. */
export const plazoDeContencion = (activadoAt: Date, contenidoAt: Date | null) => {
  if (!contenidoAt) return { minutos: null, enPlazo: null };
  const minutos = Math.round(((contenidoAt.getTime() - activadoAt.getTime()) / 60_000) * 10) / 10;
  return { minutos, enPlazo: minutos <= PLAZO_CONTENCION_MINUTOS };
};

export interface FiltroDerrames {
  estado?: 'activo' | 'contenido' | 'cerrado';
  ticketId?: string;
  q?: string;
}

const INCLUIR = {
  ubicacion: true,
  banda: true,
} as const;

/** Lectura de derrames: catálogos del formulario, bandeja y detalle. */
@Injectable()
export class DerramesConsultaService {
  constructor(private readonly prisma: PrismaService) {}

  /** Bandas activas con su rango (de aquí sale la banda real de un volumen confirmado). */
  async bandasActivas(
    db: Pick<PrismaService, 'derrameBandaVolumen'> = this.prisma,
  ): Promise<BandaConRango[]> {
    const filas = await db.derrameBandaVolumen.findMany({
      where: { activo: true },
      orderBy: { orden: 'asc' },
    });
    return filas.map((b) => ({
      id: b.id,
      codigo: b.codigo,
      nombre: b.nombre,
      desdeBarriles: Number(b.desdeBarriles),
      hastaBarriles: b.hastaBarriles === null ? null : Number(b.hastaBarriles),
      exigeNotificacionMae: b.exigeNotificacionMae,
      escalaAEmergencia: b.escalaAEmergencia,
    }));
  }

  /** Catálogos del formulario de alerta (los usa quien reporta, aunque no vea la bandeja) y los servicios que puede elegir. */
  async catalogos() {
    const [ubicaciones, bandas, tickets] = await Promise.all([
      this.prisma.derrameUbicacion.findMany({
        where: { activo: true },
        orderBy: { orden: 'asc' },
        select: { id: true, codigo: true, nombre: true },
      }),
      this.prisma.derrameBandaVolumen.findMany({
        where: { activo: true },
        orderBy: { orden: 'asc' },
        select: {
          id: true,
          codigo: true,
          nombre: true,
          desdeBarriles: true,
          hastaBarriles: true,
          porConfirmar: true,
        },
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
    return {
      ubicaciones,
      bandas: bandas.map((b) => ({
        ...b,
        desdeBarriles: Number(b.desdeBarriles),
        hastaBarriles: b.hastaBarriles === null ? null : Number(b.hastaBarriles),
      })),
      tickets,
    };
  }

  async listar(filtro: FiltroDerrames = {}) {
    const q = filtro.q?.trim();
    const filas = await this.prisma.derrame.findMany({
      where: {
        ...(filtro.estado ? { estado: filtro.estado } : {}),
        ...(filtro.ticketId ? { ticketId: filtro.ticketId } : {}),
        ...(q
          ? {
              OR: [
                { descripcion: { contains: q, mode: 'insensitive' } },
                { ubicacionFisica: { contains: q, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      orderBy: { numero: 'desc' },
      include: INCLUIR,
      take: 300,
    });
    const [tickets, bandas] = await Promise.all([
      this.tickets(filas.map((f) => f.ticketId)),
      this.bandasActivas(),
    ]);
    return filas.map((d) => {
      const reglas = this.reglas(d, bandas);
      return {
        id: d.id,
        numero: d.numero,
        codigo: codigoDerrame(d.numero),
        estado: d.estado,
        descripcion: d.descripcion,
        ubicacion: { codigo: d.ubicacion.codigo, nombre: d.ubicacion.nombre },
        banda: { codigo: d.banda.codigo, nombre: d.banda.nombre },
        volumenRealBarriles: d.volumenRealBarriles === null ? null : Number(d.volumenRealBarriles),
        requiereNotificacionMae: requiereNotificacionMae(reglas),
        escalaAEmergencia: escalaAEmergencia(reglas),
        ticketId: d.ticketId,
        ticketNumero: d.ticketId ? (tickets.get(d.ticketId)?.ticketNumero ?? null) : null,
        pedidoCodigo: d.ticketId ? (tickets.get(d.ticketId)?.pedidoCodigo ?? null) : null,
        activadoAt: d.activadoAt,
      };
    });
  }

  async detalle(id: string) {
    const d = await this.prisma.derrame.findUnique({
      where: { id },
      include: {
        ...INCLUIR,
        historial: { orderBy: { createdAt: 'asc' } },
        checklist: true,
        volumenes: { orderBy: { createdAt: 'asc' } },
        desecho: { select: { id: true, numero: true } },
      },
    });
    if (!d) throw new NotFoundException('El derrame no existe');
    const emergencia = await this.prisma.emergencia.findFirst({
      where: { derrameId: id },
      select: { id: true, numero: true, estado: true },
    });
    const [tickets, items, bandas] = await Promise.all([
      this.tickets([d.ticketId]),
      this.prisma.derrameChecklistItem.findMany({
        where: { activo: true },
        orderBy: { orden: 'asc' },
      }),
      this.bandasActivas(),
    ]);
    const nombres = await this.nombres([
      d.activadoPor,
      ...(d.contenidoPor ? [d.contenidoPor] : []),
      ...(d.volumenConfirmadoPor ? [d.volumenConfirmadoPor] : []),
      ...(d.notificadoMaePor ? [d.notificadoMaePor] : []),
      ...(d.cerradoPor ? [d.cerradoPor] : []),
      ...d.historial.map((h) => h.actorId),
      ...d.checklist.map((c) => c.confirmadoPor),
      ...d.volumenes.map((v) => v.actorId),
    ]);
    const t = d.ticketId ? tickets.get(d.ticketId) : undefined;
    const reglas = this.reglas(d, bandas);
    const bandaReal = reglas.bandaReal as BandaConRango | null | undefined;
    const checklist = items.map((i) => {
      const c = d.checklist.find((x) => x.itemId === i.id);
      return {
        itemId: i.id,
        codigo: i.codigo,
        nombre: i.nombre,
        confirmadoAt: c?.confirmadoAt ?? null,
        confirmadoPor: c ? (nombres.get(c.confirmadoPor) ?? null) : null,
      };
    });
    const plazo = plazoDeContencion(d.activadoAt, d.contenidoAt);
    return {
      id: d.id,
      numero: d.numero,
      codigo: codigoDerrame(d.numero),
      estado: d.estado,
      descripcion: d.descripcion,
      ubicacionFisica: d.ubicacionFisica,
      ubicacion: { codigo: d.ubicacion.codigo, nombre: d.ubicacion.nombre },
      banda: {
        codigo: d.banda.codigo,
        nombre: d.banda.nombre,
        porConfirmar: d.banda.porConfirmar,
      },
      /** Banda a la que corresponde el volumen real confirmado (nula mientras no se confirme). */
      bandaReal: bandaReal ? { codigo: bandaReal.codigo, nombre: bandaReal.nombre } : null,
      /** Obligatoria si la ubicación o la banda (la más grave entre la reportada y la real) la exigen. */
      requiereNotificacionMae: requiereNotificacionMae(reglas),
      /** Mayor o en cuerpo de agua: escala a Emergencia Mayor. */
      escalaAEmergencia: escalaAEmergencia(reglas),
      ticketId: d.ticketId,
      ticketNumero: t?.ticketNumero ?? null,
      pedidoCodigo: t?.pedidoCodigo ?? null,
      cliente: t?.cliente ?? null,
      campo: t?.campo ?? null,
      pozo: t?.pozo ?? null,
      activadoPor: nombres.get(d.activadoPor) ?? null,
      activadoAt: d.activadoAt,
      checklist,
      /** Se puede marcar como contenido cuando todos los pasos están confirmados. */
      checklistCompleto: checklist.every((c) => c.confirmadoAt !== null),
      contenidoAt: d.contenidoAt,
      contenidoPor: d.contenidoPor ? (nombres.get(d.contenidoPor) ?? null) : null,
      /** Minutos entre la alerta y la contención; el plazo de 5 minutos se informa, no bloquea. */
      contencionMinutos: plazo.minutos,
      contencionEnPlazo: plazo.enPlazo,
      volumenRealBarriles: d.volumenRealBarriles === null ? null : Number(d.volumenRealBarriles),
      volumenConfirmadoPor: d.volumenConfirmadoPor
        ? (nombres.get(d.volumenConfirmadoPor) ?? null)
        : null,
      volumenConfirmadoAt: d.volumenConfirmadoAt,
      /** Notificación al Ministerio del Ambiente: obligatoria si `requiereNotificacionMae`; sin ella no se cierra. */
      notificacionMae: d.notificadoMaeAt
        ? {
            at: d.notificadoMaeAt,
            por: d.notificadoMaePor ? (nombres.get(d.notificadoMaePor) ?? null) : null,
            referencia: d.maeReferencia,
          }
        : null,
      maePendiente: requiereNotificacionMae(reglas) && !d.notificadoMaeAt && d.estado !== 'cerrado',
      /** Se puede cerrar un derrame contenido que no tenga la notificación al MAE pendiente. */
      puedeCerrar:
        d.estado === 'contenido' && !(requiereNotificacionMae(reglas) && !d.notificadoMaeAt),
      /** El suelo contaminado genera un desecho peligroso (uno por derrame); nulo mientras no se genere. */
      desecho: d.desecho ? { id: d.desecho.id, codigo: codigoDesecho(d.desecho.numero) } : null,
      puedeGenerarDesecho: d.ubicacion.generaDesecho && !d.desecho,
      /** Emergencia a la que escaló (HSE-MASTER-001); nulo mientras no escale. */
      emergencia: emergencia
        ? {
            id: emergencia.id,
            codigo: `EME-${String(emergencia.numero).padStart(6, '0')}`,
            estado: emergencia.estado,
          }
        : null,
      /** Un derrame mayor o en cuerpo de agua escala a emergencia; falta escalarlo mientras no tenga una. */
      puedeEscalarAEmergencia: escalaAEmergencia(reglas) && !emergencia && d.estado !== 'cerrado',
      cerradoAt: d.cerradoAt,
      cerradoPor: d.cerradoPor ? (nombres.get(d.cerradoPor) ?? null) : null,
      volumenes: d.volumenes.map((v) => ({
        barriles: Number(v.volumenBarriles),
        actor: nombres.get(v.actorId) ?? null,
        at: v.createdAt,
      })),
      historial: d.historial.map((h) => ({
        estado: h.estadoNuevo,
        actor: nombres.get(h.actorId) ?? null,
        at: h.createdAt,
      })),
    };
  }

  /**
   * Tablero de derrames: por estado, notificaciones al MAE pendientes, contención dentro del plazo de 5 minutos y el volumen real derramado
   * del año (KPI «volumen total derramado» de HSE-MASTER-001).
   */
  async tablero(
    anio = Number(
      new Date().toLocaleDateString('en-CA', { timeZone: 'America/Guayaquil' }).slice(0, 4),
    ),
  ) {
    const desde = new Date(`${anio}-01-01T00:00:00-05:00`);
    const hasta = new Date(`${anio + 1}-01-01T00:00:00-05:00`);
    const [filas, bandas] = await Promise.all([
      this.prisma.derrame.findMany({
        where: { activadoAt: { gte: desde, lt: hasta } },
        include: INCLUIR,
      }),
      this.bandasActivas(),
    ]);
    const porEstado = { activo: 0, contenido: 0, cerrado: 0 };
    let maePendientes = 0;
    let contenidos = 0;
    let enPlazo = 0;
    let volumen = 0;
    let sinVolumen = 0;
    for (const d of filas) {
      porEstado[d.estado]++;
      const reglas = this.reglas(d, bandas);
      if (requiereNotificacionMae(reglas) && !d.notificadoMaeAt && d.estado !== 'cerrado')
        maePendientes++;
      if (d.contenidoAt) {
        contenidos++;
        if (plazoDeContencion(d.activadoAt, d.contenidoAt).enPlazo) enPlazo++;
      }
      if (d.volumenRealBarriles !== null) volumen += Number(d.volumenRealBarriles);
      else if (d.estado !== 'activo') sinVolumen++;
    }
    return {
      anio,
      total: filas.length,
      porEstado,
      maePendientes,
      contenidos,
      contenidosEnPlazo: enPlazo,
      plazoContencionMinutos: PLAZO_CONTENCION_MINUTOS,
      /** Suma del volumen real confirmado (barriles) de los derrames del año. */
      volumenRealBarriles: Math.round(volumen * 1000) / 1000,
      /** Contenidos o cerrados cuyo volumen real aún no se confirma (no suman al KPI). */
      sinVolumenConfirmado: sinVolumen,
    };
  }

  /** Las reglas del derrame con la banda del volumen real (si ya se confirmó). */
  reglas(
    d: {
      ubicacion: Efecto;
      banda: Efecto;
      volumenRealBarriles: { toString(): string } | null;
    },
    bandas: BandaConRango[],
  ): ReglasDerrame {
    return {
      ubicacion: d.ubicacion,
      banda: d.banda,
      bandaReal: bandaDeVolumen(
        bandas,
        d.volumenRealBarriles === null ? null : Number(d.volumenRealBarriles),
      ),
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
