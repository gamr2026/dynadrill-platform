import { BadRequestException, Body, Controller, Get, Patch } from '@nestjs/common';
import { Permission } from '@dyn/authz';
import { CurrentUser, RequirePermission, type AuthUser } from '@dyn/common';
import { DashboardMetasService, type MetasDelTablero } from './dashboard-metas.service';

/** Metas del tablero HSE. Ruta pública `/api/v2/qhse/dashboard-metas` (el gateway reescribe `/api/qhse`); el personal HSE las consulta y las fija con `qhse.general.gestionar`. */
@Controller('qhse/dashboard-metas')
export class DashboardMetasController {
  constructor(private readonly metas: DashboardMetasService) {}

  @RequirePermission(Permission.QHSE_GESTIONAR)
  @Get()
  vigentes() {
    return this.metas.vigentes();
  }

  /** Cuerpo: `{ códigoDelIndicador: valor }`. Devuelve todas las metas vigentes. */
  @RequirePermission(Permission.QHSE_GESTIONAR)
  @Patch()
  fijar(@Body() cuerpo: MetasDelTablero, @CurrentUser() actor: AuthUser) {
    for (const v of Object.values(cuerpo ?? {})) {
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 99_999_999_999) {
        throw new BadRequestException('Cada meta debe ser un número entre 0 y 99.999.999.999');
      }
    }
    return this.metas.fijar(cuerpo, actor);
  }
}
