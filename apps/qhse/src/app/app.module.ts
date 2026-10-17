import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfigModule } from '@dyn/config';
import { CommonModule } from '@dyn/common';
import { MessagingModule } from '@dyn/messaging';
import { QhseModule } from '@dyn/qhse';
import { QhseEnv, qhseEnvSchema } from './env';

const envFiles = ['apps/qhse/.env', '.env'];

/**
 * Contenedor `qhse`: calidad, salud, seguridad y ambiente. Se construye por tramos (Q1: entrega de EPI y consulta de
 * términos; luego control operativo, IPERC/PTW, ambiental, emergencias y cierre). Un solo schema de datos (`qhse`) y su
 * outbox/inbox (`msg_qhse`).
 */
@Module({
  imports: [
    AppConfigModule.forRoot(qhseEnvSchema, envFiles),
    CommonModule.forRoot({ serviceName: 'qhse' }),
    MessagingModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (cfg: ConfigService<QhseEnv, true>) => ({
        container: 'qhse',
        schema: 'msg_qhse',
        rabbitUrl: cfg.get('RABBITMQ_URL', { infer: true }),
        databaseUrl: cfg.get('DATABASE_URL', { infer: true }),
        relay: {
          enabled: cfg.get('OUTBOX_RELAY_ENABLED', { infer: true }),
          intervalMs: cfg.get('OUTBOX_RELAY_INTERVAL_MS', { infer: true }),
        },
      }),
    }),
    QhseModule,
  ],
})
export class AppModule {}
