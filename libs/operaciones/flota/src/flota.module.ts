import { Module } from '@nestjs/common';
import { UnidadesController } from './controllers/unidades.controller';
import { PrismaService } from './prisma/prisma.service';
import { LecturasService } from './services/lecturas.service';
import { PreventivosService } from './services/preventivos.service';
import { ProveedoresService } from './services/proveedores.service';
import { UnidadesService } from './services/unidades.service';

/**
 * Flota (contenedor operaciones). Dueño exclusivo del schema `flota`. Requiere en la app `AppConfigModule` (DATABASE_URL),
 * `CommonModule` y `MessagingModule`.
 *
 * Hoy (F1): unidades, lecturas de horómetro y kilometraje, mantenimiento preventivo con sus alertas y proveedores de mantenimiento.
 * Conductores, inspección de vehículos y gerenciamiento de viaje se agregan por tramos (ver documentacion/modulos/plan-flota.md).
 */
@Module({
  controllers: [UnidadesController],
  providers: [PrismaService, UnidadesService, LecturasService, PreventivosService, ProveedoresService],
  exports: [UnidadesService, LecturasService, PreventivosService],
})
export class FlotaModule {}
