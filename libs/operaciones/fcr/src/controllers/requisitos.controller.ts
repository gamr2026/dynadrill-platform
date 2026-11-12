import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { Permission } from '@dyn/authz';
import { AuthUser, CurrentUser, RequirePermission } from '@dyn/common';
import { ExoneracionesService } from '../services/exoneraciones.service';

const P = Permission;

const recortar = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class ExonerarRequisitoDto {
  @Transform(recortar)
  @IsString()
  @MinLength(1, { message: 'Escriba el motivo de la exoneración' })
  @MaxLength(500)
  motivo!: string;
}

export class RevertirExoneracionDto {
  @IsOptional() @Transform(recortar) @IsString() @MaxLength(500) motivo?: string;
}

/**
 * Exoneración de requisitos del ticket y su historia. Exonerar y revertir exigen `fcr.requisitos.exonerar` (por omisión el Supervisor, el Supervisor de Operaciones FCR y
 * quienes coordinan: Superadmin, Jefe de Base); el servicio mantiene además su comprobación por el rol de la cuenta.
 */
@Controller('operaciones/fcr/tickets/:id/requisitos')
export class RequisitosController {
  constructor(private readonly exoneraciones: ExoneracionesService) {}

  @RequirePermission(P.FCR_REQUISITOS_EXONERAR)
  @Post(':requisitoId/exonerar')
  exonerar(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('requisitoId', ParseUUIDPipe) requisitoId: string,
    @Body() dto: ExonerarRequisitoDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.exoneraciones.exonerar(id, requisitoId, dto.motivo, actor);
  }

  @RequirePermission(P.FCR_REQUISITOS_EXONERAR)
  @Post(':requisitoId/revertir-exoneracion')
  revertir(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('requisitoId', ParseUUIDPipe) requisitoId: string,
    @Body() dto: RevertirExoneracionDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.exoneraciones.revertir(id, requisitoId, dto.motivo, actor);
  }

  @RequirePermission(P.FCR_OPERAR)
  @Get(':requisitoId/historial')
  historial(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('requisitoId', ParseUUIDPipe) requisitoId: string,
  ) {
    return this.exoneraciones.historial(id, requisitoId);
  }
}
