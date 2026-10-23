import { Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { Permission } from '@dyn/authz';
import { AuthUser, CurrentUser, RequirePermission } from '@dyn/common';
import { EnviosService } from '../services/envios.service';
import { InvitacionesService } from '../services/invitaciones.service';

const P = Permission;

export class ListarInvitacionesDto {
  @IsOptional() @IsUUID() encuestaId?: string;
  @IsOptional() @IsString() @MaxLength(60) modulo?: string;
  @IsOptional() @IsUUID() referenciaId?: string;
  @IsOptional() @IsIn(['pendiente', 'respondida', 'vencida']) estado?:
    'pendiente' | 'respondida' | 'vencida';
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limite?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) desplazamiento?: number;
}

/**
 * Lo enviado y lo respondido, para la administración (solo Superadmin). Trae el correo del cliente, un dato personal: por eso no se
 * expone a otros roles.
 */
@Controller('encuestas/invitaciones')
export class InvitacionesController {
  constructor(
    private readonly invitaciones: InvitacionesService,
    private readonly envios: EnviosService,
  ) {}

  @RequirePermission(P.ENCUESTAS_GESTIONAR)
  @Get()
  listar(@Query() q: ListarInvitacionesDto) {
    return this.invitaciones.listar({
      encuestaId: q.encuestaId,
      moduloCodigo: q.modulo,
      referenciaId: q.referenciaId,
      estado: q.estado,
      limite: q.limite,
      desplazamiento: q.desplazamiento,
    });
  }

  @RequirePermission(P.ENCUESTAS_GESTIONAR)
  @Get(':id')
  detalle(@Param('id', ParseUUIDPipe) id: string) {
    return this.invitaciones.detalle(id);
  }

  /** Reenvía una encuesta sin responder con un enlace nuevo (vale otro día). */
  @RequirePermission(P.ENCUESTAS_GESTIONAR)
  @Post(':id/reenviar')
  reenviar(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: AuthUser) {
    return this.envios.reenviar(id, actor.id);
  }
}
