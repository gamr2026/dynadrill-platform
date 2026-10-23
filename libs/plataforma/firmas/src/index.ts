// Única puerta pública del módulo: lo demás (Prisma, servicios, consumidores) es interno.
export { FirmasModule, type FirmasModuleOptions } from './firmas.module';
export { VerificadorFirmaPort, type LecturaDeFirma } from './puertos/verificador.port';
