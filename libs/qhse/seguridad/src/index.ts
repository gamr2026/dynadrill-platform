// Única puerta pública del módulo: lo demás (Prisma, DTOs, controllers) es interno.
export { QhseModule } from './qhse.module';
export { EpiService } from './epi/epi.service';
export { PumpingEventosConsumer } from './consumers/pumping-eventos.consumer';
