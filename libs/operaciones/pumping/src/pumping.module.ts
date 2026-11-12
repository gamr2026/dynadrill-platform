import { Module } from '@nestjs/common';
import { InventarioModule } from '@dyn/inventario';
import { CambiosItemsController } from './controllers/cambios-items.controller';
import { ResultadoCambioItemsConsumer } from './consumers/resultado-cambio-items.consumer';
import { DocumentosTicketController } from './controllers/documentos-ticket.controller';
import { JornadasController } from './controllers/jornadas.controller';
import { ReportesDiariosController } from './controllers/reportes-diarios.controller';
import { DiaCorregidoConsumer } from './consumers/dia-corregido.consumer';
import { DuracionResultadoConsumer } from './consumers/duracion-resultado.consumer';
import { TicketsController } from './controllers/tickets.controller';
import { TrasladoSalidaController } from './controllers/traslado-salida.controller';
import { PedidosAbiertosConsumer } from './consumers/pedidos-abiertos.consumer';
import { RequisitosExternosConsumer } from './consumers/requisitos-externos.consumer';
import { PrismaService } from './prisma/prisma.service';
import { ResponsableService } from './services/responsable.service';
import { DisponibilidadService } from './services/disponibilidad.service';
import { AnulacionService } from './services/anulacion.service';
import { TicketNoAnuladoGuard } from './guards/ticket-no-anulado.guard';
import { AsignacionService } from './services/asignacion.service';
import { IngresoService } from './services/ingreso.service';
import { AvanceService } from './services/avance.service';
import { JornadasAvisosService } from './services/jornadas-avisos.service';
import { RequisitosVencidosService } from './services/requisitos-vencidos.service';
import { RequisitosController } from './controllers/requisitos.controller';
import { TareasHoyService } from './services/tareas-hoy.service';
import { DuracionService } from './services/duracion.service';
import { JornadasService } from './services/jornadas.service';
import { EjecucionService } from './services/ejecucion.service';
import { QuimicosService } from './services/quimicos.service';
import { ReporteUnidadService } from './services/reporte-unidad.service';
import { CambiosItemsService } from './services/cambios-items.service';
import { DocumentosTicketService } from './services/documentos-ticket.service';
import { ReporteHerramientasController } from './controllers/reporte-herramientas.controller';
import { ReporteHerramientasService } from './services/reporte-herramientas.service';
import { ReportesDiariosService } from './services/reportes-diarios.service';
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
    ReporteHerramientasController,
    JornadasController,
    RequisitosController,
  ],
  providers: [
    PrismaService,
    TicketsService,
    AsignacionService,
    AnulacionService,
    DisponibilidadService,
    ResponsableService,
    TicketNoAnuladoGuard,
    RequisitosService,
    TerminosService,
    IngresoService,
    ReporteUnidadService,
    EjecucionService,
    QuimicosService,
    ReportesDiariosService,
    ReporteHerramientasService,
    JornadasService,
    AvanceService,
    JornadasAvisosService,
    RequisitosVencidosService,
    TareasHoyService,
    DuracionService,
    DuracionResultadoConsumer,
    DiaCorregidoConsumer,
    CambiosItemsService,
    DocumentosTicketService,
    ResultadoCambioItemsConsumer,
    PedidosAbiertosConsumer,
    RequisitosExternosConsumer,
  ],
  exports: [TicketsService, AsignacionService, RequisitosService, JornadasService],
})
export class PumpingModule {}
