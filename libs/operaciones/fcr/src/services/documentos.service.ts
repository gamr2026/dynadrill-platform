import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AuthUser } from '@dyn/common';
import { uuidv7 } from '@dyn/utils';
import { REQ } from '../catalog/sembrar-pasos';
import type { CampoDocumentoFcr } from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';
import { RequisitosService } from './requisitos.service';
import { esDelEquipo, ROL_SUPERVISOR, TicketsService } from './tickets.service';

/** Quién adjunta cada campo y en qué paso: los de SERVICIOS, el operador que inspecciona; los del tronco, el Supervisor del ticket. */
const REGLAS: Record<CampoDocumentoFcr, { paso: string; quien: 'inspector' | 'supervisor' }> = {
  formulario_inspeccion_externo: { paso: 'inspeccion', quien: 'inspector' },
  formato_dimensionamiento_servicio: { paso: 'inspeccion', quien: 'inspector' },
  formato_dureza_servicio: { paso: 'inspeccion', quien: 'inspector' },
  documento_inspeccion: { paso: 'preparacion_herramientas', quien: 'supervisor' },
  registro_dureza: { paso: 'preparacion_herramientas', quien: 'supervisor' },
  registro_qaqc: { paso: 'preparacion_herramientas', quien: 'supervisor' },
};

/**
 * Documentos del ticket (los seis campos de la demo). El archivo se sube a `archivos` con el módulo `ticket_fcr_documento` y aquí solo se
 * enlaza (la base comprueba que lo subió ese módulo y que no fue eliminado). Son historia: subir otro del mismo campo lo reemplaza como vigente.
 * Solo el formulario de inspección externo bloquea un paso; los demás son adjuntos (consultas F-8 y F-9).
 */
@Injectable()
export class DocumentosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tickets: TicketsService,
    private readonly requisitos: RequisitosService,
  ) {}

  async listar(ticketId: string) {
    if (!(await this.prisma.ticket.findUnique({ where: { id: ticketId }, select: { id: true } })))
      throw new NotFoundException('El ticket no existe');
    const filas = await this.prisma.ticketDocumento.findMany({
      where: { ticketId },
      include: { autor: { select: { nombre: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return filas.map((d) => ({
      id: d.id,
      campo: d.campo,
      archivoId: d.archivoId,
      subidoPor: d.autor.nombre,
      createdAt: d.createdAt,
    }));
  }

  async adjuntar(ticketId: string, campo: CampoDocumentoFcr, archivoId: string, actor: AuthUser) {
    const regla = REGLAS[campo];
    await this.prisma.$transaction(async (tx) => {
      const t = await this.tickets.cargarEnTx(tx, ticketId);
      if (t.pasoCodigo !== regla.paso) {
        throw new ConflictException(`Este documento se adjunta en el paso «${regla.paso}»`);
      }
      if (campo.endsWith('_servicio') || campo === 'formulario_inspeccion_externo') {
        if (t.tipoOt !== 'servicio')
          throw new ConflictException('Este documento es solo de los tickets de servicios');
      }
      if (actor.roleCode !== 'superadmin') {
        const ok =
          regla.quien === 'inspector'
            ? t.inspectorId === actor.id
            : actor.roleCode === ROL_SUPERVISOR && esDelEquipo(t, actor.id);
        if (!ok) throw new ForbiddenException('No le corresponde adjuntar este documento');
      }
      try {
        await tx.ticketDocumento.create({
          data: { id: uuidv7(), ticketId, campo, archivoId, createdBy: actor.id },
        });
      } catch (e) {
        // la base comprueba que el archivo lo subió el módulo de documentos de FCR
        if (String(e).includes('no es un documento de FCR')) {
          throw new BadRequestException(
            'El archivo no existe, fue eliminado o no es un documento de FCR',
          );
        }
        throw e;
      }
      if (campo === 'formulario_inspeccion_externo') {
        await this.requisitos.marcar(
          tx,
          { ticketId, codigo: REQ.formularioInspeccionExterno },
          'sistema',
          actor.id,
        );
      }
    });
    return this.listar(ticketId);
  }
}
