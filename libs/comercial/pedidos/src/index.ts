// Única puerta pública del módulo: lo demás (Prisma, DTOs, controllers) es interno.
export { PedidosModule } from './pedidos.module';
export { SecuenciasService, type Emision, type EmitirParams } from './services/secuencias.service';
export { formatearCodigo } from './secuencias/formato';
export { PedidosService, PROCESO_PEDIDO, type Contexto } from './services/pedidos.service';
export { WorkflowService } from './workflow/workflow.service';
export { DirectorioPort } from './directorio/directorio.port';
