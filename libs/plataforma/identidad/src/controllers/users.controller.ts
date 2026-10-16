import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { Permission } from '@dyn/authz';
import { AuthUser, CurrentUser, RequirePermission } from '@dyn/common';
import { CreateUserDto, UpdateUserDto } from '../dto/user.dto';
import { UsersService } from '../services/users.service';

/**
 * Administración de usuarios, un permiso por acción (por defecto solo Superadmin los tiene todos):
 * ver, crear, editar e inactivar. La baja es lógica: no se borran usuarios.
 */
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @RequirePermission(Permission.USUARIOS_VER)
  @Get()
  findAll() {
    return this.users.findAll();
  }

  @RequirePermission(Permission.USUARIOS_VER)
  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.users.findOne(id);
  }

  @RequirePermission(Permission.USUARIOS_CREAR)
  @Post()
  create(@Body() dto: CreateUserDto, @CurrentUser() actor: AuthUser) {
    return this.users.create(dto, actor);
  }

  /** Inactivar por esta vía (`status: false`) exige además `identidad.usuarios.inactivar`; lo verifica el servicio. */
  @RequirePermission(Permission.USUARIOS_EDITAR)
  @Put(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUserDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.users.update(id, dto, actor);
  }

  /** Inactiva la cuenta y cierra sus sesiones; no elimina datos. */
  @RequirePermission(Permission.USUARIOS_INACTIVAR)
  @Delete(':id')
  async remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: AuthUser) {
    await this.users.remove(id, actor);
    return { ok: true };
  }
}
