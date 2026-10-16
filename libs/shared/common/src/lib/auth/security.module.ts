import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { normalizePem } from '@dyn/config';
import { JwtAuthGuard, RolesGuard } from './guards';

/**
 * Autenticación y autorización globales para un contenedor. Requiere `AppConfigModule` con
 * `jwtVerifyEnvSchema`. Verifica con la clave pública; solo acepta RS256.
 */
@Global()
@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => ({
        publicKey: normalizePem(cfg.getOrThrow<string>('JWT_PUBLIC_KEY')),
        verifyOptions: { algorithms: ['RS256'], issuer: cfg.get<string>('JWT_ISSUER') },
      }),
    }),
  ],
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
  exports: [JwtModule],
})
export class SecurityModule {}
