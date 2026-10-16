import {
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, PoolClient } from 'pg';
import { currentTraceparent, runInEventSpan } from '@dyn/common';
import { EventBus, EventEnvelope, SqlExecutor, toPgConnectionString } from '@dyn/messaging';
import type { PlataformaEnv } from '../env';

const SCHEMA = 'msg_plataforma';

const asExecutor = (client: PoolClient): SqlExecutor => ({
  $executeRawUnsafe: async (query, ...values) =>
    (await client.query(query, values as unknown[])).rowCount ?? 0,
});

/**
 * Recorrido de punta a punta de un evento, sin lógica de negocio: una petición HTTP guarda el
 * evento en el outbox (transacción), el relay lo publica a RabbitMQ y este mismo contenedor lo
 * consume registrándolo en el inbox. La traza HTTP continúa en el consumidor vía `traceparent`.
 */
@Injectable()
export class DiagnosticoService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(DiagnosticoService.name);
  private readonly pool: Pool;

  constructor(
    cfg: ConfigService<PlataformaEnv, true>,
    private readonly bus: EventBus,
  ) {
    this.pool = new Pool({
      connectionString: toPgConnectionString(cfg.get('DATABASE_URL', { infer: true })),
      max: 2,
    });
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.bus.subscribe({
      source: 'plataforma',
      patterns: ['plataforma.diagnostico.*'],
      handler: (event) => this.consumir(event),
    });
  }

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }

  /** Guarda un evento de prueba en el outbox, dentro de una transacción. */
  async emitir(actor: { userId: string; role: string }, correlationId?: string) {
    const event = this.bus.create({
      type: 'plataforma.diagnostico.emitido',
      subject: { type: 'diagnostico', id: actor.userId },
      data: { nota: 'evento de prueba de F0' },
      actor,
      correlationId,
      traceparent: currentTraceparent(),
    });
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.bus.publish(asExecutor(client), event);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
    return { eventId: event.id, type: event.type };
  }

  private async consumir(event: EventEnvelope): Promise<void> {
    await runInEventSpan(`consume ${event.type}`, event.traceparent, async () => {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const procesado = await this.bus.handleOnce(asExecutor(client), event, async () => {
          this.logger.log(`Evento ${event.type} (${event.id}) procesado`);
        });
        await client.query('COMMIT');
        if (!procesado) this.logger.warn(`Evento ${event.id} duplicado: se ignora`);
      } catch (e) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw e;
      } finally {
        client.release();
      }
    });
  }

  /** Estado del evento en el outbox (publicación) y en el inbox (procesamiento). */
  async estado(eventId: string) {
    const out = await this.pool.query(
      `SELECT publicado_at, intentos, ultimo_error FROM ${SCHEMA}.outbox WHERE id = $1`,
      [eventId],
    );
    if (out.rowCount === 0) throw new NotFoundException('El evento no existe en el outbox');
    const inbox = await this.pool.query(`SELECT procesado_at FROM ${SCHEMA}.inbox WHERE id = $1`, [
      eventId,
    ]);
    return {
      eventId,
      publicado: out.rows[0].publicado_at !== null,
      publicadoAt: out.rows[0].publicado_at,
      intentos: out.rows[0].intentos,
      ultimoError: out.rows[0].ultimo_error,
      procesado: inbox.rowCount === 1,
      procesadoAt: inbox.rows[0]?.procesado_at ?? null,
    };
  }
}
