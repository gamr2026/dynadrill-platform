import { Controller, Get, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { RoleCode } from '@dyn/authz';
import { AnyAuthenticated, AuthUser, CurrentUser, Roles } from '@dyn/common';
import { DiagnosticoService } from './diagnostico.service';

/** Endpoints de prueba de F0. Solo existen si `DIAGNOSTICO_ENABLED=true`. */
@Controller('plataforma/diagnostico')
export class DiagnosticoController {
  constructor(private readonly service: DiagnosticoService) {}

  @AnyAuthenticated()
  @Get('ping')
  ping(@CurrentUser() user: AuthUser, @Req() req: Request & { id?: string }) {
    return { service: 'plataforma', userId: user.id, role: user.roleCode, requestId: req.id };
  }

  @Roles(RoleCode.SUPERADMIN)
  @Post('evento')
  emitir(@CurrentUser() user: AuthUser, @Req() req: Request & { id?: string }) {
    return this.service.emitir({ userId: user.id, role: user.roleCode }, req.id);
  }

  @Roles(RoleCode.SUPERADMIN)
  @Get('evento/:id')
  estado(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.estado(id);
  }
}
