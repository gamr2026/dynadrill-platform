import { Controller, Post } from '@nestjs/common';
import { Permission } from '@dyn/authz';
import { RequirePermission } from '@dyn/common';
import { AvisosProgramadosService } from './avisos-programados.service';

/**
 * Revisión de avisos por vencimiento a pedido. Ruta pública `/api/v2/qhse/avisos/ejecutar`, con `qhse.general.gestionar` (la revisión también corre
 * sola cada cierto tiempo; esto sirve para forzarla y para probarla). Es idempotente: solo avisa los hechos que aún no se habían avisado.
 */
@Controller('qhse/avisos')
export class AvisosProgramadosController {
  constructor(private readonly avisos: AvisosProgramadosService) {}

  @RequirePermission(Permission.QHSE_GESTIONAR)
  @Post('ejecutar')
  ejecutar() {
    return this.avisos.emitir();
  }
}
