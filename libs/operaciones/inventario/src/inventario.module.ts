import { Module } from '@nestjs/common';
import { DespachosConsumer } from './consumers/despachos.consumer';
import { InventarioController } from './controllers/inventario.controller';
import { PrismaService } from './prisma/prisma.service';
import { ArticulosService } from './services/articulos.service';
import { CatalogosService } from './services/catalogos.service';
import { DespachosService } from './services/despachos.service';
import { MinimosService } from './services/minimos.service';
import { MovimientosService } from './services/movimientos.service';
import { PartesService } from './services/partes.service';

/**
 * Inventario (contenedor operaciones). Dueño exclusivo del schema `inventario`. Requiere en la app `AppConfigModule`
 * (DATABASE_URL), `CommonModule` y `MessagingModule`.
 *
 * Hoy: catálogo de artículos, partes, kardex inmutable, consumo por ticket y despachos a bodega (por evento de comercial). Los demás módulos del contenedor (Pumping, FCR) registran sus
 * movimientos con `MovimientosService.registrar`, dentro de su propia transacción.
 */
@Module({
  controllers: [InventarioController],
  providers: [
    PrismaService,
    ArticulosService,
    CatalogosService,
    DespachosService,
    MovimientosService,
    MinimosService,
    PartesService,
    DespachosConsumer,
  ],
  exports: [MovimientosService, ArticulosService],
})
export class InventarioModule {}
