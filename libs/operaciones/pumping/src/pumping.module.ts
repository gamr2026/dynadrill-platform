import { Module } from '@nestjs/common';
import { InventarioModule } from '@dyn/inventario';
import { CambiosItemsController } from './controllers/cambios-items.controller';
import { ResultadoCambioItemsConsumer } from './consumers/resultado-cambio-items.consumer';
import { DocumentosTicketController } from './controllers/documentos-ticket.controller';
import { ReportesDiariosController } from './controllers/reportes-diarios.controller';
import { DiaCorregidoConsumer } from './consumers/dia-corregido.consumer';
import { TicketsController } from './controllers/tickets.controller';
import { TrasladoSalidaController } from './controllers/traslado-salida.controller';
import { PedidosAbiertosConsumer } from './consumers/pedidos-abiertos.consumer';
import { RequisitosExternosConsumer } from './consumers/requisitos-externos.consumer';
import { PrismaService } from './prisma/prisma.service';
import { AsignacionService } from './services/asignacion.service';
import { IngresoService } from './services/ingreso.service';
import { EjecucionService } from './services/ejecucion.service';
import { QuimicosService } from './services/quimicos.service';
import { ReporteUnidadService } from './services/reporte-unidad.service';
import { CambiosItemsService } from './services/cambios-items.service';
import { DocumentosTicketService } from './services/documentos-ticket.service';
import { ReportesDiariosService } from './services/reportes-diarios.service';
import { RevisionSalidaService } from './services/revision-salida.service';
import { RequisitosService } from './services/requisitos.service';
import { TerminosService } from './services/terminos.service';
import { TicketsService } from './services/tickets.service';

/**
 * Pumping (contenedor operaciones). Dueño exclusivo del schema `pumping`. Requiere en la app `AppConfigModule`
 * (DATABASE_URL), `CommonModule` y `MessagingModule`.
 *
 * Hoy: recibe los pedidos abiertos de la línea Pumping, crea su ticket y lo lleva de la revisión inicial a la
 * asignación. Los demás pasos (asignación completa, traslados, ejecución, cierre) se agregan por fases.
 */
@Module({
  imports: [InventarioModule],
  controllers: [
    TicketsController,
    TrasladoSalidaController,
    ReportesDiariosController,
    CambiosItemsController,
    DocumentosTicketController,
  ],
  providers: [
    PrismaService,
    TicketsService,
    AsignacionService,
    RequisitosService,
    TerminosService,
    IngresoService,
    ReporteUnidadService,
    EjecucionService,
    QuimicosService,
    RevisionSalidaService,
    ReportesDiariosService,
    DiaCorregidoConsumer,
    CambiosItemsService,
    DocumentosTicketService,
    ResultadoCambioItemsConsumer,
    PedidosAbiertosConsumer,
    RequisitosExternosConsumer,
  ],
  exports: [TicketsService, AsignacionService, RequisitosService],
})
export class PumpingModule {}
