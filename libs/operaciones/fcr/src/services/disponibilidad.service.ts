import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';
import { evaluarDisponibilidad, type Ocupacion } from './disponibilidad';

/** Rol de cuenta de quien puede ser operador de un servicio de FCR. */
export const ROL_OPERADOR_FCR = 'operador_fcr';

const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const aDia = (d: Date): string => d.toISOString().slice(0, 10);

/** Un rango de días 'YYYY-MM-DD' inclusivo. */
export interface Rango {
  desde: string;
  hasta: string;
}

type Db = Pick<Prisma.TransactionClient, 'ticket' | 'ticketPersona' | 'idUsuario'>;

/**
 * Disponibilidad de los operadores de FCR frente a un rango de días (pantalla «Asignar operador»). Un operador está ocupado cuando ya
 * está asignado a otro ticket de FCR sin cerrar cuyas fechas de servicio se cruzan con el rango. Un ticket libera a su equipo el día de
 * fin del servicio; si ese día ya pasó y el ticket sigue abierto, hasta que se cierre. Sin fechas se asume lo más estricto.
 */
@Injectable()
export class DisponibilidadService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Los operadores activos con su estado frente al rango. Sin `desde` ni `hasta` se usa el servicio del ticket; con solo `desde`, un día.
   */
  async operadores(ticketId: string, desde?: string, hasta?: string) {
    const rango = await this.rangoDe(this.prisma, ticketId, desde, hasta);
    const operadores = await this.prisma.idUsuario.findMany({
      where: { activo: true, rol: { codigo: ROL_OPERADOR_FCR } },
      select: { id: true, nombre: true },
      orderBy: { nombre: 'asc' },
    });
    const ocupaciones = await this.ocupaciones(
      this.prisma,
      ticketId,
      operadores.map((o) => o.id),
    );
    return {
      desde: rango.desde,
      hasta: rango.hasta,
      operadores: operadores.map((o) => ({
        usuarioId: o.id,
        nombre: o.nombre,
        ...evaluarDisponibilidad(rango.desde, rango.hasta, ocupaciones.get(o.id) ?? []),
      })),
    };
  }

  /** Rechaza la asignación si alguno de los operadores está ocupado durante el servicio del ticket. */
  async exigirLibres(db: Db, ticketId: string, usuarioIds: string[]): Promise<void> {
    const rango = await this.rangoDe(db, ticketId);
    const ocupaciones = await this.ocupaciones(db, ticketId, usuarioIds);
    const ocupados = usuarioIds
      .map((usuarioId) => ({
        usuarioId,
        ...evaluarDisponibilidad(rango.desde, rango.hasta, ocupaciones.get(usuarioId) ?? []),
      }))
      .filter((o) => !o.disponible);
    if (!ocupados.length) return;
    const nombres = await db.idUsuario.findMany({
      where: { id: { in: ocupados.map((o) => o.usuarioId) } },
      select: { id: true, nombre: true },
    });
    const texto = ocupados.map(
      (o) => `${nombres.find((n) => n.id === o.usuarioId)?.nombre ?? o.usuarioId} (${o.detalle})`,
    );
    throw new ConflictException({
      message: `Ya están asignados a otro ticket: ${texto.join('; ')}`,
      code: 'PERSONAL_OCUPADO',
      ocupados: ocupados.map((o) => ({
        usuarioId: o.usuarioId,
        detalle: o.detalle,
        ocupaciones: o.ocupaciones,
      })),
    });
  }

  /** El rango pedido, o el del servicio del ticket si no se pidió uno. */
  private async rangoDe(db: Db, ticketId: string, desde?: string, hasta?: string): Promise<Rango> {
    for (const f of [desde, hasta]) {
      if (f !== undefined && (!FECHA.test(f) || Number.isNaN(Date.parse(`${f}T00:00:00Z`)))) {
        throw new BadRequestException('Las fechas deben tener el formato AAAA-MM-DD');
      }
    }
    const t = await db.ticket.findUnique({
      where: { id: ticketId },
      select: { fechaInicioServicio: true, fechaFinServicio: true },
    });
    if (!t) throw new NotFoundException('El ticket no existe');
    const inicio =
      desde ?? (t.fechaInicioServicio ? aDia(t.fechaInicioServicio) : aDia(new Date()));
    const fin = hasta ?? (desde ? desde : t.fechaFinServicio ? aDia(t.fechaFinServicio) : inicio);
    if (fin < inicio)
      throw new BadRequestException('La fecha final no puede ser anterior a la inicial');
    return { desde: inicio, hasta: fin };
  }

  /** Por operador, los tickets de FCR sin cerrar (distintos de este) en los que está asignado. */
  private async ocupaciones(
    db: Db,
    ticketId: string,
    usuarioIds: string[],
  ): Promise<Map<string, Ocupacion[]>> {
    const filas = await db.ticketPersona.findMany({
      where: {
        ticketId: { not: ticketId },
        usuarioId: { in: usuarioIds },
        rol: 'operador',
        ticket: { paso: { terminal: false } },
      },
      select: {
        usuarioId: true,
        ticket: {
          select: {
            id: true,
            ticketNumero: true,
            pedidoCodigo: true,
            fechaInicioServicio: true,
            fechaFinServicio: true,
          },
        },
      },
    });
    const hoy = aDia(new Date());
    const porOperador = new Map<string, Ocupacion[]>();
    for (const f of filas) {
      const fin = f.ticket.fechaFinServicio ? aDia(f.ticket.fechaFinServicio) : null;
      const lista = porOperador.get(f.usuarioId) ?? [];
      lista.push({
        ticketId: f.ticket.id,
        ticketNumero: f.ticket.ticketNumero,
        pedidoCodigo: f.ticket.pedidoCodigo,
        desde: f.ticket.fechaInicioServicio ? aDia(f.ticket.fechaInicioServicio) : null,
        // si su servicio ya pasó y sigue abierto, el operador sigue ocupado hasta que se cierre
        hasta: fin && fin >= hoy ? fin : null,
      });
      porOperador.set(f.usuarioId, lista);
    }
    return porOperador;
  }
}
