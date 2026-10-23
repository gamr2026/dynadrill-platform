import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { Permission } from '@dyn/authz';
import { AuthUser, CurrentUser, RequirePermission } from '@dyn/common';
import { ObservacionesService } from '../services/observaciones.service';

const P = Permission;

export class AgregarObservacionDto {
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1, { message: 'Escriba la observación' })
  @MaxLength(2000)
  mensaje!: string;
}

/** Observaciones del ticket: las ve y las agrega quien opera FCR (el detalle del ticket tiene el mismo permiso). */
@Controller('operaciones/fcr/tickets/:id/observaciones')
export class ObservacionesController {
  constructor(private readonly observaciones: ObservacionesService) {}

  @RequirePermission(P.FCR_OPERAR)
  @Get()
  listar(@Param('id', ParseUUIDPipe) id: string) {
    return this.observaciones.listar(id);
  }

  @RequirePermission(P.FCR_OPERAR)
  @Post()
  agregar(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AgregarObservacionDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.observaciones.agregar(id, dto.mensaje, actor);
  }
}
