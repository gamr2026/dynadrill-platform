import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { toPgConnectionString } from '@dyn/messaging';
import { PrismaClient } from '../generated/client';

/** Schema PostgreSQL dueño de este módulo. Ningún otro módulo lee ni escribe estas tablas. */
export const IDENTIDAD_SCHEMA = 'identidad';

/**
 * Cliente Prisma del módulo, sobre el adaptador `pg` (sin motor binario). Conecta como
 * `app_plataforma`, normalmente a través de PgBouncer.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(cfg: ConfigService) {
    super({
      adapter: new PrismaPg(
        { connectionString: toPgConnectionString(cfg.getOrThrow<string>('DATABASE_URL')), max: 5 },
        { schema: IDENTIDAD_SCHEMA },
      ),
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
