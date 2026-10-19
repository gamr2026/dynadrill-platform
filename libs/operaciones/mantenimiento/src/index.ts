// Única puerta pública del módulo: lo demás (Prisma, DTOs, controllers) es interno.
export { MantenimientoModule } from './mantenimiento.module';
export { ReportesService } from './services/reportes.service';
export { OrdenesService } from './services/ordenes.service';
export { estadoDeOrden, type EstadoOrden } from './services/estado-orden';
export { ReporteUnidadLlegadaConsumer } from './consumers/reporte-unidad-llegada.consumer';
