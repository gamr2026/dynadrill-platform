import { Module } from '@nestjs/common';
import { FlotaModule } from '@dyn/flota';
import { InventarioModule } from '@dyn/inventario';
import { ReporteUnidadLlegadaConsumer } from './consumers/reporte-unidad-llegada.consumer';
import { MantenimientoController } from './controllers/mantenimiento.controller';
import { PrismaService } from './prisma/prisma.service';
import { EjecucionService } from './services/ejecucion.service';
import { HistorialService } from './services/historial.service';
import { OrdenesService } from './services/ordenes.service';
import { ReportesService } from './services/reportes.service';

/**
 * Mantenimiento (contenedor operaciones). Dueño exclusivo del schema `mantenimiento`. Requiere en la app `AppConfigModule`
 * (DATABASE_URL), `CommonModule` y `MessagingModule`.
 *
 * M1: recibe los reportes de unidad de llegada de Pumping y el Jefe de Mantenimiento los clasifica (descarta o genera una
 * orden con sub-órdenes). M2: ejecución de la sub-orden con sus repuestos, revisión, cierre (la salida de bodega sale por Inventario) y retorno a operación. M3: historial de mantenimientos (preventivos de Flota + correctivos). M4: avisos, KPI y hojas imprimibles.
 */
@Module({
  imports: [InventarioModule, FlotaModule],
  controllers: [MantenimientoController],
  providers: [
    PrismaService,
    ReportesService,
    OrdenesService,
    EjecucionService,
    HistorialService,
    ReporteUnidadLlegadaConsumer,
  ],
  exports: [ReportesService, OrdenesService, EjecucionService, HistorialService],
})
export class MantenimientoModule {}
