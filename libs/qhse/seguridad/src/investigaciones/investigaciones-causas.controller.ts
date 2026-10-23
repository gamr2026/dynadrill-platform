import { Body, Controller, Param, ParseUUIDPipe, Put } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Permission } from '@dyn/authz';
import { AuthUser, CurrentUser, RequirePermission } from '@dyn/common';
import { TipoCausaInvestigacion } from '../generated/client';
import { InvestigacionesCausasService } from './investigaciones-causas.service';

const P = Permission;

export class PorqueDto {
  @IsString() @MaxLength(1000) pregunta!: string;
  @IsString() @MaxLength(2000) respuesta!: string;
}
export class PorquesDto {
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => PorqueDto)
  porques!: PorqueDto[];
}

export class CausaIshikawaDto {
  @IsUUID() categoriaId!: string;
  @IsString() @MaxLength(1000) descripcion!: string;
}
export class IshikawaDto {
  @IsArray()
  @ArrayMaxSize(60)
  @ValidateNested({ each: true })
  @Type(() => CausaIshikawaDto)
  causas!: CausaIshikawaDto[];
}

export class CausaDto {
  @IsIn(Object.values(TipoCausaInvestigacion)) tipo!: TipoCausaInvestigacion;
  @IsString() @MaxLength(2000) descripcion!: string;
}
export class CausasDto {
  @IsArray()
  @ArrayMaxSize(60)
  @ValidateNested({ each: true })
  @Type(() => CausaDto)
  causas!: CausaDto[];
}

/**
 * Análisis de causas de la investigación. Cada `PUT` reemplaza su lista completa; se edita solo con la investigación abierta o en
 * investigación. Ruta pública `/api/v2/qhse/investigaciones/:id/...`, con `qhse.investigaciones.gestionar`.
 */
@Controller('qhse/investigaciones/:id')
export class InvestigacionesCausasController {
  constructor(private readonly causas: InvestigacionesCausasService) {}

  @RequirePermission(P.INVESTIGACIONES_GESTIONAR)
  @Put('porques')
  porques(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PorquesDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.causas.guardarPorques(id, dto.porques, actor);
  }

  @RequirePermission(P.INVESTIGACIONES_GESTIONAR)
  @Put('ishikawa')
  ishikawa(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: IshikawaDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.causas.guardarIshikawa(id, dto.causas, actor);
  }

  @RequirePermission(P.INVESTIGACIONES_GESTIONAR)
  @Put('causas')
  causasDelFormato(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CausasDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.causas.guardarCausas(id, dto.causas, actor);
  }
}
