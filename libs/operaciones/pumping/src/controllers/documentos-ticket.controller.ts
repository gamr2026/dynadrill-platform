import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { IsUUID, Matches } from 'class-validator';
import { Permission } from '@dyn/authz';
import { AuthUser, CurrentUser, RequirePermission } from '@dyn/common';
import { DocumentosTicketService } from '../services/documentos-ticket.service';

const P = Permission;

export class AdjuntarMonitoreoDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'La fecha debe ser yyyy-MM-dd' }) fecha!: string;
  /** Archivo ya subido a `archivos` con el módulo `ticket_monitoreo_documento`. */
  @IsUUID() archivoId!: string;
}

/** Documentos de un ticket de Pumping (mezcla de químicos y monitoreo por día). */
@Controller('operaciones/pumping/tickets/:id/documentos')
export class DocumentosTicketController {
  constructor(private readonly documentos: DocumentosTicketService) {}

  @RequirePermission(P.PUMPING_OPERAR)
  @Get()
  listar(@Param('id', ParseUUIDPipe) id: string) {
    return this.documentos.listar(id);
  }

  /** El Operador del equipo adjunta el monitoreo de un día. */
  @RequirePermission(P.PUMPING_OPERAR)
  @Post('monitoreo')
  adjuntarMonitoreo(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AdjuntarMonitoreoDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.documentos.adjuntarMonitoreo(id, dto.fecha, dto.archivoId, actor);
  }
}
