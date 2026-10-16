import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfigModule } from '@dyn/config';
import { CommonModule } from '@dyn/common';
import { MessagingModule } from '@dyn/messaging';
import { PumpingModule } from '@dyn/pumping';
import { OperacionesEnv, operacionesEnvSchema } from './env';

const envFiles = ['apps/operaciones/.env', '.env'];

/**
 * Contenedor `operaciones`: la parte operativa (Pumping, FCR, flota, mantenimiento e inventario), que se migra por
 * módulos. Hoy: Pumping recibe los pedidos abiertos de la línea y los entrega al Jefe de Base.
 */
@Module({
  imports: [
    AppConfigModule.forRoot(operacionesEnvSchema, envFiles),
    CommonModule.forRoot({ serviceName: 'operaciones' }),
    MessagingModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (cfg: ConfigService<OperacionesEnv, true>) => ({
        container: 'operaciones',
        schema: 'msg_operaciones',
        rabbitUrl: cfg.get('RABBITMQ_URL', { infer: true }),
        databaseUrl: cfg.get('DATABASE_URL', { infer: true }),
        relay: {
          enabled: cfg.get('OUTBOX_RELAY_ENABLED', { infer: true }),
          intervalMs: cfg.get('OUTBOX_RELAY_INTERVAL_MS', { infer: true }),
        },
      }),
    }),
    PumpingModule,
  ],
})
export class AppModule {}
