import { Module } from '@nestjs/common';
import { IntegracionesModule } from '@dyn/integraciones';
import { As2IntegracionAdapter } from './as2/as2-integracion.adapter';
import { As2Port } from './as2/as2.port';
import { As2Controller } from './controllers/as2.controller';
import { AuthController } from './controllers/auth.controller';
import { PermissionsController, RolesPermisosController } from './controllers/permisos.controller';
import { DirectorioController, RolesController } from './controllers/roles.controller';
import { UsersController } from './controllers/users.controller';
import { PrismaService } from './prisma/prisma.service';
import { As2CuentasService } from './services/as2-cuentas.service';
import { As2Service } from './services/as2.service';
import { As2SyncService } from './services/as2-sync.service';
import { AuthService } from './services/auth.service';
import { PasswordService } from './services/password.service';
import { PermisosService } from './services/permisos.service';
import { RolesService } from './services/roles.service';
import { TokenService } from './services/token.service';
import { UsersService } from './services/users.service';
import { UsuariosPorRolService } from './services/usuarios-por-rol.service';

/**
 * Identidad: usuarios, roles y sesiones. Dueño exclusivo del schema `identidad`. Requiere en la app:
 * `AppConfigModule` (DATABASE_URL + `identidadEnvSchema`), `CommonModule` y `MessagingModule`.
 */
@Module({
  imports: [IntegracionesModule],
  controllers: [
    AuthController,
    UsersController,
    RolesController,
    DirectorioController,
    RolesPermisosController,
    PermissionsController,
    As2Controller,
  ],
  providers: [
    PrismaService,
    PasswordService,
    TokenService,
    AuthService,
    UsersService,
    RolesService,
    PermisosService,
    { provide: As2Port, useClass: As2IntegracionAdapter },
    As2Service,
    As2CuentasService,
    As2SyncService,
    UsuariosPorRolService,
  ],
  exports: [UsuariosPorRolService],
})
export class IdentidadModule {}
