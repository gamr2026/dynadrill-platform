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
import { InspeccionesConsultaService } from './inspecciones/inspecciones-consulta.service';
import { InspeccionesController } from './inspecciones/inspecciones.controller';
import { InspeccionesService } from './inspecciones/inspecciones.service';
import { IpercCatalogosService } from './iperc/iperc-catalogos.service';
import { IpercConsultaService } from './iperc/iperc-consulta.service';
import { IpercController } from './iperc/iperc.controller';
import { IpercService } from './iperc/iperc.service';
import { PrismaService } from './prisma/prisma.service';
import { VerificadorFirmas, VerificadorFirmasHttp } from './documentos/verificador-firmas';
import { SwaConsultaService } from './swa/swa-consulta.service';
import { SwaController } from './swa/swa.controller';
import { SwaService } from './swa/swa.service';
import { StopConsultaService } from './stop/stop-consulta.service';
import { StopController } from './stop/stop.controller';
import { StopService } from './stop/stop.service';
import { PtwConsultaService } from './ptw/ptw-consulta.service';
import { PtwController } from './ptw/ptw.controller';
import { PtwService } from './ptw/ptw.service';
import { InvestigacionesConsultaService } from './investigaciones/investigaciones-consulta.service';
import { InvestigacionesController } from './investigaciones/investigaciones.controller';
import { InvestigacionesFormatoController } from './investigaciones/investigaciones-formato.controller';
import { InvestigacionesFormatoService } from './investigaciones/investigaciones-formato.service';
import { InvestigacionesCausasController } from './investigaciones/investigaciones-causas.controller';
import { InvestigacionesCausasService } from './investigaciones/investigaciones-causas.service';
import { InvestigacionesAccionesController } from './investigaciones/investigaciones-acciones.controller';
import { InvestigacionesAccionesService } from './investigaciones/investigaciones-acciones.service';
import { InvestigacionesCierreController } from './investigaciones/investigaciones-cierre.controller';
import { InvestigacionesCierreService } from './investigaciones/investigaciones-cierre.service';
import { RequisitosLegalesConsultaService } from './legal/requisitos-legales-consulta.service';
import { RequisitosLegalesController } from './legal/requisitos-legales.controller';
import { RequisitosLegalesService } from './legal/requisitos-legales.service';
import { InvestigacionesService } from './investigaciones/investigaciones.service';

/**
 * QHSE (contenedor qhse). Dueño exclusivo del schema `qhse`. Requiere en la app `AppConfigModule` (DATABASE_URL),
 * `CommonModule` y `MessagingModule`.
 *
 * Tramo Q1: entrega de EPI (solicitar, aprobar o rechazar, despachar) y la referencia de los tickets que la originan. Documentos por
 * pedido y Acta de Entrega de Locación (contrato 4.11); Permiso de Trabajo (PTW) por día y pedido; Stop Work Authority (SWA); matriz IPERC maestra; tarjeta STOP e inspecciones de campo. Los demás
 * subdominios (SWA, STOP, inspecciones, IPERC, PTW, ambiental, emergencias, investigaciones) se agregan por tramos.
 */
@Module({
  controllers: [
    EpiController,
    DocumentosController,
    PtwController,
    SwaController,
    IpercController,
    StopController,
    InspeccionesController,
    InvestigacionesController,
    InvestigacionesFormatoController,
    InvestigacionesCausasController,
    InvestigacionesAccionesController,
    InvestigacionesCierreController,
    RequisitosLegalesController,
  ],
  providers: [
    PrismaService,
    EpiService,
    EpiConsultaService,
    EpiRenglonesService,
    { provide: VerificadorFirmas, useClass: VerificadorFirmasHttp },
    DocumentosPedidoService,
    DocumentosEstadoService,
    PtwService,
    PtwConsultaService,
    SwaService,
    SwaConsultaService,
    IpercService,
    IpercConsultaService,
    IpercCatalogosService,
    StopService,
    StopConsultaService,
    InspeccionesService,
    InspeccionesConsultaService,
    PumpingEventosConsumer,
    ArticulosEpiConsumer,
    InvestigacionesService,
    InvestigacionesConsultaService,
    InvestigacionesFormatoService,
    InvestigacionesCausasService,
    InvestigacionesAccionesService,
    InvestigacionesCierreService,
    RequisitosLegalesService,
    RequisitosLegalesConsultaService,
  ],
  exports: [
    EpiService,
    DocumentosPedidoService,
    PtwService,
    SwaService,
    IpercService,
    StopService,
    InspeccionesService,
  ],
})
export class QhseModule {}
