import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';
import { Permission } from '@dyn/authz';
import { AuthUser, CurrentUser, RequirePermission } from '@dyn/common';
import { FasePtw, TipoFirmaPtw } from '../generated/client';
import { PtwConsultaService } from './ptw-consulta.service';
import { PtwService } from './ptw.service';

const P = Permission;
/** Las confirmaciones de la formalización; la aprobación tiene su propia ruta y permiso. */
const CONFIRMACIONES = Object.values(TipoFirmaPtw).filter((t) => t !== TipoFirmaPtw.aprobacion);

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

export class AbrirPtwDto {
  @IsUUID() ticketId!: string;
  /** Día de operación (AAAA-MM-DD). */
  @Matches(/^\d{4}-\d{2}-\d{2}$/) diaOperacion!: string;
}

export class ConfirmarPtwDto {
  @IsIn(CONFIRMACIONES) tipo!: TipoFirmaPtw;
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
  ) {}

  @RequirePermission(P.PTW_VER)
  @Get()
  listar(@Query() q: ListarPtwDto) {
    return this.consulta.listar(q);
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

  @RequirePermission(P.PTW_GESTIONAR)
  @Post(':id/confirmaciones')
  confirmar(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ConfirmarPtwDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.ptw.confirmar(id, dto.tipo, actor);
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
}
