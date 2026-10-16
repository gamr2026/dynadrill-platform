import { DynamicModule, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { z } from 'zod';
import { validateEnv } from './env';

/**
 * Registra `@nestjs/config` como global con validación estricta.
 *
 * @example
 *   const envSchema = defineEnv(baseEnvSchema, databaseEnvSchema);
 *   export type Env = z.infer<typeof envSchema>;
 *   @Module({ imports: [AppConfigModule.forRoot(envSchema)] })
 *
 * Luego, en un servicio: `constructor(private cfg: ConfigService<Env, true>)` y
 * `this.cfg.get('PORT', { infer: true })`.
 */
@Module({})
export class AppConfigModule {
  static forRoot(schema: z.ZodTypeAny, envFilePath?: string | string[]): DynamicModule {
    return {
      module: AppConfigModule,
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          envFilePath,
          cache: true,
          validate: (raw) => validateEnv(schema, raw) as Record<string, unknown>,
        }),
      ],
    };
  }
}
