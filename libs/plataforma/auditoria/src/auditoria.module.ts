import { Module } from '@nestjs/common';
import { AuditoriaController } from './controllers/auditoria.controller';
import { AuditoriaConsumer } from './consumers/auditoria.consumer';
import { PrismaService } from './prisma/prisma.service';
import { ConsultaService } from './services/consulta.service';
import { ProyectorService } from './services/proyector.service';

/**
 * Auditoría (contenedor plataforma): registro central e inmutable de los hechos de negocio, proyectado desde los eventos de todos
 * los contenedores. Dueño exclusivo del schema `auditoria`. Requiere en la app `AppConfigModule`, `CommonModule` y `MessagingModule`.
 */
@Module({
  controllers: [AuditoriaController],
  providers: [PrismaService, ProyectorService, ConsultaService, AuditoriaConsumer],
})
export class AuditoriaModule {}
