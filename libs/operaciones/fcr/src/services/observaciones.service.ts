import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { AuthUser } from '@dyn/common';
import { uuidv7 } from '@dyn/utils';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Observaciones del ticket (botón «Observaciones» de la demo): notas con autor, rol y fecha que se agregan desde cualquier fase y no se
 * editan ni se borran. No disparan ninguna acción de negocio. Un ticket cerrado es de solo lectura.
 */
@Injectable()
export class ObservacionesService {
  constructor(private readonly prisma: PrismaService) {}

  /** Las observaciones del ticket, de la más antigua a la más reciente. */
  async listar(ticketId: string) {
    await this.exigirTicket(ticketId);
    const filas = await this.prisma.ticketObservacion.findMany({
      where: { ticketId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      include: { autor: { select: { nombre: true } }, rol: { select: { nombre: true } } },
    });
    return filas.map((o) => ({
      id: o.id,
      mensaje: o.mensaje,
      autor: o.autor.nombre,
      autorRol: o.autorRol,
      autorRolNombre: o.rol.nombre,
      fecha: o.createdAt,
    }));
  }

  /** Agrega una observación a nombre de quien la escribe, con el rol con el que actúa. */
  async agregar(ticketId: string, mensaje: string, actor: AuthUser) {
    const t = await this.exigirTicket(ticketId);
    if (t.paso.terminal) {
      throw new ConflictException('El ticket está cerrado: ya no admite observaciones');
    }
    const creada = await this.prisma.ticketObservacion.create({
      data: {
        id: uuidv7(),
        ticketId,
        mensaje: mensaje.trim(),
        autorRol: actor.roleCode,
        createdBy: actor.id,
      },
      include: { autor: { select: { nombre: true } }, rol: { select: { nombre: true } } },
    });
    return {
      id: creada.id,
      mensaje: creada.mensaje,
      autor: creada.autor.nombre,
      autorRol: creada.autorRol,
      autorRolNombre: creada.rol.nombre,
      fecha: creada.createdAt,
    };
  }

  private async exigirTicket(ticketId: string) {
    const t = await this.prisma.ticket.findUnique({
      where: { id: ticketId },
      select: { paso: { select: { terminal: true } } },
    });
    if (!t) throw new NotFoundException('El ticket no existe');
    return t;
  }
}
