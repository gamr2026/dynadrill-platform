import { Logger } from '@nestjs/common';
import type { Pool } from 'pg';
import type { EventEnvelope } from './envelope';
import type { EventTransport } from './transport';

export interface OutboxRelayOptions {
  /** `msg_<contenedor>`. */
  schema: string;
  pool: Pool;
  transport: EventTransport;
  intervalMs?: number;
  batchSize?: number;
  /** Tras estos intentos fallidos el evento deja de reintentarse y dispara alerta (documento: 10). */
  maxAttempts?: number;
}

/**
 * Lee el outbox del contenedor y publica al transporte. `FOR UPDATE SKIP LOCKED` permite varias
 * réplicas del contenedor sin publicar dos veces el mismo evento. Es "al menos una vez":
 * si el proceso cae entre publicar y marcar, el evento se reenvía y el consumidor lo descarta
 * gracias al inbox.
 */
export class OutboxRelay {
  private readonly logger = new Logger(OutboxRelay.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  private stopped = true;

  constructor(private readonly opts: OutboxRelayOptions) {
    if (!/^msg_[a-z_]+$/.test(opts.schema))
      throw new Error(`Schema de mensajería inválido: ${opts.schema}`);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    const loop = async () => {
      if (this.stopped) return;
      try {
        await this.tick();
      } catch (e) {
        this.logger.error(`Relay del outbox: ${(e as Error).message}`);
      }
      if (!this.stopped) this.timer = setTimeout(loop, this.opts.intervalMs ?? 1000);
    };
    void loop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    while (this.running) await new Promise((r) => setTimeout(r, 20));
  }

  /** Procesa un lote; devuelve cuántos eventos se publicaron. Público para pruebas. */
  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    const { schema, pool, transport } = this.opts;
    const client = await pool.connect();
    let published = 0;
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ id: string; datos: EventEnvelope; intentos: number }>(
        `SELECT id, datos, intentos FROM ${schema}.outbox
          WHERE publicado_at IS NULL AND intentos < $1
          ORDER BY ocurrido_at, id
          LIMIT $2
          FOR UPDATE SKIP LOCKED`,
        [this.opts.maxAttempts ?? 10, this.opts.batchSize ?? 50],
      );
      for (const row of rows) {
        try {
          await transport.publish(row.datos);
          await client.query(`UPDATE ${schema}.outbox SET publicado_at = now() WHERE id = $1`, [
            row.id,
          ]);
          published += 1;
        } catch (e) {
          await client.query(
            `UPDATE ${schema}.outbox SET intentos = intentos + 1, ultimo_error = $2 WHERE id = $1`,
            [row.id, String((e as Error).message).slice(0, 1000)],
          );
          this.logger.warn(
            `No se pudo publicar ${row.id} (intento ${row.intentos + 1}): ${(e as Error).message}`,
          );
        }
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
      this.running = false;
    }
    return published;
  }

  /** Elimina eventos ya publicados con más de `days` días (documento: limpieza > 30 días). */
  async purgePublished(days = 30): Promise<number> {
    const res = await this.opts.pool.query(
      `DELETE FROM ${this.opts.schema}.outbox WHERE publicado_at < now() - ($1 || ' days')::interval`,
      [String(days)],
    );
    return res.rowCount ?? 0;
  }
}
