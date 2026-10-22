import { Module } from '@nestjs/common';
import { EncuestasController } from './controllers/encuestas.controller';
import { InvitacionesController } from './controllers/invitaciones.controller';
import { PublicoController } from './controllers/publico.controller';
import { PrismaService } from './prisma/prisma.service';
import { EncuestasService } from './services/encuestas.service';
import { InvitacionesService } from './services/invitaciones.service';
import { ResponderService } from './services/responder.service';

/**
 * Encuestas (contenedor plataforma, sección de administración). Dueño exclusivo del schema `encuestas`.
 * Requiere en la app `AppConfigModule` (DATABASE_URL), `CommonModule` y `MessagingModule`.
 * Los controladores de rutas fijas (`publico`, `invitaciones`) van antes que el de `:id` para que ninguno lo pise.
 */
@Module({
  controllers: [PublicoController, InvitacionesController, EncuestasController],
  providers: [PrismaService, EncuestasService, InvitacionesService, ResponderService],
  exports: [EncuestasService, InvitacionesService],
})
export class EncuestasModule {}
