// Única puerta pública del módulo: lo demás (Prisma, DTOs, controllers) es interno.
export { PumpingModule } from './pumping.module';
export { TicketsService, type PedidoAbiertoData } from './services/tickets.service';
export { PedidosAbiertosConsumer } from './consumers/pedidos-abiertos.consumer';
export { RequisitosExternosConsumer } from './consumers/requisitos-externos.consumer';
