import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Permission } from '@dyn/authz';
import { AuthUser, CurrentUser, RequirePermission } from '@dyn/common';
import { EstadoEpi } from '../generated/client';
import { EpiService } from './epi.service';

const P = Permission;
const ESTADOS = Object.values(EstadoEpi);

export class ListarEntregasDto {
  @IsOptional() @IsIn(ESTADOS) estado?: EstadoEpi;
  @IsOptional() @IsUUID() ticketId?: string;
  @IsOptional() @IsUUID() trabajadorId?: string;
  @IsOptional() @IsString() @MaxLength(100) q?: string;
}

export class RenglonDto {
  @IsUUID() elementoId!: string;
  @IsInt() @Min(1) @Max(1000) cantidad!: number;
  @IsOptional() @IsString() @MaxLength(30) talla?: string;
  @IsOptional() @IsString() @MaxLength(60) codigo?: string;
  @IsBoolean() recibioCapacitacion!: boolean;
  @IsOptional() @IsString() @MaxLength(500) observaciones?: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) entregadoEl?: string;
}

export class CrearEntregaDto {
  /** Cuenta del trabajador que recibe el EPI. */
  @IsUUID() trabajadorId!: string;
  /** Ticket que origina la entrega (debe ser uno que QHSE ya conoce); sin ticket para entregas sueltas. */
  @IsOptional() @IsUUID() ticketId?: string;
  @IsOptional() @IsString() @MaxLength(200) lugar?: string;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(60)
  @ValidateNested({ each: true })
  @Type(() => RenglonDto)
  renglones?: RenglonDto[];
}

export class GuardarContenidoDto {
  @IsOptional() @IsString() @MaxLength(200) lugar?: string;
  @IsArray()
  @ArrayMaxSize(60)
  @ValidateNested({ each: true })
  @Type(() => RenglonDto)
  renglones!: RenglonDto[];
}

export class MotivoDto {
  @IsString() @MaxLength(500) motivo!: string;
}

/**
 * Entrega de EPI (DYN-SGI-RE-032). Ruta pública `/api/v2/qhse/epi` (el gateway la reescribe a `/api/qhse/epi`). El Supervisor no
 * entra aquí: lo que él necesita de la entrega lo ve en los requisitos del ticket de Pumping.
 */
@Controller('qhse/epi')
export class EpiController {
  constructor(private readonly epi: EpiService) {}

  @RequirePermission(P.EPI_VER)
  @Get('elementos')
  elementos() {
    return this.epi.elementos();
  }

  @RequirePermission(P.EPI_VER)
  @Get()
  listar(@Query() q: ListarEntregasDto) {
    return this.epi.listar(q);
  }

  @RequirePermission(P.EPI_VER)
  @Get(':id')
  detalle(@Param('id', ParseUUIDPipe) id: string) {
    return this.epi.detalle(id);
  }

  @RequirePermission(P.EPI_CREAR)
  @Post()
  crear(@Body() dto: CrearEntregaDto, @CurrentUser() actor: AuthUser) {
    return this.epi.crear(dto, actor);
  }

  @RequirePermission(P.EPI_CREAR)
  @Put(':id/contenido')
  guardarContenido(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: GuardarContenidoDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.epi.guardarContenido(id, dto, actor);
  }

  @RequirePermission(P.EPI_APROBAR)
  @Post(':id/aprobar')
  aprobar(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: AuthUser) {
    return this.epi.aprobar(id, actor);
  }

  @RequirePermission(P.EPI_APROBAR)
  @Post(':id/rechazar')
  rechazar(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MotivoDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.epi.rechazar(id, dto.motivo, actor);
  }

  @RequirePermission(P.EPI_DESPACHAR)
  @Post(':id/despachar')
  despachar(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: AuthUser) {
    return this.epi.despachar(id, actor);
  }

  @RequirePermission(P.EPI_DESPACHAR)
  @Post(':id/revertir')
  revertir(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MotivoDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.epi.revertir(id, dto.motivo, actor);
  }

  @RequirePermission(P.EPI_DESPACHAR)
  @Post(':id/firma-trabajador')
  firmaTrabajador(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: AuthUser) {
    return this.epi.firmarTrabajador(id, actor);
  }

  @RequirePermission(P.EPI_DESPACHAR)
  @Post(':id/firma-talento-humano')
  firmaTalentoHumano(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: AuthUser) {
    return this.epi.firmarTalentoHumano(id, actor);
  }
}
