import { DynamicModule, Module, Type } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AVISOS_OPCIONES, CorreoSeguroService } from './mail/correo-seguro.service';
import { MailPort } from './mail/mail.port';
import { SmtpMail } from './mail/smtp-mail';
import { AvisosController } from './controllers/avisos.controller';
import { EventosConAvisoConsumer } from './consumers/eventos-con-aviso.consumer';
import { PrismaService } from './prisma/prisma.service';
import { DestinatariosPort } from './puertos/destinatarios.port';
import { AvisosService } from './services/avisos.service';

export interface AvisosModuleOptions {
  /** Módulos que necesita el adaptador de destinatarios (p. ej. identidad). */
  imports?: DynamicModule['imports'];
  /** Cómo se sabe quiénes tienen un rol: lo aporta el contenedor, `avisos` no conoce a `identidad`. */
  destinatarios: Type<DestinatariosPort>;
}

/**
 * Avisos (contenedor plataforma): la campanita y el correo de los hechos del sistema. Dueño exclusivo del schema `avisos`.
 * Requiere en la app `AppConfigModule` (DATABASE_URL + `avisosEnvSchema`), `CommonModule` y `MessagingModule`.
 * Todo correo sale a `MAIL_REDIRECT_TO` mientras el proyecto esté en pruebas.
 */
@Module({})
export class AvisosModule {
  static forRoot(o: AvisosModuleOptions): DynamicModule {
    return {
      module: AvisosModule,
      imports: o.imports ?? [],
      controllers: [AvisosController],
      providers: [
        PrismaService,
        AvisosService,
        CorreoSeguroService,
        EventosConAvisoConsumer,
        { provide: DestinatariosPort, useClass: o.destinatarios },
        {
          provide: AVISOS_OPCIONES,
          inject: [ConfigService],
          useFactory: (cfg: ConfigService) => ({
            redirigirA: cfg.getOrThrow<string>('MAIL_REDIRECT_TO'),
            appUrl: cfg.get<string>('APP_URL') ?? 'http://localhost:4200',
          }),
        },
        {
          provide: MailPort,
          inject: [ConfigService],
          useFactory: (cfg: ConfigService) =>
            new SmtpMail({
              host: cfg.get<string>('SMTP_HOST') ?? 'localhost',
              port: Number(cfg.get<number>('SMTP_PORT') ?? 1025),
              secure: cfg.get<boolean>('SMTP_SECURE') ?? false,
              user: cfg.get<string>('SMTP_USER') || undefined,
              pass: cfg.get<string>('SMTP_PASS') || undefined,
              from: cfg.get<string>('MAIL_FROM') ?? 'Dynadrill <avisos@dynadrill.local>',
            }),
        },
      ],
      exports: [AvisosService],
    };
  }
}
