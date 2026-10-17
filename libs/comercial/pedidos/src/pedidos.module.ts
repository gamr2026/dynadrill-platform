import { Module } from '@nestjs/common';
import { OrdenesTrabajoController } from './controllers/ordenes-trabajo.controller';
import { TicketCerradoConsumer } from './consumers/ticket-cerrado.consumer';
import { CierrePedidoService } from './services/cierre-pedido.service';
import { OrdenesTrabajoService } from './services/ordenes-trabajo.service';
import { GuiasController } from './controllers/guias.controller';
import { GuiasService } from './services/guias.service';
import { PrefacturasController } from './controllers/prefacturas.controller';
import { DocumentosOperativosController } from './controllers/documentos-operativos.controller';
import { ListasPreciosController } from './controllers/listas-precios.controller';
import { PedidosController } from './controllers/pedidos.controller';
import { SecuenciasController } from './controllers/secuencias.controller';
import { DirectorioHttpAdapter } from './directorio/directorio-http.adapter';
import { DirectorioPort } from './directorio/directorio.port';
import { PrismaService } from './prisma/prisma.service';
import { ListasPreciosService } from './services/listas-precios.service';
import { DocumentosOperativosService } from './services/documentos-operativos.service';
import { PedidoEstadoService } from './services/pedido-estado.service';
import { PrefacturasService } from './services/prefacturas.service';
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
    GuiasController,
    OrdenesTrabajoController,
    ListasPreciosController,
  ],
  providers: [
    PrismaService,
    SecuenciasService,
    WorkflowService,
    { provide: DirectorioPort, useClass: DirectorioHttpAdapter },
    PedidosService,
    ListasPreciosService,
    DocumentosOperativosService,
    PedidoEstadoService,
    PrefacturasService,
    GuiasService,
    OrdenesTrabajoService,
    CierrePedidoService,
    TicketCerradoConsumer,
  ],
  exports: [SecuenciasService, WorkflowService, PedidosService],
})
export class PedidosModule {}
