import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { Permission } from '@dyn/authz';
import { AuthUser, CurrentUser, RequirePermission } from '@dyn/common';
import { RequisitosService } from '../services/requisitos.service';
import { TicketNoAnuladoGuard } from '../guards/ticket-no-anulado.guard';

const P = Permission;

export class ExonerarRequisitoDto {
  @IsString() @MinLength(3) @MaxLength(500) motivo!: string;
}

export class RevertirExoneracionDto {
  @IsOptional() @IsString() @MaxLength(500) motivo?: string;
}

/** Exoneración e historia de los requisitos de un ticket de Pumping. */
@UseGuards(TicketNoAnuladoGuard)
@Controller('operaciones/pumping')
export class RequisitosController {
  constructor(private readonly requisitos: RequisitosService) {}

  /** Exonera un requisito pendiente (motivo obligatorio): deja de bloquear. Lo hacen quienes pueden reabrir jornadas (Jefe de Base, Supervisor, administración). */
  @RequirePermission(P.PUMPING_JORNADA_REABRIR)
  @Post('tickets/:id/requisitos/:requisitoId/exonerar')
  exonerar(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('requisitoId', ParseUUIDPipe) requisitoId: string,
    @Body() dto: ExonerarRequisitoDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.requisitos.exonerar(id, requisitoId, dto.motivo, actor);
  }

  /** Revierte una exoneración: el requisito vuelve a pendiente. */
  @RequirePermission(P.PUMPING_JORNADA_REABRIR)
  @Post('tickets/:id/requisitos/:requisitoId/revertir-exoneracion')
  revertir(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('requisitoId', ParseUUIDPipe) requisitoId: string,
    @Body() dto: RevertirExoneracionDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.requisitos.revertirExoneracion(id, requisitoId, dto.motivo, actor);
  }

  /** Historia de un requisito: cada cambio de estado o de vencimiento, con su origen y quién lo hizo. */
  @RequirePermission(P.PUMPING_OPERAR, P.PUMPING_VER)
  @Get('tickets/:id/requisitos/:requisitoId/historial')
  historial(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('requisitoId', ParseUUIDPipe) requisitoId: string,
  ) {
    return this.requisitos.historial(id, requisitoId);
  }
}
