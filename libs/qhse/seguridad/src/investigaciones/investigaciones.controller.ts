import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsDate, IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { Permission } from '@dyn/authz';
import { AuthUser, CurrentUser, RequirePermission } from '@dyn/common';
import { EstadoInvestigacion } from '../generated/client';
import { InvestigacionesConsultaService } from './investigaciones-consulta.service';
import { InvestigacionesService } from './investigaciones.service';

const P = Permission;

export class AbrirInvestigacionDto {
  @IsUUID() resultadoId!: string;
  @IsString() @MaxLength(4000) descripcionEvento!: string;
  @Type(() => Date) @IsDate() fechaIncidente!: Date;
  @IsString() @MaxLength(500) ubicacion!: string;
  @IsOptional() @IsUUID() origenEmergenciaId?: string;
}

export class IniciarInvestigacionDto {
  @IsUUID() liderId!: string;
  @IsOptional() @Type(() => Date) @IsDate() escenaAseguradaAt?: Date;
}

export class ListarInvestigacionesDto {
  @IsOptional() @IsIn(Object.values(EstadoInvestigacion)) estado?: EstadoInvestigacion;
  @IsOptional() @IsString() @MaxLength(50) resultado?: string;
  @IsOptional() @IsString() @MaxLength(100) q?: string;
}

/**
 * Investigación de incidentes. Ruta pública `/api/v2/qhse/investigaciones`. Verlas es del equipo HSE (`qhse.investigaciones.ver`); abrirlas e
 * iniciarlas, de quien las gestiona (`qhse.investigaciones.gestionar`). El Supervisor no entra.
 */
@Controller('qhse/investigaciones')
export class InvestigacionesController {
  constructor(
    private readonly investigaciones: InvestigacionesService,
    private readonly consulta: InvestigacionesConsultaService,
  ) {}

  @RequirePermission(P.INVESTIGACIONES_VER)
  @Get('resultados')
  resultados() {
    return this.consulta.resultados();
  }

  @RequirePermission(P.INVESTIGACIONES_VER)
  @Get()
  listar(@Query() q: ListarInvestigacionesDto) {
    return this.consulta.listar(q);
  }

  @RequirePermission(P.INVESTIGACIONES_VER)
  @Get(':id')
  detalle(@Param('id', ParseUUIDPipe) id: string) {
    return this.consulta.detalle(id);
  }

  @RequirePermission(P.INVESTIGACIONES_GESTIONAR)
  @Post()
  abrir(@Body() dto: AbrirInvestigacionDto, @CurrentUser() actor: AuthUser) {
    return this.investigaciones.abrir(dto, actor);
  }

  @RequirePermission(P.INVESTIGACIONES_GESTIONAR)
  @Post(':id/iniciar')
  iniciar(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: IniciarInvestigacionDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.investigaciones.iniciar(id, dto, actor);
  }
}
