import { Module } from '@nestjs/common';
import { InventarioModule } from '@dyn/inventario';
import { PedidosAbiertosConsumer } from './consumers/pedidos-abiertos.consumer';
import { ConfiguracionCodigosController } from './controllers/configuracion-codigos.controller';
import { HerramientasController } from './controllers/herramientas.controller';
import { TicketsController } from './controllers/tickets.controller';
import { PrismaService } from './prisma/prisma.service';
import { AsignacionService } from './services/asignacion.service';
import { CatalogosService } from './services/catalogos.service';
import { ConfiguracionCodigosService } from './services/configuracion-codigos.service';
import { HerramientasService } from './services/herramientas.service';
import { PrecargaService } from './services/precarga.service';
import { RequisitosService } from './services/requisitos.service';
import { TicketsService } from './services/tickets.service';
import { TipoOperadorService } from './services/tipo-operador.service';

/**
 * FCR (contenedor operaciones). Dueño exclusivo del schema `fcr`. Requiere en la app `AppConfigModule` (DATABASE_URL), `CommonModule` y
 * `MessagingModule`.
 *
 * Recibe los pedidos abiertos de la línea FCR, crea su ticket por la entrada que corresponde a su tipo de OT (venta o servicios) con las
 * herramientas precargadas desde la configuración por cliente y código, y lo lleva por el tronco común: preparación de herramientas,
 * asignación, reunión operativa, ejecución, revisión de reportes, control de retorno y cierre. Los pasos se completan por tramos
 * (ver documentacion/modulos/plan-fcr.md). Inventario aporta los artículos (herramientas con partes) y su existencia.
 */
@Module({
  imports: [InventarioModule],
  controllers: [TicketsController, ConfiguracionCodigosController, HerramientasController],
  providers: [
    PrismaService,
    TicketsService,
    AsignacionService,
    TipoOperadorService,
    CatalogosService,
    RequisitosService,
    PrecargaService,
    HerramientasService,
    ConfiguracionCodigosService,
    PedidosAbiertosConsumer,
  ],
  exports: [TicketsService, AsignacionService, RequisitosService],
})
export class FcrModule {}
