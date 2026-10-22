import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { Permission } from '@dyn/authz';
import { RequirePermission } from '@dyn/common';
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
  constructor(private readonly invitaciones: InvitacionesService) {}

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
}
