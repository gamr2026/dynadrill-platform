import { Module } from '@nestjs/common';
import { PumpingEventosConsumer } from './consumers/pumping-eventos.consumer';
import { EpiConsultaService } from './epi/epi-consulta.service';
import { EpiController } from './epi/epi.controller';
import { EpiRenglonesService } from './epi/epi-renglones.service';
import { EpiService } from './epi/epi.service';
import { PrismaService } from './prisma/prisma.service';

/**
 * QHSE (contenedor qhse). Dueño exclusivo del schema `qhse`. Requiere en la app `AppConfigModule` (DATABASE_URL),
 * `CommonModule` y `MessagingModule`.
 *
 * Tramo Q1: entrega de EPI (solicitar, aprobar o rechazar, despachar) y la referencia de los tickets que la originan. Los demás
 * subdominios (SWA, STOP, inspecciones, IPERC, PTW, ambiental, emergencias, investigaciones) se agregan por tramos.
 */
@Module({
  controllers: [EpiController],
  providers: [
    PrismaService,
    EpiService,
    EpiConsultaService,
    EpiRenglonesService,
    PumpingEventosConsumer,
  ],
  exports: [EpiService],
})
export class QhseModule {}
