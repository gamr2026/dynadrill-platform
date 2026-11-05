import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { currentTraceparent, type AuthUser } from '@dyn/common';
import { EventBus } from '@dyn/messaging';
import { uuidv7 } from '@dyn/utils';
import type { AccionDuracion, Prisma } from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';
import { AsignacionService } from './asignacion.service';
import { fechaValida, JornadasService } from './jornadas.service';

const PASO = 'ejecucion_operativa';
const aFecha = (d: Date): string => d.toISOString().slice(0, 10);
const deDia = (f: string): Date => new Date(`${f}T00:00:00Z`);

/**
 * Duración del servicio. Si los operadores avanzan antes de lo previsto, o el trabajo se alarga, el **Jefe de Base** decide acortar o ampliar el
 * servicio (el Operador y el Supervisor ven el avance y pueden proponerlo, pero no lo deciden). La fecha de fin es del pedido (Comercial), así que:
 *  1. Pumping la cambia en el ticket de inmediato: las jornadas sobrantes pasan a «no aplica» (o se crean las nuevas) y QHSE recibe los días nuevos;
 *  2. avisa a Comercial (`operaciones.pumping.duracion_servicio_cambiada`), que la aplica al pedido;
 *  3. si Comercial no puede (el pedido ya está congelado), responde `comercial.duracion_servicio.rechazada` y Pumping revierte el cambio.
 * Todo queda en la bitácora `ticket_duracion_cambio`.
 */
