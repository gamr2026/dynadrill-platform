import { Body, Controller, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';
import { Permission } from '@dyn/authz';
import { AuthUser, CurrentUser, RequirePermission } from '@dyn/common';
import { NivelControlAccion, TipoAccionInvestigacion } from '../generated/client';
import { InvestigacionesAccionesService } from './investigaciones-acciones.service';

const P = Permission;
const FECHA = /^\d{4}-\d{2}-\d{2}$/;

export class RegistrarAccionDto {
  @IsString() @MaxLength(2000) descripcion!: string;
  @IsIn(Object.values(TipoAccionInvestigacion)) tipo!: TipoAccionInvestigacion;
  @IsUUID() responsableId!: string;
  @Matches(FECHA) plazo!: string;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(4)
  @IsIn(Object.values(NivelControlAccion), { each: true })
  controles?: NivelControlAccion[];
}

export class EditarAccionDto {
  @IsOptional() @IsString() @MaxLength(2000) descripcion?: string;
  @IsOptional() @IsIn(Object.values(TipoAccionInvestigacion)) tipo?: TipoAccionInvestigacion;
  @IsOptional() @IsUUID() responsableId?: string;
  @IsOptional() @Matches(FECHA) plazo?: string;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(4)
  @IsIn(Object.values(NivelControlAccion), { each: true })
  controles?: NivelControlAccion[];
}

export class ImplementarAccionDto {
  @IsOptional() @IsString() @MaxLength(1000) observacion?: string;
}

export class VerificarAccionDto {
  @IsBoolean() fueEficaz!: boolean;
  @IsOptional() @IsString() @MaxLength(1000) observacion?: string;
}

export class CancelarAccionDto {
  @IsString() @MaxLength(1000) motivo!: string;
}

/**
 * Acciones correctivas y preventivas de una investigación. Ruta pública `/api/v2/qhse/investigaciones/:id/acciones`, con
 * `qhse.investigaciones.gestionar`. Registrar y editar: con la investigación en curso; implementar, verificar y cancelar: también después del cierre.
 */
@Controller('qhse/investigaciones/:id/acciones')
export class InvestigacionesAccionesController {
  constructor(private readonly acciones: InvestigacionesAccionesService) {}

  @RequirePermission(P.INVESTIGACIONES_GESTIONAR)
  @Post()
  registrar(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RegistrarAccionDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.acciones.registrar(id, dto, actor);
  }

  @RequirePermission(P.INVESTIGACIONES_GESTIONAR)
  @Patch(':accionId')
  editar(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('accionId', ParseUUIDPipe) accionId: string,
    @Body() dto: EditarAccionDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.acciones.editar(id, accionId, dto, actor);
  }

  @RequirePermission(P.INVESTIGACIONES_GESTIONAR)
  @Post(':accionId/implementar')
  implementar(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('accionId', ParseUUIDPipe) accionId: string,
    @Body() dto: ImplementarAccionDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.acciones.implementar(id, accionId, dto.observacion, actor);
  }

  @RequirePermission(P.INVESTIGACIONES_GESTIONAR)
  @Post(':accionId/verificar')
  verificar(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('accionId', ParseUUIDPipe) accionId: string,
    @Body() dto: VerificarAccionDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.acciones.verificar(id, accionId, dto, actor);
  }

  @RequirePermission(P.INVESTIGACIONES_GESTIONAR)
  @Post(':accionId/cancelar')
  cancelar(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('accionId', ParseUUIDPipe) accionId: string,
    @Body() dto: CancelarAccionDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.acciones.cancelar(id, accionId, dto.motivo, actor);
  }
}
