import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AuthUser } from '@dyn/common';
import { REQ } from '../catalog/sembrar-traslado-salida';
import { PrismaService } from '../prisma/prisma.service';
import { RequisitosService } from './requisitos.service';

const PASO = 'ejecucion_operativa';

/**
 * Formalización de la ejecución: el Supervisor asignado confirma que el Company Man aprobó el inicio del trabajo. Es una de
 * las dos condiciones para salir de Ejecución operativa (la otra es el checklist de ingreso a locación).
 */
@Injectable()
export class EjecucionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly requisitos: RequisitosService,
  ) {}

  async formalizar(ticketId: string, actor: AuthUser) {
    await this.prisma.$transaction(async (tx) => {
      const t = await tx.ticket.findUnique({
        where: { id: ticketId },
        select: { pasoCodigo: true, personas: { select: { usuarioId: true, rol: true } } },
      });
      if (!t) throw new NotFoundException('El ticket no existe');
      if (t.pasoCodigo !== PASO) {
        throw new ConflictException('La ejecución se formaliza en el paso de Ejecución operativa');
      }
      const esSupervisorAsignado = t.personas.some(
        (p) => p.rol === 'supervisor' && p.usuarioId === actor.id,
      );
      if (!esSupervisorAsignado && actor.roleCode !== 'superadmin') {
        throw new ForbiddenException(
          'Solo el Supervisor asignado a este ticket puede formalizar la ejecución',
        );
      }
      await this.requisitos.marcar(
        tx,
        { ticketId, codigo: REQ.ejecucionFormalizada },
        'sistema',
        actor.id,
      );
    });
    return { ok: true };
  }
}
