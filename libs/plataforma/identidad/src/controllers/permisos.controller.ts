import { Body, Controller, Get, Param, ParseUUIDPipe, Put, Query } from '@nestjs/common';
import { Permission } from '@dyn/authz';
import { AuthUser, CurrentUser, RequirePermission } from '@dyn/common';
import { HistorialQueryDto, ReemplazarPermisosDto } from '../dto/permisos.dto';
import { PermisosService } from '../services/permisos.service';

/** Catálogo de permisos del sistema. Lo ve quien tiene `identidad.roles.ver`. */
@Controller('permissions')
export class PermissionsController {
  constructor(private readonly permisos: PermisosService) {}

  @RequirePermission(Permission.ROLES_VER)
  @Get()
  catalogo() {
    return this.permisos.catalogo();
  }
}

/**
 * Permisos de cada rol (RBAC editable). Ver es un permiso y editar es otro: se puede dar acceso de solo
 * lectura a la pantalla de roles. El resto de las rutas de `/roles` están en `RolesController`.
 */
@Controller('roles')
export class RolesPermisosController {
  constructor(private readonly permisos: PermisosService) {}

  @RequirePermission(Permission.ROLES_VER)
  @Get(':id/permisos')
  permisosDeRol(@Param('id', ParseUUIDPipe) id: string) {
    return this.permisos.permisosDeRol(id);
  }

  @RequirePermission(Permission.ROLES_EDITAR_PERMISOS)
  @Put(':id/permisos')
  reemplazar(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReemplazarPermisosDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.permisos.reemplazar(id, dto.permisos, actor);
  }

  @RequirePermission(Permission.ROLES_VER)
  @Get(':id/permisos/historial')
  historial(@Param('id', ParseUUIDPipe) id: string, @Query() q: HistorialQueryDto) {
    return this.permisos.historial(id, q.limite);
  }
}
