import { Module } from '@nestjs/common';
import { ReporteUnidadLlegadaConsumer } from './consumers/reporte-unidad-llegada.consumer';
import { MantenimientoController } from './controllers/mantenimiento.controller';
import { PrismaService } from './prisma/prisma.service';
import { OrdenesService } from './services/ordenes.service';
import { ReportesService } from './services/reportes.service';

/**
 * Mantenimiento (contenedor operaciones). Dueño exclusivo del schema `mantenimiento`. Requiere en la app `AppConfigModule`
 * (DATABASE_URL), `CommonModule` y `MessagingModule`.
 *
 * Hoy (M1): recibe los reportes de unidad de llegada de Pumping y el Jefe de Mantenimiento los clasifica (descarta o genera una
 * orden con sub-órdenes). Después: ejecución y cierre de sub-órdenes (M2), historial y preventivos (M3), tarjeta, avisos y KPI (M4).
 */
@Module({
  controllers: [MantenimientoController],
  providers: [PrismaService, ReportesService, OrdenesService, ReporteUnidadLlegadaConsumer],
  exports: [ReportesService, OrdenesService],
})
export class MantenimientoModule {}
