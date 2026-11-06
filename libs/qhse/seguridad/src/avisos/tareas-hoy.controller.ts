import { Controller, Get } from '@nestjs/common';
import { Permission } from '@dyn/authz';
import { RequirePermission } from '@dyn/common';
import { TareasHoyQhseService } from './tareas-hoy.service';

/** «Mis tareas de hoy» de QHSE (PTW, PT y ART). Ruta pública `/api/v2/qhse/mis-tareas-hoy`, para el personal HSE (`qhse.general.gestionar`). */
@Controller('qhse')
export class TareasHoyQhseController {
  constructor(private readonly tareas: TareasHoyQhseService) {}

  @RequirePermission(Permission.QHSE_GESTIONAR)
  @Get('mis-tareas-hoy')
  hoy() {
    return this.tareas.delDia();
  }
}
