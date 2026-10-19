import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { IsIn, IsUUID } from 'class-validator';
import { Permission } from '@dyn/authz';
import { AuthUser, CurrentUser, RequirePermission } from '@dyn/common';
import type { CampoDocumentoFcr } from '../generated/client';
import { DocumentosService } from '../services/documentos.service';

const P = Permission;

export class AdjuntarDocumentoDto {
  @IsIn([
    'formulario_inspeccion_externo',
    'formato_dimensionamiento_servicio',
    'formato_dureza_servicio',
    'documento_inspeccion',
    'registro_dureza',
    'registro_qaqc',
  ])
  campo!: CampoDocumentoFcr;
  /** Archivo ya subido a `archivos` con el módulo `ticket_fcr_documento`. */
  @IsUUID() archivoId!: string;
}

/** Documentos de un ticket de FCR (los seis campos de SERVICIOS y del tronco). */
@Controller('operaciones/fcr/tickets/:id/documentos')
export class DocumentosController {
  constructor(private readonly documentos: DocumentosService) {}

  @RequirePermission(P.FCR_OPERAR)
  @Get()
  listar(@Param('id', ParseUUIDPipe) id: string) {
    return this.documentos.listar(id);
  }

  @RequirePermission(P.FCR_OPERAR)
  @Post()
  adjuntar(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AdjuntarDocumentoDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.documentos.adjuntar(id, dto.campo, dto.archivoId, actor);
  }
}
