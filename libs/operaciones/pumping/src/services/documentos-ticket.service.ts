import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AuthUser } from '@dyn/common';
import { uuidv7 } from '@dyn/utils';
import { PrismaService } from '../prisma/prisma.service';
import { puedeActuar, puedeActuarEn } from './tickets.service';

const PASO = 'ejecucion_operativa';
const FECHA = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Documentos de un ticket de Pumping. Hoy: el documento de mezcla de químicos (lo adjunta la asignación) y el monitoreo de cada día de
 * operación, que el Operador del equipo sube en la Ejecución operativa. El archivo vive en `archivos`; aquí solo se enlaza.
 * Los documentos son historia (no se cambian ni se borran): subir otro del mismo día lo reemplaza como vigente.
 */
@Injectable()
export class DocumentosTicketService {
  constructor(private readonly prisma: PrismaService) {}

  async listar(ticketId: string) {
    const t = await this.prisma.ticket.findUnique({
      where: { id: ticketId },
      select: { id: true },
    });
    if (!t) throw new NotFoundException('El ticket no existe');
    const filas = await this.prisma.ticketDocumento.findMany({
      where: { ticketId },
      orderBy: { createdAt: 'asc' },
    });
    return filas.map((d) => ({
      id: d.id,
      tipo: d.tipo,
      fecha: d.fecha ? d.fecha.toISOString().slice(0, 10) : null,
      archivoId: d.archivoId,
      createdAt: d.createdAt,
    }));
  }

  /** El Operador del equipo adjunta el monitoreo de un día (Ejecución operativa). */
  async adjuntarMonitoreo(ticketId: string, fecha: string, archivoId: string, actor: AuthUser) {
    // el formato y que el día exista (el 31 de febrero no): se recompone la fecha y debe salir igual
    const d = new Date(`${fecha}T00:00:00.000Z`);
    if (!FECHA.test(fecha) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== fecha) {
      throw new BadRequestException('La fecha del monitoreo no es válida');
    }
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
        throw new ConflictException('El monitoreo se adjunta en la Ejecución operativa');
      }
      if (!puedeActuar(t.paso.roles, actor.roleCode)) {
        throw new ForbiddenException(`El paso "${t.paso.nombre}" lo atiende otro rol`);
      }
      if (!puedeActuarEn(t, actor)) {
        throw new ForbiddenException('Solo el equipo asignado a este ticket puede hacerlo');
      }
      if (!(await tx.archivoRef.findUnique({ where: { id: archivoId } }))) {
        throw new BadRequestException('El archivo del monitoreo no existe');
      }
      await tx.ticketDocumento.create({
        data: {
          id: uuidv7(),
          ticketId,
          tipo: 'monitoreo',
          fecha: new Date(`${fecha}T00:00:00.000Z`),
          archivoId,
          createdBy: actor.id,
        },
      });
    });
    return this.listar(ticketId);
  }
}
