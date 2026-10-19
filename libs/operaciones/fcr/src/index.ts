// Única puerta pública del módulo: lo demás (Prisma, DTOs, controllers) es interno.
export { FcrModule } from './fcr.module';
export { TicketsService, type PedidoAbiertoData } from './services/tickets.service';
export { PedidosAbiertosConsumer } from './consumers/pedidos-abiertos.consumer';
