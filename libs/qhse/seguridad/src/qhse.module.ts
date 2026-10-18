import { Module } from '@nestjs/common';
import { ArticulosEpiConsumer } from './consumers/articulos-epi.consumer';
import { PumpingEventosConsumer } from './consumers/pumping-eventos.consumer';
import { DocumentosEstadoService } from './documentos/documentos-estado.service';
import { DocumentosPedidoService } from './documentos/documentos-pedido.service';
import { DocumentosController } from './documentos/documentos.controller';
import { EpiConsultaService } from './epi/epi-consulta.service';
import { EpiController } from './epi/epi.controller';
import { EpiRenglonesService } from './epi/epi-renglones.service';
import { EpiService } from './epi/epi.service';
import { PrismaService } from './prisma/prisma.service';
import { PtwConsultaService } from './ptw/ptw-consulta.service';
import { PtwController } from './ptw/ptw.controller';
import { PtwService } from './ptw/ptw.service';

/**
 * QHSE (contenedor qhse). Dueño exclusivo del schema `qhse`. Requiere en la app `AppConfigModule` (DATABASE_URL),
 * `CommonModule` y `MessagingModule`.
 *
 * Tramo Q1: entrega de EPI (solicitar, aprobar o rechazar, despachar) y la referencia de los tickets que la originan. Documentos por
 * pedido y Acta de Entrega de Locación (contrato 4.11); Permiso de Trabajo (PTW) por día y pedido. Los demás
 * subdominios (SWA, STOP, inspecciones, IPERC, PTW, ambiental, emergencias, investigaciones) se agregan por tramos.
 */
@Module({
  controllers: [EpiController, DocumentosController, PtwController],
  providers: [
    PrismaService,
    EpiService,
    EpiConsultaService,
    EpiRenglonesService,
    DocumentosPedidoService,
    DocumentosEstadoService,
    PtwService,
    PtwConsultaService,
    PumpingEventosConsumer,
    ArticulosEpiConsumer,
  ],
  exports: [EpiService, DocumentosPedidoService, PtwService],
})
export class QhseModule {}
