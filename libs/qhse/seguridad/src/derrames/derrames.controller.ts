import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { Permission } from '@dyn/authz';
import { AuthUser, CurrentUser, RequirePermission } from '@dyn/common';
import { DerramesConsultaService } from './derrames-consulta.service';
import { DerramesService } from './derrames.service';

const P = Permission;

export class ListarDerramesDto {
  @IsOptional() @IsIn(['activo', 'contenido', 'cerrado']) estado?:
    'activo' | 'contenido' | 'cerrado';
  @IsOptional() @IsUUID() ticketId?: string;
  @IsOptional() @IsString() @MaxLength(100) q?: string;
}

export class ActivarDerrameDto {
  @IsUUID() ubicacionId!: string;
  @IsUUID() bandaId!: string;
  @IsString() @MaxLength(2000) descripcion!: string;
  @IsOptional() @IsString() @MaxLength(300) ubicacionFisica?: string;
  @IsOptional() @IsUUID() ticketId?: string;
}

/**
 * Derrames. Ruta pública `/api/v2/qhse/derrames`. Activar la alerta es de cualquier usuario autenticado (`qhse.eventos.reportar`);
 * verlos y gestionarlos es del equipo HSE.
 */
@Controller('qhse/derrames')
export class DerramesController {
  constructor(
    private readonly derrames: DerramesService,
    private readonly consulta: DerramesConsultaService,
  ) {}

  /** Catálogos del formulario de alerta (lo usa quien reporta, aunque no vea la bandeja). */
  @RequirePermission(P.QHSE_REPORTAR)
  @Get('catalogos')
  catalogos() {
    return this.consulta.catalogos();
  }

  @RequirePermission(P.QHSE_REPORTAR)
  @Post()
  activar(@Body() dto: ActivarDerrameDto, @CurrentUser() actor: AuthUser) {
    return this.derrames.activar(dto, actor);
  }

  @RequirePermission(P.DERRAMES_VER)
  @Get()
  listar(@Query() q: ListarDerramesDto) {
    return this.consulta.listar(q);
  }

  @RequirePermission(P.DERRAMES_VER)
  @Get(':id')
  detalle(@Param('id', ParseUUIDPipe) id: string) {
    return this.consulta.detalle(id);
  }
}
