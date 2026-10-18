import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';
import { Permission } from '@dyn/authz';
import { AuthUser, CurrentUser, RequirePermission } from '@dyn/common';
import { TipoDocumentoPedido } from '../generated/client';
import { DocumentosEstadoService } from './documentos-estado.service';
import { DocumentosPedidoService } from './documentos-pedido.service';

const P = Permission;
/** El Acta de Entrega no se carga por aquí: tiene su propia ruta, ligada al ticket. */
const TIPOS_GENERALES = Object.values(TipoDocumentoPedido).filter(
  (t) => t !== TipoDocumentoPedido.formato_entrega,
);

export class ListarDocumentosDto {
  @IsOptional() @IsUUID() pedidoId?: string;
  @IsOptional() @IsUUID() ticketId?: string;
  @IsOptional() @IsIn(Object.values(TipoDocumentoPedido)) tipo?: TipoDocumentoPedido;
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  incluirAnulados?: boolean;
}

export class CargarDocumentoDto {
  @IsUUID() pedidoId!: string;
  @IsOptional() @IsUUID() ticketId?: string;
  @IsIn(TIPOS_GENERALES) tipo!: TipoDocumentoPedido;
  /** Archivo subido antes a `/api/archivos` con el módulo `qhse_documento_pedido`. */
  @IsUUID() archivoId!: string;
  @IsOptional() @IsString() @MaxLength(100) referencia?: string;
  /** ART: emisión (vale 15 días). PT: día de operación. */
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) fecha?: string;
}

export class CargarActaDto {
  /** Archivo subido antes a `/api/archivos` con el módulo `qhse_acta_entrega`. */
  @IsUUID() archivoId!: string;
  @IsOptional() @IsString() @MaxLength(100) referencia?: string;
  /** Obligatorio si quien sube no es el supervisor asignado al ticket: por qué el asignado no pudo. */
  @IsOptional() @IsString() @MaxLength(500) motivoSuplencia?: string;
}

export class AnularDto {
  @IsString() @MaxLength(500) motivo!: string;
}

/**
 * Documentos por pedido y Acta de Entrega de Locación (contrato 4.11). Ruta pública `/api/v2/qhse/...`. El Supervisor entra solo a
 * las dos rutas del Acta (permisos `qhse.acta_entrega.*`); el resto es del equipo HSE.
 */
@Controller('qhse')
export class DocumentosController {
  constructor(
    private readonly documentos: DocumentosPedidoService,
    private readonly estado: DocumentosEstadoService,
  ) {}

  /** Bandeja: qué tiene y qué le falta a cada pedido (formato de recepción, SFI, ART, PT de hoy y Acta). */
  @RequirePermission(P.DOCUMENTOS_VER)
  @Get('documentos/pedidos')
  pedidos(@Query('q') q?: string) {
    return this.estado.pedidos({ q });
  }

  @RequirePermission(P.DOCUMENTOS_VER)
  @Get('documentos')
  listar(@Query() q: ListarDocumentosDto) {
    return this.documentos.listar(q);
  }

  @RequirePermission(P.DOCUMENTOS_GESTIONAR)
  @Post('documentos')
  cargar(@Body() dto: CargarDocumentoDto, @CurrentUser() actor: AuthUser) {
    return this.documentos.cargar(dto, actor);
  }

  @RequirePermission(P.DOCUMENTOS_GESTIONAR)
  @Post('documentos/:id/anular')
  anular(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AnularDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.documentos.anular(id, dto.motivo, actor);
  }

  /** El Acta vigente del ticket (y las anuladas) y el supervisor asignado. */
  @RequirePermission(P.ACTA_ENTREGA_VER)
  @Get('tickets/:ticketId/acta-entrega')
  acta(@Param('ticketId', ParseUUIDPipe) ticketId: string) {
    return this.documentos.actaDelTicket(ticketId);
  }

  @RequirePermission(P.ACTA_ENTREGA_CARGAR)
  @Post('tickets/:ticketId/acta-entrega')
  cargarActa(
    @Param('ticketId', ParseUUIDPipe) ticketId: string,
    @Body() dto: CargarActaDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.documentos.cargarActa(ticketId, dto, actor);
  }
}
