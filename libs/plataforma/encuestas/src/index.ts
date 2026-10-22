// Única puerta pública del módulo: lo demás (Prisma, DTOs, controllers) es interno.
export { EncuestasModule, type EncuestasModuleOptions } from './encuestas.module';
export { EnvioCorreoPort, type CorreoDeEncuesta } from './puertos/envio-correo.port';
