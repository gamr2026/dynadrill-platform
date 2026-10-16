import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { Permission } from '@dyn/authz';
import { AuthUser, CurrentUser, RequirePermission } from '@dyn/common';
import { CrearCuentasDto, EmpleadosAs2QueryDto } from '../dto/as2.dto';
import { As2CuentasService } from '../services/as2-cuentas.service';
import { As2Service } from '../services/as2.service';
import { As2SyncService } from '../services/as2-sync.service';

/**
 * Copia local de los empleados de AS2 (ERP). Solo lectura salvo la sincronización a pedido; la edición de
 * estos datos se hace en AS2. Contiene cédulas, por eso exige permiso (por defecto solo Superadmin).
 */
@Controller('as2')
export class As2Controller {
  constructor(
    private readonly as2: As2Service,
    private readonly sync: As2SyncService,
    private readonly cuentas: As2CuentasService,
  ) {}

  @RequirePermission(Permission.AS2_VER)
  @Get('estado')
  estado() {
    return this.as2.estado();
  }

  @RequirePermission(Permission.AS2_VER)
  @Get('sincronizaciones')
  sincronizaciones() {
    return this.as2.sincronizaciones();
  }

  @RequirePermission(Permission.AS2_VER)
  @Get('empleados')
  empleados(@Query() q: EmpleadosAs2QueryDto) {
    return this.as2.empleados(q);
  }

  @RequirePermission(Permission.AS2_VER)
  @Get('empleados/:id/historial')
  historial(@Param('id', ParseUUIDPipe) id: string) {
    return this.as2.historial(id);
  }

  /**
   * Crea las cuentas (inactivas) de los empleados activos con correo en AS2. Por defecto solo SIMULA: devuelve qué haría
   * sin escribir nada; hay que enviar `simular: false` para crearlas. Sin correo en AS2, no se crea cuenta.
   */
  @RequirePermission(Permission.AS2_CREAR_CUENTAS)
  @Post('crear-cuentas')
  crearCuentas(@Body() dto: CrearCuentasDto, @CurrentUser() actor: AuthUser) {
    return this.cuentas.crearCuentas(actor, dto.simular ?? true, dto.cedulas);
  }

  /** Lee AS2 y actualiza la copia. Si AS2 falla no se modifica nada y responde 502. */
  @RequirePermission(Permission.AS2_SINCRONIZAR)
  @Post('sincronizar')
  sincronizar(@CurrentUser() actor: AuthUser) {
    return this.sync.sincronizar('manual', actor.id);
  }
}