@Injectable()
export class DuracionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: EventBus,
    private readonly jornadas: JornadasService,
    private readonly asignacion: AsignacionService,
  ) {}

  /** Acorta o amplía el servicio: `fechaFin` es la nueva fecha de fin (AAAA-MM-DD) y `motivo` es obligatorio. */
  async cambiar(
    ticketId: string,
    accion: 'acortar' | 'ampliar',
    fechaFin: string,
    motivo: string,
    actor: AuthUser,
  ) {
    const texto = motivo.trim();
    if (texto.length < 3) throw new BadRequestException('Escriba el motivo (mínimo 3 caracteres)');
    if (!fechaValida(fechaFin))
      throw new BadRequestException('La fecha debe tener el formato AAAA-MM-DD');
    await this.prisma.$transaction(async (tx) => {
      const t = await tx.ticket.findUnique({
        where: { id: ticketId },
        select: {
          pasoCodigo: true,
          fechaInicioServicio: true,
          fechaFinServicio: true,
          pedidoId: true,
          pedidoCodigo: true,
          ticketNumero: true,
          personas: { select: { usuarioId: true } },
        },
      });
      if (!t) throw new NotFoundException('El ticket no existe');
      if (t.pasoCodigo !== PASO)
        throw new ConflictException('La duración del servicio se cambia en la Ejecución operativa');
      if (!t.fechaInicioServicio || !t.fechaFinServicio)
        throw new ConflictException(
          'El pedido no tiene fechas de servicio: no hay duración que cambiar',
        );
      const inicio = aFecha(t.fechaInicioServicio);
      const actual = aFecha(t.fechaFinServicio);
      if (fechaFin < inicio)
        throw new BadRequestException(
          `La fecha de fin no puede ser anterior al inicio (${inicio})`,
        );
      if (accion === 'acortar' && !(fechaFin < actual))
        throw new ConflictException(
          `Para acortar, la nueva fecha de fin debe ser anterior a la actual (${actual})`,
        );
      if (accion === 'ampliar' && !(fechaFin > actual))
        throw new ConflictException(
          `Para ampliar, la nueva fecha de fin debe ser posterior a la actual (${actual})`,
        );

      if (accion === 'acortar') {
        // un día con trabajo registrado (cerrado o sin operación) no puede quedar fuera del servicio
        await this.jornadas.generar(tx, ticketId);
        const ultimo = await tx.ticketJornada.findFirst({
          where: { ticketId, estado: { in: ['cerrada', 'sin_operacion'] } },
          orderBy: { fecha: 'desc' },
          select: { fecha: true },
        });
        if (ultimo && fechaFin < aFecha(ultimo.fecha))
          throw new ConflictException(
            `No se puede acortar antes del ${aFecha(ultimo.fecha)}: ese día ya tiene trabajo registrado`,
          );
      }

      await tx.ticket.update({
        where: { id: ticketId },
        data: { fechaFinServicio: deDia(fechaFin) },
      });

      if (accion === 'ampliar') {
        // ampliar retiene al personal más días: no puede cruzarse con otro servicio abierto de las mismas personas
        const ocupadas = await this.asignacion.ocupadasPor(
          tx,
          ticketId,
          t.personas.map((p) => p.usuarioId),
          new Date(deDia(actual).getTime() + 86_400_000), // solo los días que se suman
        );
        if (ocupadas.length) {
          const tickets = [...new Set(ocupadas.map((o) => o.ticketNumero ?? o.pedidoCodigo))];
          throw new ConflictException(
            `Ampliar hasta el ${fechaFin} se cruza con otro servicio del mismo personal (ticket ${tickets.join(', ')}). Reasigne al personal o amplíe hasta una fecha anterior.`,
          );
        }
      }

      // las jornadas sobrantes pasan a «no aplica» (o se crean las nuevas) y QHSE recibe la lista nueva de días
      await this.jornadas.generar(tx, ticketId);
      await this.anotar(tx, ticketId, accion, actual, fechaFin, texto, actor.id);
      await this.bus.publish(
        tx,
        this.bus.create({
          type: 'operaciones.pumping.duracion_servicio_cambiada',
          subject: { type: 'pumping_ticket', id: ticketId },
          data: {
            ticketId,
            ticketNumero: t.ticketNumero,
            pedidoId: t.pedidoId,
            pedidoCodigo: t.pedidoCodigo,
            accion,
            fechaFinAnterior: actual,
            fechaFinNueva: fechaFin,
            motivo: texto,
          },
          actor: { userId: actor.id, role: actor.roleCode },
          traceparent: currentTraceparent(),
        }),
      );
    });
    return this.jornadas.listar(ticketId);
  }

  /**
   * Comercial no pudo aplicar el cambio al pedido: el ticket vuelve a la fecha anterior (solo si todavía tiene la que se cambió; si el pedido ya
   * cambió de otra forma, esa fecha manda y no se toca).
   */
  async revertir(
    tx: Prisma.TransactionClient,
    ticketId: string,
    fechaFinNueva: string,
    fechaFinAnterior: string,
    motivo: string,
  ): Promise<boolean> {
    if (!fechaValida(fechaFinNueva) || !fechaValida(fechaFinAnterior)) return false;
    const t = await tx.ticket.findUnique({
      where: { id: ticketId },
      select: { fechaFinServicio: true },
    });
    if (!t?.fechaFinServicio || aFecha(t.fechaFinServicio) !== fechaFinNueva) return false;
    await tx.ticket.update({
      where: { id: ticketId },
      data: { fechaFinServicio: deDia(fechaFinAnterior) },
    });
    await this.jornadas.generar(tx, ticketId);
    await this.anotar(
      tx,
      ticketId,
      'revertir',
      fechaFinNueva,
      fechaFinAnterior,
      `Comercial no pudo aplicar el cambio: ${motivo}`,
      null,
    );
    return true;
  }

  private anotar(
    tx: Prisma.TransactionClient,
    ticketId: string,
    accion: AccionDuracion,
    anterior: string,
    nueva: string,
    motivo: string,
    actorId: string | null,
  ) {
    return tx.ticketDuracionCambio.create({
      data: {
        id: uuidv7(),
        ticketId,
        accion,
        fechaFinAnterior: deDia(anterior),
        fechaFinNueva: deDia(nueva),
        motivo,
        actorId,
      },
    });
  }
}
