/**
 * Integración real: Postgres (docker compose) + RabbitMQ.
 *   npm run infra:up
 *   RUN_INTEGRATION=1 npx nx test messaging
 * Sin RUN_INTEGRATION se omite (CI de unitarias no levanta infraestructura).
 */
import * as amqp from 'amqplib';
import { Pool, PoolClient } from 'pg';
import { createEvent, EventEnvelope } from './envelope';
import { OutboxRelay } from './outbox-relay';
import { runOnce, SqlExecutor, writeOutbox } from './outbox';
import { dlqOf, MAX_DELIVERIES, RabbitMqTransport } from './rabbitmq.transport';

const run = process.env['RUN_INTEGRATION'] ? describe : describe.skip;

const ADMIN_URL =
  process.env['TEST_ADMIN_DATABASE_URL'] ??
  'postgresql://postgres:dev_postgres_superuser@localhost:5433/dynadrill';
const RABBIT_URL =
  process.env['TEST_RABBITMQ_URL'] ?? 'amqp://dynadrill:dev_rabbitmq@localhost:5672';
const SCHEMA = 'msg_test';

const executor = (c: PoolClient): SqlExecutor => ({
  $executeRawUnsafe: async (q, ...v) => (await c.query(q, v as unknown[])).rowCount ?? 0,
});

const waitFor = async (cond: () => boolean | Promise<boolean>, ms = 10000) => {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > ms) throw new Error('timeout esperando la condición');
    await new Promise((r) => setTimeout(r, 50));
  }
};

run('outbox → RabbitMQ → inbox (infraestructura real)', () => {
  jest.setTimeout(40000);
  const pool = new Pool({ connectionString: ADMIN_URL, max: 4 });
  const consumer = `it${Date.now()}`;
  const transport = new RabbitMqTransport(RABBIT_URL);
  const dlqTransport = new RabbitMqTransport(RABBIT_URL, { retryBaseMs: 5, retryMaxMs: 20 });
  let relay: OutboxRelay;

  const evento = (type = 'comercial.pedido.abierto'): EventEnvelope =>
    createEvent({
      type,
      source: 'comercial',
      subject: { type: 'pedido', id: '0192f7a4-5c1e-7b3a-9e21-8d4c6a1f0b77' },
      data: { n: 1 },
    });

  const publicadoAt = async (id: string) =>
    (await pool.query(`SELECT publicado_at FROM ${SCHEMA}.outbox WHERE id = $1`, [id])).rows[0]
      ?.publicado_at;

  const guardarEnTx = async (e: EventEnvelope, commit: boolean) => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await writeOutbox(executor(c), SCHEMA, e);
      await c.query(commit ? 'COMMIT' : 'ROLLBACK');
    } finally {
      c.release();
    }
  };

  beforeAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pool.query(`CREATE SCHEMA ${SCHEMA}`);
    await pool.query(`CREATE TABLE ${SCHEMA}.outbox (
      id uuid PRIMARY KEY, tipo text NOT NULL, version_evento smallint NOT NULL, datos jsonb NOT NULL,
      ocurrido_at timestamptz NOT NULL DEFAULT now(), publicado_at timestamptz,
      intentos integer NOT NULL DEFAULT 0, ultimo_error text)`);
    await pool.query(
      `CREATE TABLE ${SCHEMA}.inbox (id uuid PRIMARY KEY, tipo text NOT NULL, procesado_at timestamptz NOT NULL DEFAULT now())`,
    );
    relay = new OutboxRelay({ schema: SCHEMA, pool, transport });
  });

  afterAll(async () => {
    await relay.stop();
    await transport.close();
    await dlqTransport.close();
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    const conn = await amqp.connect(RABBIT_URL);
    const ch = await conn.createChannel();
    for (const q of [
      `${consumer}.comercial`,
      dlqOf(consumer, 'comercial'),
      `${consumer}b.comercial`,
      dlqOf(`${consumer}b`, 'comercial'),
    ]) {
      await ch.deleteQueue(q).catch(() => undefined);
    }
    await conn.close();
    await pool.end();
  });

  it('un evento confirmado llega al consumidor una sola vez y queda marcado como publicado', async () => {
    const recibidos: EventEnvelope[] = [];
    let efectos = 0;
    await transport.subscribe({
      consumer,
      source: 'comercial',
      patterns: ['comercial.pedido.*'],
      handler: async (ev) => {
        const c = await pool.connect();
        try {
          await c.query('BEGIN');
          await runOnce(executor(c), SCHEMA, ev, async () => void (efectos += 1));
          await c.query('COMMIT');
        } finally {
          c.release();
        }
        recibidos.push(ev);
      },
    });

    const e = evento();
    await guardarEnTx(e, true);
    expect(await publicadoAt(e.id)).toBeNull();

    expect(await relay.tick()).toBe(1);
    await waitFor(() => recibidos.length >= 1);
    expect(recibidos[0]).toMatchObject({ id: e.id, type: 'comercial.pedido.abierto', version: 1 });
    expect(await publicadoAt(e.id)).not.toBeNull();

    // el relay no lo vuelve a publicar
    expect(await relay.tick()).toBe(0);

    // entrega duplicada (reintento del broker): el inbox impide repetir el efecto
    await transport.publish(e);
    await waitFor(() => recibidos.length >= 2);
    expect(efectos).toBe(1);
  });

  it('si la transacción de negocio se revierte, el evento no existe', async () => {
    const e = evento();
    await guardarEnTx(e, false);
    const { rowCount } = await pool.query(`SELECT 1 FROM ${SCHEMA}.outbox WHERE id = $1`, [e.id]);
    expect(rowCount).toBe(0);
  });

  it('un evento de otro patrón no llega a un consumidor que no lo pidió', async () => {
    const otros: string[] = [];
    await transport.subscribe({
      consumer: `${consumer}b`,
      source: 'comercial',
      patterns: ['comercial.prefactura.*'],
      handler: async (ev) => void otros.push(ev.type),
    });
    const e = evento('comercial.pedido.anulado');
    await guardarEnTx(e, true);
    await relay.tick();
    await new Promise((r) => setTimeout(r, 800));
    expect(otros).toEqual([]);
  });

  it('un mensaje que siempre falla termina en la DLQ tras el límite de entregas', async () => {
    let intentos = 0;
    await dlqTransport.subscribe({
      consumer: `${consumer}c`,
      source: 'comercial',
      patterns: ['comercial.ticket.*'],
      handler: async () => {
        intentos += 1;
        throw new Error('fallo simulado');
      },
    });
    const e = evento('comercial.ticket.creado');
    await guardarEnTx(e, true);
    await relay.tick();

    const conn = await amqp.connect(RABBIT_URL);
    const ch = await conn.createChannel();
    try {
      await waitFor(
        async () => (await ch.checkQueue(dlqOf(`${consumer}c`, 'comercial'))).messageCount >= 1,
        30000,
      );
      expect(intentos).toBe(MAX_DELIVERIES);
    } finally {
      await ch.deleteQueue(`${consumer}c.comercial`).catch(() => undefined);
      await ch.deleteQueue(dlqOf(`${consumer}c`, 'comercial')).catch(() => undefined);
      await conn.close();
    }
  });
});
