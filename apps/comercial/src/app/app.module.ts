import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfigModule } from '@dyn/config';
import { CommonModule } from '@dyn/common';
import { MessagingModule } from '@dyn/messaging';
import { PedidosModule } from '@dyn/pedidos';
import { ComercialEnv, comercialEnvSchema } from './env';

const envFiles = ['apps/comercial/.env', '.env'];

/**
 * Contenedor `comercial`: pedidos y el resto del ciclo comercial (documentos operativos, prefactura, guía y AOT),
 * que se agregan por fases. Hoy: el motor de documentos y secuenciales.
 */
@Module({
  imports: [
    AppConfigModule.forRoot(comercialEnvSchema, envFiles),
    CommonModule.forRoot({ serviceName: 'comercial' }),
    MessagingModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (cfg: ConfigService<ComercialEnv, true>) => ({
        container: 'comercial',
        schema: 'msg_comercial',
        rabbitUrl: cfg.get('RABBITMQ_URL', { infer: true }),
        databaseUrl: cfg.get('DATABASE_URL', { infer: true }),
        relay: {
          enabled: cfg.get('OUTBOX_RELAY_ENABLED', { infer: true }),
          intervalMs: cfg.get('OUTBOX_RELAY_INTERVAL_MS', { infer: true }),
        },
      }),
    }),
    PedidosModule,
  ],
})
export class AppModule {}
