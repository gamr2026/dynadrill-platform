// Única puerta pública del módulo: lo demás (servicios, Prisma, DTOs) es interno.
export { IdentidadModule } from './identidad.module';
export { UsuariosPorRolService, type UsuarioDeRol } from './services/usuarios-por-rol.service';
export { identidadEnvSchema, type IdentidadEnv } from './identidad.config';
