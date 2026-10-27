import { Controller, Get } from '@nestjs/common';
import { Permission } from '@dyn/authz';
import { RequirePermission } from '@dyn/common';
import { DashboardIndicadoresService } from './dashboard-indicadores.service';

/** Indicadores del Dashboard Integrado del Sistema (HSE-MASTER-001). Ruta pública `/api/v2/qhse/dashboard/indicadores`; el personal HSE (`qhse.general.gestionar`). */
@Controller('qhse/dashboard')
export class DashboardIndicadoresController {
  constructor(private readonly indicadores: DashboardIndicadoresService) {}

  @RequirePermission(Permission.QHSE_GESTIONAR)
  @Get('indicadores')
  obtener() {
    return this.indicadores.indicadores();
  }
}
