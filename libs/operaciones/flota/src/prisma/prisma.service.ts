import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { toPgConnectionString } from '@dyn/messaging';
import { PrismaClient } from '../generated/client';

/** Schema PostgreSQL dueño de este módulo. Ningún otro módulo lee ni escribe estas tablas. */
export const FLOTA_SCHEMA = 'flota';

/** Cliente Prisma del módulo, sobre el adaptador `pg`. Conecta como `app_operaciones`, normalmente vía PgBouncer. */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(cfg: ConfigService) {
    super({
      adapter: new PrismaPg(
        { connectionString: toPgConnectionString(cfg.getOrThrow<string>('DATABASE_URL')), max: 5 },
        { schema: FLOTA_SCHEMA },
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
