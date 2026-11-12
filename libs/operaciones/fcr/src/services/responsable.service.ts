import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { AuthUser } from '@dyn/common';
import type { Prisma } from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';
import { ROLES_COORDINA, ROLES_SUPERVISAN, TicketsService } from './tickets.service';

/** Roles de cuenta que pueden ser el responsable de un ticket: los Supervisores de FCR. */
const ROLES_RESPONSABLE = ['supervisor', 'supervisor_operaciones_fcr'];
/** Quien puede quitarle el ticket a otro supervisor: quienes coordinan y el Supervisor de Operaciones FCR. */
const ROLES_LIBERAN_AJENOS = [...ROLES_COORDINA, 'supervisor_operaciones_fcr'];

/**
 * Responsable del ticket. Hay varios Supervisores de FCR y todos ven todos los tickets: el responsable es quien lo tiene a su cargo en la
 * bandeja (`bandeja=mias`). No restringe la visibilidad ni quién puede actuar en los pasos (eso lo sigue decidiendo el equipo asignado).
 *  - tomar: el Supervisor se asigna un ticket que no tiene responsable.
 *  - asignar: quien supervisa o coordina lo asigna (o reasigna) a un Supervisor.
 *  - liberar: lo deja sin responsable; lo hace el propio responsable o quien coordina.
 * Cada cambio queda en `ticket_responsable_historial` y se publica `operaciones.fcr.responsable_asignado`.
 */
@Injectable()
export class ResponsableService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tickets: TicketsService,
  ) {}

  /** El Supervisor toma el ticket si no tiene responsable. Si ya es suyo no hace nada. */
  async tomar(ticketId: string, actor: AuthUser) {
    this.exigirSupervisa(actor);
    await this.prisma.$transaction(async (tx) => {
      const t = await this.cargar(tx, ticketId);
      if (t.responsableId === actor.id) return;
      if (t.responsableId !== null) {
        throw new ConflictException({
          message: 'El ticket ya tiene responsable: pídale a quien coordina que lo reasigne',
          code: 'TICKET_CON_RESPONSABLE',
        });
      }
      await this.tickets.cambiarResponsable(tx, t, actor.id, actor, { accion: 'tomar' });
    });
    return this.tickets.detalle(ticketId, actor);
  }

  /** Asigna (o reasigna) el ticket a un Supervisor de FCR. Si ya es suyo no hace nada. */
  async asignar(ticketId: string, usuarioId: string, motivo: string | undefined, actor: AuthUser) {
    this.exigirSupervisa(actor);
    await this.prisma.$transaction(async (tx) => {
      const t = await this.cargar(tx, ticketId);
      const u = await tx.idUsuario.findUnique({
        where: { id: usuarioId },
        select: { activo: true, nombre: true, rol: { select: { codigo: true } } },
      });
      if (!u || !u.activo) {
        throw new BadRequestException('La persona indicada no existe o está inactiva');
      }
      if (!ROLES_RESPONSABLE.includes(u.rol.codigo)) {
        throw new BadRequestException(`${u.nombre} no es Supervisor de FCR`);
      }
      if (t.responsableId === usuarioId) return;
      await this.tickets.cambiarResponsable(tx, t, usuarioId, actor, { accion: 'asignar', motivo });
    });
    return this.tickets.detalle(ticketId, actor);
  }

  /** Deja el ticket sin responsable: lo hace el propio responsable o quien coordina. */
  async liberar(ticketId: string, motivo: string | undefined, actor: AuthUser) {
    this.exigirSupervisa(actor);
    await this.prisma.$transaction(async (tx) => {
      const t = await this.cargar(tx, ticketId);
      if (t.responsableId === null) {
        throw new ConflictException({
          message: 'El ticket no tiene responsable',
          code: 'TICKET_SIN_RESPONSABLE',
        });
      }
      if (t.responsableId !== actor.id && !ROLES_LIBERAN_AJENOS.includes(actor.roleCode)) {
        throw new ForbiddenException(
          'Solo su responsable o quien coordina puede liberar el ticket',
        );
      }
      await this.tickets.cambiarResponsable(tx, t, null, actor, { accion: 'liberar', motivo });
    });
    return this.tickets.detalle(ticketId, actor);
  }

  private exigirSupervisa(actor: AuthUser): void {
    if (!(ROLES_SUPERVISAN as readonly string[]).includes(actor.roleCode)) {
      throw new ForbiddenException(
        'Solo el Supervisor o quien coordina puede cambiar el responsable',
      );
    }
  }

  /** El ticket existe, no está anulado (lo valida la carga) ni cerrado. */
  private async cargar(tx: Prisma.TransactionClient, ticketId: string) {
    const t = await this.tickets.cargarEnTx(tx, ticketId);
    if (t.paso.terminal) {
      throw new ConflictException('El ticket está cerrado: solo se puede consultar');
    }
    return t;
  }
}
