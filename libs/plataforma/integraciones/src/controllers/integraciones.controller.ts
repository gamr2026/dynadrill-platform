import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { Permission } from '@dyn/authz';
import { AuthUser, CurrentUser, RequirePermission } from '@dyn/common';
import {
  ActualizarProveedorDto,
  CrearVersionDto,
  EjecucionesQueryDto,
  ProbarDto,
} from '../dto/integraciones.dto';
import { ConfiguracionService } from '../services/configuracion.service';
import { MotorService } from '../services/motor.service';

/**
 * Configuración de las integraciones con terceros. Por defecto solo Superadmin. Nunca devuelve valores de
 * secretos ni cuerpos de datos: solo la configuración, conteos y la bitácora.
 */
@Controller('integraciones')
export class IntegracionesController {
  constructor(
    private readonly config: ConfiguracionService,
    private readonly motor: MotorService,
  ) {}

  @RequirePermission(Permission.INTEGRACIONES_VER)
  @Get('proveedores')
  proveedores() {
    return this.config.listar();
  }

  @RequirePermission(Permission.INTEGRACIONES_VER)
  @Get('proveedores/:codigo')
  proveedor(@Param('codigo') codigo: string) {
    return this.config.detalle(codigo);
  }

  @RequirePermission(Permission.INTEGRACIONES_EDITAR)
  @Put('proveedores/:codigo')
  actualizar(
    @Param('codigo') codigo: string,
    @Body() dto: ActualizarProveedorDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.config.actualizarProveedor(codigo, dto, actor.id);
  }

  /** Crea una versión nueva (inactiva) de una operación. No afecta a la que está en uso hasta activarla. */
  @RequirePermission(Permission.INTEGRACIONES_EDITAR)
  @Post('proveedores/:codigo/operaciones/:operacion/versiones')
  crearVersion(
    @Param('codigo') codigo: string,
    @Param('operacion') operacion: string,
    @Body() dto: CrearVersionDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.config.crearVersion(codigo, operacion, dto, actor.id);
  }

  /** Llama al tercero con esa versión y devuelve solo conteos y nombres de campos (nunca los datos). */
  @RequirePermission(Permission.INTEGRACIONES_PROBAR)
  @Post('operaciones/:id/probar')
  probar(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ProbarDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.motor.probar(id, dto.param ?? {}, actor.id);
  }

  /** Activa esa versión y desactiva la anterior (volver atrás es activar la anterior). */
  @RequirePermission(Permission.INTEGRACIONES_EDITAR)
  @Post('operaciones/:id/activar')
  activar(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: AuthUser) {
    return this.config.activar(id, actor.id);
  }

  @RequirePermission(Permission.INTEGRACIONES_VER)
  @Get('ejecuciones')
  ejecuciones(@Query() q: EjecucionesQueryDto) {
    return this.config.ejecuciones(q);
  }

  @RequirePermission(Permission.INTEGRACIONES_VER)
  @Get('cambios/:id')
  cambios(@Param('id', ParseUUIDPipe) id: string) {
    return this.config.cambios(id);
  }
}
