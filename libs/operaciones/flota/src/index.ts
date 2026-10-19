// Única puerta pública del módulo: lo demás (Prisma, DTOs, controllers) es interno. Mantenimiento y el resto de los módulos de
// operaciones usan estos servicios; nadie escribe las tablas de `flota`.
export { FlotaModule } from './flota.module';
export { AsignacionPumpingConsumer } from './consumers/asignacion-pumping.consumer';
export { UnidadesService } from './services/unidades.service';
export {
  LecturasService,
  LECTURA_DE_TIPO,
  type ActorLectura,
  type LecturaEntrada,
} from './services/lecturas.service';
export {
  ConductoresService,
  estadoDeDocumento,
  hoyEcuador,
  type EstadoDocumento,
} from './services/conductores.service';
export { PreventivosService, type PreventivoEntrada } from './services/preventivos.service';
export { calcularAlertas, type AlertaPreventiva, type NivelAlerta } from './catalog/alertas';
