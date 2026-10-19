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
import { puedeActuar, puedeActuarEn } from './tickets.service';

const PASO = 'revision_reportes_salida';
const MOTIVO = 'Aprobada por el Supervisor del ticket al revisar los reportes de salida';

/**
 * Revisión de reportes de salida: el Supervisor del equipo revisa el reporte de cada unidad y aprueba su inspección de vehículos
 * (requisito `inspeccion_vehiculo_aprobada`). La inspección es de Flota: cuando Flota publique `flota.inspeccion_vehiculo.aprobada`
 * el requisito se cumple por ese evento; mientras tanto la aprobación del Supervisor lo cumple con el puente temporal y queda
 * registrada (quién, cuándo y con qué motivo). El gerenciamiento de viaje de salida sí es de Flota/Jefe de Base: no se aprueba aquí.
 */
@Injectable()
export class RevisionSalidaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly requisitos: RequisitosService,
  ) {}

  async aprobarInspeccion(ticketId: string, vehiculoId: string, actor: AuthUser) {
    await this.prisma.$transaction(async (tx) => {
      const t = await tx.ticket.findUnique({
        where: { id: ticketId },
        select: {
          pasoCodigo: true,
          paso: { select: { nombre: true, roles: true } },
          personas: { select: { usuarioId: true } },
        },
      });
      if (!t) throw new NotFoundException('El ticket no existe');
      if (t.pasoCodigo !== PASO) {
        throw new ConflictException(
          'La inspección se aprueba en la Revisión de reportes de salida',
        );
      }
      if (!puedeActuar(t.paso.roles, actor.roleCode)) {
        throw new ForbiddenException(`El paso "${t.paso.nombre}" lo atiende otro rol`);
      }
      if (!puedeActuarEn(t, actor)) {
        throw new ForbiddenException('Solo el equipo asignado a este ticket puede hacerlo');
      }
      const fila = await tx.ticketRequisito.findFirst({
        where: { ticketId, requisitoCodigo: REQ.inspeccionAprobada, vehiculoId },
      });
      if (!fila)
        throw new NotFoundException(
          'Esa unidad no tiene una inspección por aprobar en este ticket',
        );
      if (fila.estado === 'cumplido') {
        throw new ConflictException('La inspección de esa unidad ya está aprobada');
      }
      await this.requisitos.marcar(
        tx,
        { ticketId, codigo: REQ.inspeccionAprobada, vehiculoId },
        'manual_temporal',
        actor.id,
        MOTIVO,
      );
    });
    return this.requisitos.estado(ticketId);
  }
}
