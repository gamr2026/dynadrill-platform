import { Controller, Get, Param, Query } from '@nestjs/common';
import { AnyAuthenticated } from '@dyn/common';
import { RolesService } from '../services/roles.service';

/** Directorio mínimo de personas (id, nombre, rol, activo): cualquier usuario autenticado. */
@AnyAuthenticated()
@Controller('directorio')
export class DirectorioController {
  constructor(private readonly roles: RolesService) {}

  /** `GET /directorio/usuarios?ids=<uuid>,<uuid>` */
  @Get('usuarios')
  usuarios(@Query('ids') ids = '') {
    return this.roles.directorio(
      ids
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );
  }
}

@AnyAuthenticated()
@Controller('roles')
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @Get()
  findAll() {
    return this.roles.findAll();
  }

  @Get(':code/usuarios')
  usuariosPorRol(@Param('code') code: string) {
    return this.roles.usuariosPorRol(code);
  }
}
