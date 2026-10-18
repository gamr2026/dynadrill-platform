// Única puerta pública del módulo: lo demás (Prisma, DTOs, controllers) es interno.
export { InventarioModule } from './inventario.module';
export {
  MovimientosService,
  type ActorInventario,
  type ConsumoDeTicket,
  type EntradaManual,
  type MovimientoDeDespacho,
  type MovimientoDeTicket,
  type SalidaDeMantenimiento,
} from './services/movimientos.service';
export { DespachosConsumer } from './consumers/despachos.consumer';
export { ArticulosService } from './services/articulos.service';
export type { EntradaKardex } from './services/kardex';
