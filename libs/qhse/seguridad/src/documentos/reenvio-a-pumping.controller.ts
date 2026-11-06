import { Controller, Post } from '@nestjs/common';
import { Permission } from '@dyn/authz';
import { CurrentUser, RequirePermission, type AuthUser } from '@dyn/common';
import { ReenvioAPumpingService } from './reenvio-a-pumping.service';

/** Reenvío único de los PTW aprobados y los PT y ART vigentes a Pumping (al desplegar la jornada por día). Ruta pública `/api/v2/qhse/reenvio/pumping`. */
@Controller('qhse/reenvio')
export class ReenvioAPumpingController {
  constructor(private readonly reenvio: ReenvioAPumpingService) {}

  @RequirePermission(Permission.QHSE_GESTIONAR)
  @Post('pumping')
  reenviar(@CurrentUser() actor: AuthUser) {
    return this.reenvio.reenviar(actor);
  }
}
