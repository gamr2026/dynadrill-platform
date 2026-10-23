import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ArchivosModule } from '@dyn/archivos';
import { AuditoriaModule } from '@dyn/auditoria';
import { AvisosModule } from '@dyn/avisos';
import { AppConfigModule } from '@dyn/config';
import { FirmasModule } from '@dyn/firmas';
import { CatalogosModule } from '@dyn/catalogos';
import { CommonModule } from '@dyn/common';
import { IdentidadModule } from '@dyn/identidad';
import { IntegracionesModule } from '@dyn/integraciones';
import { MessagingModule } from '@dyn/messaging';
import { DestinatariosIdentidadAdapter } from './avisos/destinatarios-identidad.adapter';
import { VerificadorFirmaArchivosAdapter } from './firmas/verificador-firma-archivos.adapter';
import { DiagnosticoModule } from './diagnostico/diagnostico.module';
import { PlataformaEnv, plataformaEnvSchema } from './env';

const envFiles = ['apps/plataforma/.env', '.env'];

/**
 * Contenedor `plataforma`: identidad, catálogos e integraciones (hechos), archivos, firmas, auditoría y avisos
 * (se agregan por etapas). El módulo de diagnóstico de F0 solo existe con DIAGNOSTICO_ENABLED=true.
 */
@Module({
  imports: [
    AppConfigModule.forRoot(plataformaEnvSchema, envFiles),
    CommonModule.forRoot({ serviceName: 'plataforma' }),
    MessagingModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (cfg: ConfigService<PlataformaEnv, true>) => ({
        container: 'plataforma',
        schema: 'msg_plataforma',
        rabbitUrl: cfg.get('RABBITMQ_URL', { infer: true }),
        databaseUrl: cfg.get('DATABASE_URL', { infer: true }),
        relay: {
          enabled: cfg.get('OUTBOX_RELAY_ENABLED', { infer: true }),
          intervalMs: cfg.get('OUTBOX_RELAY_INTERVAL_MS', { infer: true }),
        },
      }),
    }),
    IdentidadModule,
    IntegracionesModule,
    CatalogosModule,
    ArchivosModule,
    AvisosModule.forRoot({
      imports: [IdentidadModule],
      destinatarios: DestinatariosIdentidadAdapter,
    }),
    AuditoriaModule,
    FirmasModule.forRoot({
      imports: [ArchivosModule],
      verificador: VerificadorFirmaArchivosAdapter,
    }),
    ...(process.env['DIAGNOSTICO_ENABLED'] === 'true' ? [DiagnosticoModule] : []),
  ],
})
export class AppModule {}
