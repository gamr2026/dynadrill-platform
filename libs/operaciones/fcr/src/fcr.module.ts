import { Module } from '@nestjs/common';
import { PedidosAbiertosConsumer } from './consumers/pedidos-abiertos.consumer';
import { TicketsController } from './controllers/tickets.controller';
import { PrismaService } from './prisma/prisma.service';
import { AsignacionService } from './services/asignacion.service';
import { CatalogosService } from './services/catalogos.service';
import { RequisitosService } from './services/requisitos.service';
import { TicketsService } from './services/tickets.service';
import { TipoOperadorService } from './services/tipo-operador.service';

/**
 * FCR (contenedor operaciones). Dueño exclusivo del schema `fcr`. Requiere en la app `AppConfigModule` (DATABASE_URL), `CommonModule` y
 * `MessagingModule`.
 *
 * Recibe los pedidos abiertos de la línea FCR, crea su ticket por la entrada que corresponde a su tipo de OT (venta o servicios) y lo
 * lleva por el tronco común: preparación de herramientas, asignación, reunión operativa, ejecución, revisión de reportes, control de
 * retorno y cierre. Los pasos se completan por tramos (ver documentacion/modulos/plan-fcr.md).
 */
@Module({
  controllers: [TicketsController],
  providers: [
    PrismaService,
    TicketsService,
    AsignacionService,
    TipoOperadorService,
    CatalogosService,
    RequisitosService,
    PedidosAbiertosConsumer,
  ],
  exports: [TicketsService, AsignacionService, RequisitosService],
})
export class FcrModule {}
