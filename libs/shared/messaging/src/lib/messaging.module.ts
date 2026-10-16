import {
  DynamicModule,
  Inject,
  Injectable,
  Module,
  OnApplicationBootstrap,
  OnApplicationShutdown,
  Provider,
} from '@nestjs/common';
import { Pool } from 'pg';
import { EventEnvelope, NewEvent, createEvent } from './envelope';
import { OutboxRelay } from './outbox-relay';
import { SqlExecutor, runOnce, writeOutbox } from './outbox';
import { RabbitMqTransport } from './rabbitmq.transport';
import type { EventTransport, Subscription } from './transport';

export const MESSAGING_OPTIONS = Symbol('MESSAGING_OPTIONS');
export const EVENT_TRANSPORT = Symbol('EVENT_TRANSPORT');
const OUTBOX_RELAY = Symbol('OUTBOX_RELAY');

export interface MessagingModuleOptions {
  /** Contenedor dueño: `plataforma`, `comercial`... */
  container: string;
  /** Schema de mensajería del contenedor: `msg_plataforma`... */
  schema: string;
  rabbitUrl: string;
  /** Conexión del usuario `app_<contenedor>` para el relay (se ignoran los parámetros de Prisma). */
  databaseUrl: string;
  relay?: { enabled?: boolean; intervalMs?: number };
}

/** Quita parámetros propios de Prisma (`schema`, `pgbouncer`) que `pg` no entiende. */
export function toPgConnectionString(url: string): string {
  const u = new URL(url);
  u.searchParams.delete('schema');
  u.searchParams.delete('pgbouncer');
  u.searchParams.delete('connection_limit');
  return u.toString();
}

/** API que usan los módulos de negocio. */
@Injectable()
export class EventBus {
  constructor(
    @Inject(MESSAGING_OPTIONS) private readonly options: MessagingModuleOptions,
    @Inject(EVENT_TRANSPORT) private readonly transport: EventTransport,
  ) {}

  /** Crea el sobre con el contenedor actual como productor. */
  create<T>(input: Omit<NewEvent<T>, 'source'>): EventEnvelope<T> {
    return createEvent({ ...input, source: this.options.container });
  }

  /**
   * Registra el evento en el outbox dentro de la transacción recibida (`tx` de
   * `prisma.$transaction`). El relay lo publica después; nunca se publica directo.
   */
  async publish(tx: SqlExecutor, event: EventEnvelope): Promise<void> {
    await writeOutbox(tx, this.options.schema, event);
  }

  /** Ejecuta `effect` una sola vez por evento (inbox), dentro de la transacción recibida. */
  handleOnce(tx: SqlExecutor, event: EventEnvelope, effect: () => Promise<void>): Promise<boolean> {
    return runOnce(tx, this.options.schema, event, effect);
  }

  subscribe(subscription: Omit<Subscription, 'consumer'>): Promise<void> {
    return this.transport.subscribe({ ...subscription, consumer: this.options.container });
  }
}

@Injectable()
class RelayLifecycle implements OnApplicationBootstrap, OnApplicationShutdown {
  constructor(
    @Inject(MESSAGING_OPTIONS) private readonly options: MessagingModuleOptions,
    @Inject(OUTBOX_RELAY) private readonly relay: OutboxRelay,
    @Inject(EVENT_TRANSPORT) private readonly transport: EventTransport,
    @Inject(Pool) private readonly pool: Pool,
  ) {}

  onApplicationBootstrap(): void {
    if (this.options.relay?.enabled !== false) this.relay.start();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.relay.stop();
    await this.transport.close();
    await this.pool.end();
  }
}

export interface MessagingModuleAsyncOptions {
  inject?: any[]; // eslint-disable-line @typescript-eslint/no-explicit-any
  useFactory: (...args: any[]) => MessagingModuleOptions; // eslint-disable-line @typescript-eslint/no-explicit-any
}

@Module({})
export class MessagingModule {
  /** Opciones conocidas al declarar el módulo (pruebas). */
  static forRoot(options: MessagingModuleOptions): DynamicModule {
    return MessagingModule.build({ provide: MESSAGING_OPTIONS, useValue: options });
  }

  /** Opciones que salen del `ConfigService` ya validado (uso normal en las apps). */
  static forRootAsync(options: MessagingModuleAsyncOptions): DynamicModule {
    return MessagingModule.build({
      provide: MESSAGING_OPTIONS,
      inject: options.inject ?? [],
      useFactory: options.useFactory,
    });
  }

  private static build(optionsProvider: Provider): DynamicModule {
    const providers: Provider[] = [
      optionsProvider,
      {
        provide: EVENT_TRANSPORT,
        inject: [MESSAGING_OPTIONS],
        useFactory: (o: MessagingModuleOptions) => new RabbitMqTransport(o.rabbitUrl),
      },
      {
        provide: Pool,
        inject: [MESSAGING_OPTIONS],
        useFactory: (o: MessagingModuleOptions) =>
          new Pool({ connectionString: toPgConnectionString(o.databaseUrl), max: 2 }),
      },
      {
        provide: OUTBOX_RELAY,
        inject: [MESSAGING_OPTIONS, Pool, EVENT_TRANSPORT],
        useFactory: (o: MessagingModuleOptions, pool: Pool, transport: EventTransport) =>
          new OutboxRelay({
            schema: o.schema,
            pool,
            transport,
            intervalMs: o.relay?.intervalMs,
          }),
      },
      EventBus,
      RelayLifecycle,
    ];
    return {
      module: MessagingModule,
      global: true,
      providers,
      exports: [EventBus, EVENT_TRANSPORT],
    };
  }
}
