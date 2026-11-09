import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';
import { Permission } from '@dyn/authz';
import { AuthUser, CurrentUser, RequirePermission } from '@dyn/common';
import { FasePtw } from '../generated/client';
import { PtwCalendarioService } from './ptw-calendario.service';
import { PtwConsultaService } from './ptw-consulta.service';
import { PtwService } from './ptw.service';

const P = Permission;
export class ListarPtwDto {
  @IsOptional() @IsIn(Object.values(FasePtw)) fase?: FasePtw;
  @IsOptional() @IsUUID() pedidoId?: string;
  @IsOptional() @IsUUID() ticketId?: string;
  @IsOptional() @IsString() @MaxLength(100) q?: string;
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  incluirAnulados?: boolean;
}

export class CalendarioPtwDto {
  /** Primer día (AAAA-MM-DD); por omisión, hoy. */
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) desde?: string;
  /** Último día (AAAA-MM-DD); por omisión, seis días después del primero. */
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) hasta?: string;
}

export class AbrirPtwDto {
  @IsUUID() ticketId!: string;
  /** Día de operación (AAAA-MM-DD). */
  @Matches(/^\d{4}-\d{2}-\d{2}$/) diaOperacion!: string;
}

export class AnularPtwDto {
  @IsString() @MaxLength(500) motivo!: string;
}

/** Permiso de Trabajo (HSE-SITIO-001). Ruta pública `/api/v2/qhse/ptw`. El Supervisor no entra aquí: se entera por los eventos del ticket. */
@Controller('qhse/ptw')
export class PtwController {
  constructor(
    private readonly ptw: PtwService,
    private readonly consulta: PtwConsultaService,
    private readonly calendario: PtwCalendarioService,
  ) {}

  @RequirePermission(P.PTW_VER)
  @Get()
  listar(@Query() q: ListarPtwDto) {
    return this.consulta.listar(q);
  }

  /** Calendario de cobertura: por ticket y día de servicio, el PTW (y su fase), el PT y el ART vigente. Va antes de `:id` para no confundirse con uno. */
  @RequirePermission(P.PTW_VER)
  @Get('calendario')
  cobertura(@Query() q: CalendarioPtwDto) {
    return this.calendario.cobertura(q.desde, q.hasta);
  }

  @RequirePermission(P.PTW_VER)
  @Get(':id')
  detalle(@Param('id', ParseUUIDPipe) id: string) {
    return this.consulta.detalle(id);
  }

  @RequirePermission(P.PTW_GESTIONAR)
  @Post()
  abrir(@Body() dto: AbrirPtwDto, @CurrentUser() actor: AuthUser) {
    return this.ptw.abrir(dto, actor);
  }

  @RequirePermission(P.PTW_GESTIONAR)
  @Post(':id/validar-documentos')
  validarDocumentos(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: AuthUser) {
    return this.ptw.validarDocumentos(id, actor);
  }

  @RequirePermission(P.PTW_APROBAR)
  @Post(':id/aprobar')
  aprobar(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: AuthUser) {
    return this.ptw.aprobar(id, actor);
  }

  @RequirePermission(P.PTW_APROBAR)
  @Post(':id/anular')
  anular(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AnularPtwDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.ptw.anular(id, dto.motivo, actor);
  }

  /** Devuelve su validez a un PTW anulado (con su motivo). Lo hace quien puede anular. */
  @RequirePermission(P.PTW_APROBAR)
  @Post(':id/reintegrar')
  reintegrar(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AnularPtwDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.ptw.reintegrar(id, dto.motivo, actor);
  }
}
