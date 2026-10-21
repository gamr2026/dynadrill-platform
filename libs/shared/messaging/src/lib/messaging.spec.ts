import { createEvent, routingKeyOf } from './envelope';
import { InMemoryTransport } from './in-memory.transport';
import { runOnce, SqlExecutor, writeOutbox } from './outbox';
import { claveInbox, toPgConnectionString } from './messaging.module';
import { backoffMs } from './rabbitmq.transport';

const base = {
  type: 'comercial.pedido.abierto',
  source: 'comercial',
  subject: { type: 'pedido', id: '0192f7a4-5c1e-7b3a-9e21-8d4c6a1f0b77' },
  data: { lineaServicio: 'pumping' },
};

describe('createEvent', () => {
  it('arma el sobre estándar con id UUIDv7 y versión 1 por defecto', () => {
    const e = createEvent(base);
    expect(e.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab]/);
    expect(e).toMatchObject({ type: 'comercial.pedido.abierto', version: 1, source: 'comercial' });
    expect(Date.parse(e.occurredAt)).not.toBeNaN();
    expect(routingKeyOf(e)).toBe('comercial.pedido.abierto.v1');
  });

  it('rechaza nombres mal formados y productor que no coincide', () => {
    expect(() => createEvent({ ...base, type: 'PedidoAbierto' })).toThrow(/inválido/);
    expect(() => createEvent({ ...base, type: 'comercial.abierto' })).toThrow(/inválido/);
    expect(() => createEvent({ ...base, source: 'qhse' })).toThrow(/contenedor productor/);
  });
});

class FakeExecutor implements SqlExecutor {
  calls: Array<{ query: string; values: unknown[] }> = [];
  constructor(private readonly affected = 1) {}
  async $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number> {
    this.calls.push({ query, values });
    return this.affected;
  }
}

describe('outbox / inbox', () => {
  it('writeOutbox inserta el sobre completo en el schema del contenedor', async () => {
    const tx = new FakeExecutor();
    const e = createEvent(base);
    await writeOutbox(tx, 'msg_comercial', e);
    expect(tx.calls[0].query).toContain('INSERT INTO msg_comercial.outbox');
    expect(tx.calls[0].values[0]).toBe(e.id);
    expect(JSON.parse(tx.calls[0].values[3] as string)).toEqual(e);
  });

  it('rechaza schemas que no sean de mensajería (evita inyección por nombre)', async () => {
    const e = createEvent(base);
    await expect(writeOutbox(new FakeExecutor(), 'comercial; drop table x', e)).rejects.toThrow(
      /inválido/,
    );
    await expect(writeOutbox(new FakeExecutor(), 'identidad', e)).rejects.toThrow(/inválido/);
  });

  it('runOnce ejecuta el efecto la primera vez y lo omite si el evento ya estaba', async () => {
    const effect = jest.fn().mockResolvedValue(undefined);
    const e = createEvent(base);
    expect(await runOnce(new FakeExecutor(1), 'msg_operaciones', e, effect)).toBe(true);
    expect(effect).toHaveBeenCalledTimes(1);
    expect(await runOnce(new FakeExecutor(0), 'msg_operaciones', e, effect)).toBe(false);
    expect(effect).toHaveBeenCalledTimes(1);
  });
});

describe('InMemoryTransport', () => {
  it('entrega solo a suscripciones del productor y patrón que coinciden', async () => {
    const t = new InMemoryTransport();
    const got: string[] = [];
    await t.subscribe({
      consumer: 'operaciones',
      source: 'comercial',
      patterns: ['comercial.pedido.*'],
      handler: async (ev) => void got.push(ev.type),
    });
    await t.publish(createEvent(base));
    await t.publish(createEvent({ ...base, type: 'comercial.prefactura.firmada' }));
    await t.publish(createEvent({ ...base, source: 'qhse', type: 'qhse.pedido.abierto' }));
    expect(got).toEqual(['comercial.pedido.abierto']);
  });
});

describe('toPgConnectionString', () => {
  it('quita los parámetros de Prisma que pg no entiende', () => {
    const url = toPgConnectionString(
      'postgresql://u:p@h:6432/db?schema=msg_x&pgbouncer=true&sslmode=disable',
    );
    expect(url).not.toContain('schema=');
    expect(url).not.toContain('pgbouncer');
    expect(url).toContain('sslmode=disable');
  });
});

describe('backoffMs', () => {
  it('crece al doble en cada intento y respeta el tope', () => {
    expect([1, 2, 3, 4].map((n) => backoffMs(n, 500, 30_000))).toEqual([500, 1000, 2000, 4000]);
    expect(backoffMs(20, 500, 30_000)).toBe(30_000);
  });
});

describe('claveInbox', () => {
  const id = '0192f7a4-5c1e-7b3a-9e21-8d4c6a1f0b77';
  it('es un uuid estable y distinto por grupo, para que cada cola procese el evento una vez', () => {
    const a = claveInbox(id, 'fcr');
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(claveInbox(id, 'fcr')).toBe(a);
    expect(claveInbox(id, 'pumping')).not.toBe(a);
    expect(claveInbox('0192f7a4-5c1e-7b3a-9e21-8d4c6a1f0b78', 'fcr')).not.toBe(a);
  });
});
