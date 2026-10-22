import { Module } from '@nestjs/common';
import { CambioItemsController } from './controllers/cambio-items.controller';
import { OrdenesTrabajoController } from './controllers/ordenes-trabajo.controller';
import { CambioItemsConsumer } from './consumers/cambio-items.consumer';
import { ReporteDiarioConsumer } from './consumers/reporte-diario.consumer';
import { TicketCerradoConsumer } from './consumers/ticket-cerrado.consumer';
import { TicketOperativoConsumer } from './consumers/ticket-operativo.consumer';
import { CambioItemsService } from './services/cambio-items.service';
import { OrdenesTrabajoService } from './services/ordenes-trabajo.service';
import { GuiasController } from './controllers/guias.controller';
import { GuiasService } from './services/guias.service';
import { PrefacturasController } from './controllers/prefacturas.controller';
import { ReporteriaController } from './controllers/reporteria.controller';
import { DocumentosFirmadosController } from './controllers/documentos-firmados.controller';
import { DocumentosOperativosController } from './controllers/documentos-operativos.controller';
import { ListasPreciosController } from './controllers/listas-precios.controller';
import { PedidosController } from './controllers/pedidos.controller';
import { SecuenciasController } from './controllers/secuencias.controller';
import { DirectorioHttpAdapter } from './directorio/directorio-http.adapter';
import { DirectorioPort } from './directorio/directorio.port';
import { OperacionesHttpAdapter } from './directorio/operaciones-http.adapter';
import { OperacionesPort } from './directorio/operaciones.port';
import { PrismaService } from './prisma/prisma.service';
import { ListasPreciosService } from './services/listas-precios.service';
import { DocumentosOperativosService } from './services/documentos-operativos.service';
import { PedidoEstadoService } from './services/pedido-estado.service';
import { PrefacturasService } from './services/prefacturas.service';
import { ReporteriaService } from './services/reporteria.service';
import { DocumentosFirmadosService } from './services/documentos-firmados.service';
import { PedidosService } from './services/pedidos.service';
import { SecuenciasService } from './services/secuencias.service';
import { WorkflowService } from './workflow/workflow.service';

/**
 * Pedidos y documentos del ciclo comercial. Dueño exclusivo del schema `comercial`. Requiere en la app
 * `AppConfigModule` (DATABASE_URL y PLATAFORMA_URL), `CommonModule` y `MessagingModule`.
 *
 * Contiene: motor de documentos y secuenciales, motor de estados por proceso, pedidos (crear, abrir, editar, anular,
 * rechazar, asignar analista, vincular con AS2) y consulta de listas de precios. El resto del ciclo (documentos
 * operativos, prefactura, guía y AOT) se agrega por fases (ver documentacion/database/PLAN-MIGRACION-PEDIDOS.md).
 */
@Module({
  controllers: [
    SecuenciasController,
    PedidosController,
    DocumentosOperativosController,
    PrefacturasController,
    ReporteriaController,
    DocumentosFirmadosController,
    GuiasController,
    OrdenesTrabajoController,
    ListasPreciosController,
    CambioItemsController,
  ],
  providers: [
    PrismaService,
    SecuenciasService,
    WorkflowService,
    { provide: DirectorioPort, useClass: DirectorioHttpAdapter },
    { provide: OperacionesPort, useClass: OperacionesHttpAdapter },
    PedidosService,
    ListasPreciosService,
    DocumentosOperativosService,
    PedidoEstadoService,
    PrefacturasService,
    ReporteriaService,
    DocumentosFirmadosService,
    GuiasService,
    OrdenesTrabajoService,
    TicketCerradoConsumer,
    TicketOperativoConsumer,
    ReporteDiarioConsumer,
    CambioItemsService,
    CambioItemsConsumer,
  ],
  exports: [SecuenciasService, WorkflowService, PedidosService],
})
export class PedidosModule {}
