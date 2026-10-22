import { Body, Controller, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsBoolean, IsDate, IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { Permission } from '@dyn/authz';
import { AuthUser, CurrentUser, RequirePermission } from '@dyn/common';
import { ConclusionInvestigacion } from '../generated/client';
import { InvestigacionesCierreService } from './investigaciones-cierre.service';

const P = Permission;

export class ConclusionDto {
  @IsOptional() @IsIn(Object.values(ConclusionInvestigacion)) conclusion?: ConclusionInvestigacion;
  @IsOptional() @IsString() @MaxLength(4000) leccionesAprendidas?: string;
  @IsOptional() @IsUUID() ipercActividadId?: string;
}

export class NotificacionLegalDto {
  @IsBoolean() requerida!: boolean;
  @IsOptional() @Type(() => Date) @IsDate() ministerioTrabajoNotificadoAt?: Date;
  @IsOptional() @Type(() => Date) @IsDate() iessNotificadoAt?: Date;
}

export class DevolverDto {
  @IsString() @MaxLength(1000) observacion!: string;
}

/**
 * Conclusión, notificación legal, revisión y cierre. Ruta pública `/api/v2/qhse/investigaciones/:id/...`. Conclusión, notificación y envío a revisión:
 * `qhse.investigaciones.gestionar`; devolver y cerrar (aprobar el informe): `qhse.investigaciones.aprobar` (solo el Gerente HSE).
 */
@Controller('qhse/investigaciones/:id')
export class InvestigacionesCierreController {
  constructor(private readonly cierre: InvestigacionesCierreService) {}

  @RequirePermission(P.INVESTIGACIONES_GESTIONAR)
  @Put('conclusion')
  conclusion(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ConclusionDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.cierre.guardarConclusion(id, dto, actor);
  }

  @RequirePermission(P.INVESTIGACIONES_GESTIONAR)
  @Put('notificacion-legal')
  notificacionLegal(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: NotificacionLegalDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.cierre.guardarNotificacionLegal(id, dto, actor);
  }

  @RequirePermission(P.INVESTIGACIONES_GESTIONAR)
  @Post('enviar-revision')
  enviarARevision(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: AuthUser) {
    return this.cierre.enviarARevision(id, actor);
  }

  @RequirePermission(P.INVESTIGACIONES_APROBAR)
  @Post('devolver')
  devolver(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DevolverDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.cierre.devolver(id, dto.observacion, actor);
  }

  @RequirePermission(P.INVESTIGACIONES_APROBAR)
  @Post('cerrar')
  cerrar(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: AuthUser) {
    return this.cierre.cerrar(id, actor);
  }
}
