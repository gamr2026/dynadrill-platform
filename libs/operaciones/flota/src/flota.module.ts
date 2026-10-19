import { Module } from '@nestjs/common';
import { AsignacionPumpingConsumer } from './consumers/asignacion-pumping.consumer';
import { InspeccionesController } from './controllers/inspecciones.controller';
import { ViajesController } from './controllers/viajes.controller';
import { UnidadesController } from './controllers/unidades.controller';
import { PrismaService } from './prisma/prisma.service';
import { ConductoresService } from './services/conductores.service';
import { InspeccionesService } from './services/inspecciones.service';
import { LecturasService } from './services/lecturas.service';
import { PreventivosService } from './services/preventivos.service';
import { ProveedoresService } from './services/proveedores.service';
import { UnidadesService } from './services/unidades.service';
import { ViajesService } from './services/viajes.service';

/**
 * Flota (contenedor operaciones). Dueño exclusivo del schema `flota`. Requiere en la app `AppConfigModule` (DATABASE_URL),
 * `CommonModule` y `MessagingModule`.
 *
 * Hoy: unidades, lecturas de horómetro y kilometraje, mantenimiento preventivo con sus alertas y proveedores (F1); documentos de los
 * conductores (F2); inspección de vehículos con su caso por ticket de Pumping (F3). gerenciamiento de viaje con su cuestionario de riesgo (F4).
 * Ver documentacion/modulos/plan-flota.md.
 */
@Module({
  controllers: [UnidadesController, InspeccionesController, ViajesController],
  providers: [
    PrismaService,
    UnidadesService,
    LecturasService,
    PreventivosService,
    ProveedoresService,
    ConductoresService,
    InspeccionesService,
    ViajesService,
    AsignacionPumpingConsumer,
  ],
  exports: [UnidadesService, LecturasService, PreventivosService, ConductoresService],
})
export class FlotaModule {}
