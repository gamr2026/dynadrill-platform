import { Module } from '@nestjs/common';
import { EncuestasController } from './controllers/encuestas.controller';
import { PrismaService } from './prisma/prisma.service';
import { EncuestasService } from './services/encuestas.service';

/**
 * Encuestas (contenedor plataforma, sección de administración). Dueño exclusivo del schema `encuestas`.
 * Requiere en la app `AppConfigModule` (DATABASE_URL), `CommonModule` y `MessagingModule`.
 */
@Module({
  controllers: [EncuestasController],
  providers: [PrismaService, EncuestasService],
  exports: [EncuestasService],
})
export class EncuestasModule {}
