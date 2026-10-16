// Única puerta pública del módulo: lo demás (servicios de configuración, Prisma, DTOs) es interno.
export { IntegracionesModule } from './integraciones.module';
export {
  MotorService,
  IntegracionError,
  type EjecutarOpciones,
  type ResultadoEjecucion,
} from './services/motor.service';
