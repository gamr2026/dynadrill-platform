import { Module } from '@nestjs/common';
import { FirmasConsumer } from './consumers/firmas.consumer';
import { PrismaService } from './prisma/prisma.service';
import { RegistradorService } from './services/registrador.service';

/**
 * Firmas (contenedor plataforma): evidencia inmutable de las firmas de los documentos de los demás módulos, registrada desde los
 * eventos `<contenedor>.<documento>.firmado`. Dueño exclusivo del schema `firmas`. Requiere en la app `AppConfigModule`,
 * `CommonModule` y `MessagingModule`.
 */
@Module({
  providers: [PrismaService, RegistradorService, FirmasConsumer],
})
export class FirmasModule {}
