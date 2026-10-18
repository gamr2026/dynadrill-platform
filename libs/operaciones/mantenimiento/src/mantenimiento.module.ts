import { Module } from '@nestjs/common';
import { InventarioModule } from '@dyn/inventario';
import { ReporteUnidadLlegadaConsumer } from './consumers/reporte-unidad-llegada.consumer';
import { MantenimientoController } from './controllers/mantenimiento.controller';
import { PrismaService } from './prisma/prisma.service';
import { EjecucionService } from './services/ejecucion.service';
import { OrdenesService } from './services/ordenes.service';
import { ReportesService } from './services/reportes.service';

/**
 * Mantenimiento (contenedor operaciones). Dueño exclusivo del schema `mantenimiento`. Requiere en la app `AppConfigModule`
 * (DATABASE_URL), `CommonModule` y `MessagingModule`.
 *
 * M1: recibe los reportes de unidad de llegada de Pumping y el Jefe de Mantenimiento los clasifica (descarta o genera una
 * orden con sub-órdenes). M2 (en curso): ejecución de la sub-orden con sus repuestos, revisión y cierre (la salida de bodega sale por Inventario). Después: retorno a operación, historial y preventivos (M3), tarjeta, avisos y KPI (M4).
 */
@Module({
  imports: [InventarioModule],
  controllers: [MantenimientoController],
  providers: [
    PrismaService,
    ReportesService,
    OrdenesService,
    EjecucionService,
    ReporteUnidadLlegadaConsumer,
  ],
  exports: [ReportesService, OrdenesService, EjecucionService],
})
export class MantenimientoModule {}
