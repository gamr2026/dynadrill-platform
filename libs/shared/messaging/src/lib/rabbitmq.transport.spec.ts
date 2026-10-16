/**
 * Regresión de una condición de carrera: publicar y suscribirse al arrancar abrían DOS conexiones a RabbitMQ;
 * la segunda sobrescribía a la primera y `close()` solo cerraba la última. La otra quedaba huérfana y el proceso
 * no terminaba (en las pruebas, `plataforma:test` se colgaba de forma intermitente).
 */
import * as amqp from 'amqplib';
import { createEvent } from './envelope';
import { RabbitMqTransport } from './rabbitmq.transport';

jest.mock('amqplib', () => ({ connect: jest.fn() }));

interface FakeConnection {
  on: jest.Mock;
  createConfirmChannel: jest.Mock;
  close: jest.Mock;
}

const evento = createEvent({
  type: 'plataforma.usuario.actualizado',
  source: 'plataforma',
  subject: { type: 'usuario', id: '0192f7a4-5c1e-7b3a-9e21-8d4c6a1f0b77' },
  data: {},
});

describe('RabbitMqTransport: una sola conexión', () => {
  let conexiones: FakeConnection[];
  const connect = amqp.connect as unknown as jest.Mock;

  const nuevaConexion = (demoraMs = 0): FakeConnection => {
    const canal = {
      assertExchange: jest.fn().mockResolvedValue(undefined),
      publish: jest.fn(),
      waitForConfirms: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
    };
    const c: FakeConnection = {
      on: jest.fn(),
      createConfirmChannel: jest
        .fn()
        .mockImplementation(() => new Promise((r) => setTimeout(() => r(canal), demoraMs))),
      close: jest.fn().mockResolvedValue(undefined),
    };
    conexiones.push(c);
    return c;
  };

  beforeEach(() => {
    conexiones = [];
    connect.mockReset();
    connect.mockImplementation(async () => {
      // abrir tarda: da tiempo a que lleguen otras llamadas mientras tanto
      await new Promise((r) => setTimeout(r, 20));
      return nuevaConexion(20);
    });
  });

  it('varias llamadas simultáneas comparten UNA conexión y close() la cierra', async () => {
    const t = new RabbitMqTransport('amqp://x');
    await Promise.all([t.publish(evento), t.publish(evento), t.publish(evento)]);

    expect(connect).toHaveBeenCalledTimes(1);
    await t.close();
    expect(conexiones).toHaveLength(1);
    expect(conexiones[0].close).toHaveBeenCalledTimes(1);
  });

  it('close() espera a una apertura en curso en vez de dejar esa conexión abierta', async () => {
    const t = new RabbitMqTransport('amqp://x');
    const publicando = t.publish(evento).catch(() => undefined);
    await t.close(); // llega mientras todavía se está abriendo
    await publicando;

    expect(conexiones.length).toBeGreaterThanOrEqual(1);
    for (const c of conexiones) expect(c.close).toHaveBeenCalled(); // ninguna queda abierta
  });

  it('si falla al preparar el canal, la conexión a medio abrir se cierra y se puede reintentar', async () => {
    connect.mockReset();
    connect.mockImplementationOnce(async () => {
      const c = nuevaConexion();
      c.createConfirmChannel.mockRejectedValueOnce(new Error('canal no disponible'));
      return c;
    });
    const t = new RabbitMqTransport('amqp://x');

    await expect(t.publish(evento)).rejects.toThrow('canal no disponible');
    expect(conexiones[0].close).toHaveBeenCalledTimes(1);

    connect.mockImplementationOnce(async () => nuevaConexion());
    await t.publish(evento); // reintenta con una conexión nueva
    expect(connect).toHaveBeenCalledTimes(2);
    await t.close();
  });
});
