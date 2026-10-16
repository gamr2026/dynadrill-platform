import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AzureBlobStorage,
  EscanerClamAv,
  FirmasOcrHttp,
  SinEscaner,
  SinVerificadorDeFirmas,
} from './adapters';
import { ArchivosController } from './archivos.controller';
import { ArchivosService } from './archivos.service';
import { PrismaService } from './prisma/prisma.service';
import { FileStoragePort, FirmaVerificadorPort, ScannerPort } from './ports';

/**
 * Archivos: registro y custodia de los archivos de todos los módulos. Dueño exclusivo del schema `archivos`. Requiere
 * en la app `AppConfigModule` (con `archivosEnvSchema`), `CommonModule` y `MessagingModule`. El almacenamiento y el
 * antivirus van detrás de puertos (`FileStoragePort`, `ScannerPort`): pasar a Azure es cambiar configuración.
 */
@Module({
  controllers: [ArchivosController],
  providers: [
    PrismaService,
    {
      provide: FileStoragePort,
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) =>
        new AzureBlobStorage(
          cfg.get<string>('ARCHIVOS_STORAGE_CONNECTION_STRING') ?? 'UseDevelopmentStorage=true',
          cfg.get<string>('ARCHIVOS_CONTAINER') ?? 'archivos',
        ),
    },
    {
      provide: ScannerPort,
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) =>
        cfg.get<string>('ARCHIVOS_SCANNER') === 'clamav'
          ? new EscanerClamAv(
              cfg.get<string>('CLAMAV_HOST') ?? 'localhost',
              Number(cfg.get('CLAMAV_PORT') ?? 3310),
            )
          : new SinEscaner(),
    },
    {
      provide: FirmaVerificadorPort,
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => {
        const url = cfg.get<string>('FIRMAS_OCR_URL');
        const llave = cfg.get<string>('FIRMAS_OCR_API_KEY');
        return url && llave
          ? new FirmasOcrHttp(url, llave, Number(cfg.get('FIRMAS_OCR_TIMEOUT_MS') ?? 70_000))
          : new SinVerificadorDeFirmas();
      },
    },
    ArchivosService,
  ],
  exports: [ArchivosService],
})
export class ArchivosModule {}
