// Única puerta pública del módulo: lo demás (Prisma, DTOs, controllers) es interno.
export { AvisosModule, type AvisosModuleOptions } from './avisos.module';
export { avisosEnvSchema, type AvisosEnv } from './avisos.config';
export { DestinatariosPort, type Destinatario } from './puertos/destinatarios.port';
export { AvisosService } from './services/avisos.service';
