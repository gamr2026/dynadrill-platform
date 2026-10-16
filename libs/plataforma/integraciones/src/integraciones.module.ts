import { Module } from '@nestjs/common';
import { As2PedidosController } from './controllers/as2-pedidos.controller';
import { IntegracionesController } from './controllers/integraciones.controller';
import { EnvSecretResolver, SecretResolver } from './engine/secretos';
import { PrismaService } from './prisma/prisma.service';
import { As2PedidosService } from './services/as2-pedidos.service';
import { ConfiguracionService } from './services/configuracion.service';
import { MotorService } from './services/motor.service';

/**
 * Integraciones con terceros: registro en base de datos y motor que lo ejecuta. Dueño exclusivo del schema
 * `integraciones`. Exporta solo `MotorService`: los demás módulos piden "ejecuta tal operación de tal proveedor"
 * y reciben filas ya traducidas a su modelo. Requiere en la app `AppConfigModule` (DATABASE_URL) y `CommonModule`.
 */
@Module({
  controllers: [IntegracionesController, As2PedidosController],
  providers: [
    PrismaService,
    { provide: SecretResolver, useFactory: () => EnvSecretResolver.desdeEntorno() },
    MotorService,
    ConfiguracionService,
    As2PedidosService,
  ],
  exports: [MotorService],
})
export class IntegracionesModule {}
