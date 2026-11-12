import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { currentTraceparent, type AuthUser } from '@dyn/common';
import { EventBus } from '@dyn/messaging';
import { uuidv7 } from '@dyn/utils';
import type { Prisma } from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';

/** Nombre del cliente en el aviso (no se importa de `tickets.service`, que importa este servicio). */
const nombreCliente = (c: { nombreFiscal: string | null; nombreComercial: string } | null) =>
  c ? (c.nombreFiscal ?? c.nombreComercial) : null;
const ROL_JEFE_BASE = 'jefe_base';
const ROL_SUPERADMIN = 'superadmin';

/** Motivo que lleva la historia cuando el sistema hace al Jefe de Base responsable por su primera acción en la revisión inicial. */
export const MOTIVO_AUTOMATICO = 'Asumido automáticamente al iniciar la revisión inicial';

/** El ticket tal como lo necesita quien cambia el responsable. */
type TicketParaResponsable = Prisma.TicketGetPayload<{
  include: { cliente: true; pozo: true; paso: true };
}>;

/**
 * Jefe de Base responsable del ticket. Hay más de uno: el responsable ordena la bandeja («mías», «sin asignar») pero no restringe quién ve
 * o actúa. Se toma (si nadie lo tiene), se asigna o reasigna a otro Jefe de Base (con motivo si ya había uno) y se libera. Cada cambio queda
 * en `ticket_responsable_historial` y se publica `operaciones.pumping.responsable_asignado` en la misma transacción.
 */
