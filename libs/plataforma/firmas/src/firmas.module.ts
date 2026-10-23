import { DynamicModule, Module, Type } from '@nestjs/common';
import { FirmasConsumer } from './consumers/firmas.consumer';
import { FirmasController } from './controllers/firmas.controller';
import { PrismaService } from './prisma/prisma.service';
import { VerificadorFirmaPort } from './puertos/verificador.port';
import { ConsultaService } from './services/consulta.service';
import { RegistradorService } from './services/registrador.service';
import { VerificacionService } from './services/verificacion.service';

export interface FirmasModuleOptions {
  /** Módulos que necesita el adaptador del verificador (p. ej. archivos). */
  imports?: DynamicModule['imports'];
  /** Cómo se lee la firma de un archivo: lo aporta el contenedor, `firmas` no conoce el servicio de `archivos`. */
  verificador: Type<VerificadorFirmaPort>;
}

/**
 * Firmas (contenedor plataforma): evidencia inmutable de las firmas de los documentos de los demás módulos, registrada desde los
 * eventos `<contenedor>.<documento>.firmado`. Dueño exclusivo del schema `firmas`. Requiere en la app `AppConfigModule`,
 * `CommonModule` y `MessagingModule`.
 */
@Module({})
export class FirmasModule {
  static forRoot(o: FirmasModuleOptions): DynamicModule {
    return {
      module: FirmasModule,
      imports: o.imports ?? [],
      controllers: [FirmasController],
      providers: [
        PrismaService,
        RegistradorService,
        ConsultaService,
        VerificacionService,
        FirmasConsumer,
        { provide: VerificadorFirmaPort, useClass: o.verificador },
      ],
    };
  }
}
