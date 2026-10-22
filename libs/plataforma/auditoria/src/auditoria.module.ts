import { Module } from '@nestjs/common';
import { AuditoriaConsumer } from './consumers/auditoria.consumer';
import { PrismaService } from './prisma/prisma.service';
import { ProyectorService } from './services/proyector.service';

/**
 * Auditoría (contenedor plataforma): registro central e inmutable de los hechos de negocio, proyectado desde los eventos de todos
 * los contenedores. Dueño exclusivo del schema `auditoria`. Requiere en la app `AppConfigModule`, `CommonModule` y `MessagingModule`.
 */
@Module({
  providers: [PrismaService, ProyectorService, AuditoriaConsumer],
})
export class AuditoriaModule {}
