import { DynamicModule, Module, Type } from '@nestjs/common';
import { CierreFcrConsumer } from './consumers/cierre-fcr.consumer';
import { EncuestasController } from './controllers/encuestas.controller';
import { InvitacionesController } from './controllers/invitaciones.controller';
import { PublicoController } from './controllers/publico.controller';
import { PrismaService } from './prisma/prisma.service';
import { EnvioCorreoPort } from './puertos/envio-correo.port';
import { EncuestasService } from './services/encuestas.service';
import { EnviosService } from './services/envios.service';
import { InvitacionesService } from './services/invitaciones.service';
import { ResponderService } from './services/responder.service';

export interface EncuestasModuleOptions {
  /** Módulos que necesita el adaptador de correo (p. ej. el de avisos). */
  imports?: DynamicModule['imports'];
  /** Cómo sale un correo: lo aporta el contenedor con el módulo de avisos; `encuestas` no conoce a `avisos`. */
  envio: Type<EnvioCorreoPort>;
}

/**
 * Encuestas (contenedor plataforma, sección de administración). Dueño exclusivo del schema `encuestas`.
 * Requiere en la app `AppConfigModule` (DATABASE_URL), `CommonModule` y `MessagingModule`.
 * Los controladores de rutas fijas (`publico`, `invitaciones`) van antes que el de `:id` para que ninguno lo pise.
 * Al cerrar un ticket de FCR recibe el evento con el correo del cliente y le envía la encuesta de satisfacción.
 */
@Module({})
export class EncuestasModule {
  static forRoot(o: EncuestasModuleOptions): DynamicModule {
    return {
      module: EncuestasModule,
      imports: o.imports ?? [],
      controllers: [PublicoController, InvitacionesController, EncuestasController],
      providers: [
        PrismaService,
        EncuestasService,
        InvitacionesService,
        ResponderService,
        EnviosService,
        CierreFcrConsumer,
        { provide: EnvioCorreoPort, useClass: o.envio },
      ],
      exports: [EncuestasService, InvitacionesService],
    };
  }
}
