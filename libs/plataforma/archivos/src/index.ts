// Única puerta pública del módulo: lo demás (controlador, Prisma, adaptadores) es interno.
export { ArchivosModule } from './archivos.module';
export { archivosEnvSchema, type ArchivosEnv } from './archivos.config';
export { ArchivosService, type ArchivoDto, type ArchivoSubido } from './archivos.service';
export {
  FileStoragePort,
  FirmaVerificadorPort,
  ScannerPort,
  type ResultadoEscaneo,
  type FirmaDigitalVerificada,
  type VerificacionFirma,
  type VerificacionFirmaElectronica,
} from './ports';
