import { Controller, Get } from '@nestjs/common';
import { Permission } from '@dyn/authz';
import { RequirePermission } from '@dyn/common';
import { ReporteriaService } from '../services/reporteria.service';

/** Reportería y control de gestión de Facturación. Exige ver prefacturas: es lo que cuenta como ingreso real. */
@Controller('comercial/reporteria')
export class ReporteriaController {
  constructor(private readonly reporteria: ReporteriaService) {}

  /** Una fila por pedido (sin borradores) con su prefactura vigente, guía, orden de trabajo y fechas de los hitos. */
  @RequirePermission(Permission.PREFACTURAS_VER)
  @Get('pedidos')
  pedidos() {
    return this.reporteria.pedidos();
  }
}
