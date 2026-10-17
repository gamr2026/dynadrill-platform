import { Module } from '@nestjs/common';
import { TicketsController } from './controllers/tickets.controller';
import { TrasladoSalidaController } from './controllers/traslado-salida.controller';
import { PedidosAbiertosConsumer } from './consumers/pedidos-abiertos.consumer';
import { RequisitosExternosConsumer } from './consumers/requisitos-externos.consumer';
import { PrismaService } from './prisma/prisma.service';
import { AsignacionService } from './services/asignacion.service';
import { IngresoService } from './services/ingreso.service';
import { EjecucionService } from './services/ejecucion.service';
import { ReporteUnidadService } from './services/reporte-unidad.service';
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
  controllers: [TicketsController, TrasladoSalidaController],
  providers: [
    PrismaService,
    TicketsService,
    AsignacionService,
    RequisitosService,
    TerminosService,
    IngresoService,
    ReporteUnidadService,
    EjecucionService,
    PedidosAbiertosConsumer,
    RequisitosExternosConsumer,
  ],
  exports: [TicketsService, AsignacionService, RequisitosService],
})
export class PumpingModule {}
