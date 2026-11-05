import { Injectable, NotFoundException } from '@nestjs/common';
import { currentTraceparent } from '@dyn/common';
import { EventBus } from '@dyn/messaging';
import type { Prisma } from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';
import { JornadasService } from './jornadas.service';

/** Puntos de diferencia entre el avance real y el planificado desde los que se considera que el servicio va adelantado. */
export const UMBRAL_ADELANTO = 10;

const redondear = (n: number): number => Math.round(n * 10) / 10;
const aFecha = (d: Date): string => d.toISOString().slice(0, 10);

type Db = Pick<
  Prisma.TransactionClient,
  'ticket' | 'ticketLinea' | 'ticketJornada' | 'solicitudCambioItems'
>;

/**
 * Avance del servicio: lo cotizado frente a lo usado, línea por línea, y el avance real frente al planificado (los días transcurridos del
 * servicio). Sirve para que el Jefe de Base vea si el trabajo va adelantado (y decida acortar) o atrasado (y decida ampliar).
 *  - Lo usado de cada línea es lo repartido en los días del Reporte de Herramientas.
 *  - El avance real es el promedio del avance de las líneas de servicio y herramienta (las de material se muestran, pero no cuentan: se
 *    consumen según el pozo, no según los días); cada línea cuenta hasta el 100 %.
 *  - El avance planificado es la parte de los días del servicio que ya empezó (hoy incluido).
 */
@Injectable()
export class AvanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: EventBus,
    private readonly jornadas: JornadasService,
  ) {}

  async obtener(ticketId: string) {
    const a = await this.calcular(this.prisma, ticketId);
    const pendientes = await this.prisma.solicitudCambioItems.findMany({
      where: { ticketId, estado: 'pendiente' },
      select: { id: true, motivo: true, solicitadoAt: true },
      orderBy: { solicitadoAt: 'asc' },
    });
    return { ...a, solicitudesPendientes: pendientes };
  }

  /**
   * Si el avance real ya va adelantado del plan, avisa al Jefe de Base (una sola vez por ticket). Se llama cada vez que se guardan las
   * cantidades usadas; no hace nada si el servicio ya está en su último día (ya no hay nada que acortar).
   */
  async evaluarAdelanto(tx: Prisma.TransactionClient, ticketId: string): Promise<boolean> {
    const a = await this.calcular(tx, ticketId);
    if (!a.adelantado) return false;
    const previo = await tx.ticketAvisoAvance.findUnique({ where: { ticketId } });
    if (previo) return false;
    await tx.ticketAvisoAvance.create({
      data: { ticketId, avanceReal: a.avanceReal, avancePlan: a.avancePlan },
    });
    const t = await tx.ticket.findUniqueOrThrow({
      where: { id: ticketId },
      select: {
        pedidoId: true,
        pedidoCodigo: true,
        ticketNumero: true,
        cliente: { select: { nombreComercial: true } },
        pozo: { select: { nombreCompleto: true } },
      },
    });
    await this.bus.publish(
      tx,
      this.bus.create({
        type: 'operaciones.pumping.avance_adelantado',
        subject: { type: 'pumping_ticket', id: ticketId },
        data: {
          ticketId,
          ticketNumero: t.ticketNumero,
          pedidoId: t.pedidoId,
          pedidoCodigo: t.pedidoCodigo,
          cliente: t.cliente?.nombreComercial ?? null,
          pozo: t.pozo?.nombreCompleto ?? null,
          avanceReal: a.avanceReal,
          avancePlan: a.avancePlan,
          diaActual: a.diaActual,
          diasTotal: a.diasTotal,
        },
        traceparent: currentTraceparent(),
      }),
    );
    return true;
  }

  private async calcular(db: Db, ticketId: string) {
    const t = await db.ticket.findUnique({
      where: { id: ticketId },
      select: { id: true, fechaInicioServicio: true, fechaFinServicio: true },
    });
    if (!t) throw new NotFoundException('El ticket no existe');
    const lineas = await db.ticketLinea.findMany({
      where: { ticketId },
      orderBy: { orden: 'asc' },
      include: { unidadMedida: { select: { nombre: true } }, dias: { select: { cantidad: true } } },
    });
    const filas = lineas.map((l) => {
      const cotizado = Number(l.cantidad);
      const usado = l.dias.reduce((s, d) => s + Number(d.cantidad), 0);
      return {
        lineaId: l.id,
        codigo: l.codigo,
        descripcion: l.descripcion,
        tipoLinea: l.tipoLinea,
        unidad: l.unidadMedida.nombre,
        cotizado,
        usado,
        porcentaje: cotizado > 0 ? redondear((usado / cotizado) * 100) : null,
        excedido: cotizado > 0 && usado > cotizado,
      };
    });
    const cuentan = filas.filter((f) => f.tipoLinea !== 'material' && f.porcentaje !== null);
    const avanceReal = cuentan.length
      ? redondear(
          cuentan.reduce((s, f) => s + Math.min(f.porcentaje ?? 0, 100), 0) / cuentan.length,
        )
      : null;

    const jornadas = await db.ticketJornada.findMany({
      where: { ticketId, estado: { not: 'no_aplica' } },
      select: { fecha: true },
    });
    const hoy = this.jornadas.hoy();
    const diasTotal = jornadas.length;
    const diaActual = jornadas.filter((j) => aFecha(j.fecha) <= hoy).length;
    const avancePlan = diasTotal ? redondear((diaActual / diasTotal) * 100) : null;
    const diferencia =
      avanceReal !== null && avancePlan !== null ? redondear(avanceReal - avancePlan) : null;
    return {
      ticketId,
      lineas: filas,
      avanceReal: avanceReal as number,
      avancePlan: avancePlan as number,
      diferencia,
      diaActual,
      diasTotal,
      umbralAdelanto: UMBRAL_ADELANTO,
      adelantado:
        diferencia !== null &&
        diferencia >= UMBRAL_ADELANTO &&
        diaActual > 0 &&
        diaActual < diasTotal,
      atrasado: diferencia !== null && diferencia <= -UMBRAL_ADELANTO && diaActual > 0,
    };
  }
}