@Injectable()
export class ResponsableService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: EventBus,
  ) {}

  /** El Jefe de Base que consulta se queda con el ticket si nadie lo tiene; 409 si ya es de otro (o de él). */
  async tomar(id: string, actor: AuthUser): Promise<void> {
    if (actor.roleCode !== ROL_JEFE_BASE)
      throw new ForbiddenException('Solo un Jefe de Base puede tomar un ticket');
    await this.prisma.$transaction(async (tx) => {
      const t = await this.cargar(tx, id);
      if (t.responsableId) {
        throw new ConflictException({
          message:
            t.responsableId === actor.id
              ? 'Ya es el responsable de este ticket'
              : 'Este ticket ya tiene responsable: pida que se lo reasignen',
          code: 'RESPONSABLE_YA_ASIGNADO',
          responsableId: t.responsableId,
        });
      }
      await this.cambiar(tx, t, actor.id, 'Tomado por el Jefe de Base', actor, false);
    });
  }

  /** Asigna (o reasigna) el ticket a un Jefe de Base. Con responsable actual, el motivo es obligatorio. Lo hacen el Jefe de Base y Superadmin. */
  async asignar(
    id: string,
    usuarioId: string,
    motivo: string | undefined,
    actor: AuthUser,
  ): Promise<void> {
    this.exigirCoordina(actor);
    await this.prisma.$transaction(async (tx) => {
      const t = await this.cargar(tx, id);
      const destino = await tx.idUsuario.findUnique({
        where: { id: usuarioId },
        include: { rol: true },
      });
      if (!destino || !destino.activo)
        throw new BadRequestException('El usuario indicado no existe o está inactivo');
      if (destino.rol.codigo !== ROL_JEFE_BASE)
        throw new BadRequestException(`${destino.nombre} no tiene el rol de Jefe de Base`);
      if (t.responsableId === usuarioId)
        throw new ConflictException({
          message: `${destino.nombre} ya es el responsable de este ticket`,
          code: 'RESPONSABLE_YA_ASIGNADO',
          responsableId: t.responsableId,
        });
      const texto = motivo?.trim();
      if (t.responsableId && !texto)
        throw new BadRequestException('El motivo es obligatorio al reemplazar al responsable');
      await this.cambiar(tx, t, usuarioId, texto || `Asignado por ${actor.name}`, actor, false);
    });
  }

  /** Deja el ticket sin responsable. Si lo tenía otro, el motivo es obligatorio. Lo hacen el responsable, otro Jefe de Base y Superadmin. */
  async liberar(id: string, motivo: string | undefined, actor: AuthUser): Promise<void> {
    this.exigirCoordina(actor);
    await this.prisma.$transaction(async (tx) => {
      const t = await this.cargar(tx, id);
      if (!t.responsableId) throw new ConflictException('Este ticket no tiene responsable');
      const texto = motivo?.trim();
      if (t.responsableId !== actor.id && !texto)
        throw new BadRequestException('El motivo es obligatorio al liberar un ticket de otro');
      await this.cambiar(tx, t, null, texto || 'Liberado por su responsable', actor, false);
    });
  }

  /**
   * La primera acción de un Jefe de Base sobre un ticket sin responsable en la revisión inicial lo hace responsable. Se llama dentro de la
   * transacción de esa acción (avanzar el ticket); no hace nada si ya tiene responsable.
   */
  async asumirSiVacio(
    tx: Prisma.TransactionClient,
    ticketId: string,
    actor: AuthUser,
  ): Promise<boolean> {
    if (actor.roleCode !== ROL_JEFE_BASE) return false;
    const t = await tx.ticket.findUnique({
      where: { id: ticketId },
      include: { cliente: true, pozo: true, paso: true },
    });
    if (!t || t.responsableId || t.pasoCodigo !== 'revision_inicial') return false;
    return this.cambiar(tx, t, actor.id, MOTIVO_AUTOMATICO, actor, true, false);
  }

  private exigirCoordina(actor: AuthUser) {
    if (actor.roleCode !== ROL_JEFE_BASE && actor.roleCode !== ROL_SUPERADMIN)
      throw new ForbiddenException('Solo el Jefe de Base o la administración pueden hacerlo');
  }

  private async cargar(tx: Prisma.TransactionClient, id: string): Promise<TicketParaResponsable> {
    const t = await tx.ticket.findUnique({
      where: { id },
      include: { cliente: true, pozo: true, paso: true },
    });
    if (!t) throw new NotFoundException('El ticket no existe');
    if (t.paso.terminal)
      throw new ConflictException('El ticket ya está cerrado: no se cambia su responsable');
    return t;
  }

  /**
   * Cambia el responsable con control de concurrencia (solo si sigue siendo el que se leyó), anota la historia y publica el evento.
   * `false` solo cuando `fallarSiCambio` es falso y otro se adelantó; si no, 409.
   */
  private async cambiar(
    tx: Prisma.TransactionClient,
    t: TicketParaResponsable,
    nuevoId: string | null,
    motivo: string,
    actor: AuthUser,
    automatico: boolean,
    fallarSiCambio = true,
  ): Promise<boolean> {
    const r = await tx.ticket.updateMany({
      where: { id: t.id, responsableId: t.responsableId },
      data: { responsableId: nuevoId },
    });
    if (r.count === 0) {
      if (!fallarSiCambio) return false;
      throw new ConflictException('El responsable del ticket cambió; vuelva a intentarlo');
    }
    await tx.ticketResponsableHistorial.create({
      data: {
        id: uuidv7(),
        ticketId: t.id,
        anteriorId: t.responsableId,
        nuevoId,
        motivo,
        actorId: actor.id,
      },
    });
    const nombres = await tx.idUsuario.findMany({
      where: { id: { in: [t.responsableId, nuevoId].filter((x): x is string => !!x) } },
      select: { id: true, nombre: true },
    });
    const persona = (uid: string | null) =>
      uid ? { usuarioId: uid, nombre: nombres.find((n) => n.id === uid)?.nombre ?? null } : null;
    await this.bus.publish(
      tx,
      this.bus.create({
        type: 'operaciones.pumping.responsable_asignado',
        subject: { type: 'pumping_ticket', id: t.id },
        data: {
          ticketId: t.id,
          ticketNumero: t.ticketNumero,
          pedidoId: t.pedidoId,
          pedidoCodigo: t.pedidoCodigo,
          cliente: nombreCliente(t.cliente),
          pozo: t.pozo?.nombreCompleto ?? null,
          pasoCodigo: t.pasoCodigo,
          anterior: persona(t.responsableId),
          nuevo: persona(nuevoId),
          motivo,
          asignadoPor: actor.name,
          automatico,
          // a quién se le avisa: el nuevo responsable (si no lo hizo él mismo) y, si lo perdió, el anterior
          asignados:
            nuevoId && nuevoId !== actor.id
              ? [{ usuarioId: nuevoId, rolCodigo: ROL_JEFE_BASE }]
              : [],
          desasignados:
            t.responsableId && t.responsableId !== actor.id
              ? [{ usuarioId: t.responsableId, rolCodigo: ROL_JEFE_BASE }]
              : [],
        },
        actor: { userId: actor.id, role: actor.roleCode },
        traceparent: currentTraceparent(),
      }),
    );
    return true;
  }
}
