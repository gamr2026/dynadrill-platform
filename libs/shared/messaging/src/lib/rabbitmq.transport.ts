import { Logger } from '@nestjs/common';
import * as amqp from 'amqplib';
import { EventEnvelope, routingKeyOf } from './envelope';
import type { EventTransport, Subscription } from './transport';

/** Intentos máximos antes de mandar el mensaje a la cola de fallidos (documento: 10). */
export const MAX_DELIVERIES = 10;

export interface RabbitMqTransportOptions {
  /** Intentos totales de entrega antes de la DLQ. */
  maxAttempts?: number;
  /** Espera base del reintento; crece ×2 en cada intento hasta `retryMaxMs`. */
  retryBaseMs?: number;
  retryMaxMs?: number;
}

/** Espera antes del reintento número `attempt` (1 = primer fallo): base·2^(n-1), con tope. */
export function backoffMs(attempt: number, baseMs: number, maxMs: number): number {
  return Math.min(baseMs * 2 ** (attempt - 1), maxMs);
}

export const DLX = 'dyn.dlx';
export const exchangeOf = (source: string) => `dyn.${source}`;
export const queueOf = (consumer: string, source: string) => `${consumer}.${source}`;
export const dlqOf = (consumer: string, source: string) => `dlq.${consumer}.${source}`;

/**
 * Equivalente local de Azure Service Bus:
 *  - un exchange `topic` por contenedor productor (≈ topic),
 *  - una cola durable por contenedor consumidor y productor (≈ suscripción con filtros por patrón),
 *  - cola de fallidos (DLQ) tras `maxAttempts` intentos.
 * El conteo de intentos y la espera creciente los maneja esta clase (cabecera `x-attempt`), no el
 * broker: así el comportamiento no depende de cómo cada versión de RabbitMQ cuenta los reencolados
 * y se traslada tal cual a otro transporte (Service Bus).
 */
export class RabbitMqTransport implements EventTransport {
  private readonly logger = new Logger(RabbitMqTransport.name);
  private connection?: amqp.ChannelModel;
  private channel?: amqp.ConfirmChannel;
  /** Apertura en curso: quien llegue mientras tanto la espera en vez de abrir otra conexión. */
  private abriendo?: Promise<amqp.ConfirmChannel>;

  constructor(
    private readonly url: string,
    private readonly options: RabbitMqTransportOptions = {},
  ) {}

  /**
   * Canal único y compartido. Es seguro ante llamadas simultáneas (publicar y suscribirse al arrancar): todas esperan
   * la MISMA apertura. Antes cada una abría su propia conexión, la última sobrescribía a las demás y `close()` solo
   * cerraba esa; las otras quedaban huérfanas y mantenían vivo el proceso al apagar.
   */
  private ensureChannel(): Promise<amqp.ConfirmChannel> {
    if (this.channel) return Promise.resolve(this.channel);
    this.abriendo ??= this.abrir().finally(() => {
      this.abriendo = undefined;
    });
    return this.abriendo;
  }

  private async abrir(): Promise<amqp.ConfirmChannel> {
    const connection = await amqp.connect(this.url);
    try {
      connection.on('error', (e) => this.logger.error(`Conexión RabbitMQ: ${e.message}`));
      connection.on('close', () => {
        // Solo si sigue siendo la conexión vigente (una anterior que cierra no debe borrar a la nueva).
        if (this.connection === connection) {
          this.channel = undefined;
          this.connection = undefined;
        }
      });
      const channel = await connection.createConfirmChannel();
      await channel.assertExchange(DLX, 'direct', { durable: true });
      this.connection = connection;
      this.channel = channel;
      return channel;
    } catch (e) {
      // No dejar una conexión a medio abrir: mantendría vivo el proceso.
      await connection.close().catch(() => undefined);
      throw e;
    }
  }

  async publish(event: EventEnvelope): Promise<void> {
    const ch = await this.ensureChannel();
    const exchange = exchangeOf(event.source);
    await ch.assertExchange(exchange, 'topic', { durable: true });
    ch.publish(exchange, routingKeyOf(event), Buffer.from(JSON.stringify(event)), {
      persistent: true,
      contentType: 'application/json',
      messageId: event.id,
      type: event.type,
      correlationId: event.correlationId,
      timestamp: Date.parse(event.occurredAt),
      headers: event.traceparent ? { traceparent: event.traceparent } : undefined,
    });
    // el broker debe confirmar la recepción antes de que el relay marque el outbox como publicado
    await ch.waitForConfirms();
  }

  async subscribe(sub: Subscription): Promise<void> {
    const ch = await this.ensureChannel();
    const exchange = exchangeOf(sub.source);
    const queue = queueOf(sub.consumer, sub.source);
    const dlq = dlqOf(sub.consumer, sub.source);

    await ch.assertExchange(exchange, 'topic', { durable: true });
    await ch.assertQueue(dlq, { durable: true, arguments: { 'x-queue-type': 'quorum' } });
    await ch.bindQueue(dlq, DLX, queue);
    await ch.assertQueue(queue, { durable: true, arguments: { 'x-queue-type': 'quorum' } });
    for (const pattern of sub.patterns) {
      // la clave de enrutamiento termina en `.v<versión>`; el patrón de tipo acepta cualquier versión
      await ch.bindQueue(queue, exchange, `${pattern}.*`);
    }

    await ch.prefetch(10);
    await ch.consume(queue, async (msg) => {
      if (!msg) return;
      let event: EventEnvelope;
      try {
        event = JSON.parse(msg.content.toString()) as EventEnvelope;
      } catch {
        this.logger.error(`Mensaje no JSON en ${queue}; se descarta a la DLQ`);
        ch.reject(msg, false);
        return;
      }
      try {
        await sub.handler(event);
        ch.ack(msg);
      } catch (e) {
        await this.retryOrDeadLetter(ch, msg, queue, event, e as Error);
      }
    });
  }

  /**
   * Fallo del consumidor: reintenta con espera creciente o, al agotar los intentos, publica a la DLQ.
   * El original se confirma (ack) solo después de que el reintento o el DLQ quedó aceptado por el
   * broker; si el proceso cae antes, RabbitMQ lo vuelve a entregar con el mismo conteo.
   */
  private async retryOrDeadLetter(
    ch: amqp.ConfirmChannel,
    msg: amqp.ConsumeMessage,
    queue: string,
    event: EventEnvelope,
    error: Error,
  ): Promise<void> {
    const attempt = Number(msg.properties.headers?.['x-attempt'] ?? 0) + 1;
    const maxAttempts = this.options.maxAttempts ?? MAX_DELIVERIES;
    const headers = {
      ...msg.properties.headers,
      'x-attempt': attempt,
      'x-last-error': error.message.slice(0, 500),
    };
    try {
      if (attempt >= maxAttempts) {
        this.logger.error(
          `${event.type} (${event.id}) agotó ${attempt} intentos en ${queue}; pasa a la DLQ: ${error.message}`,
        );
        ch.publish(DLX, queue, msg.content, { persistent: true, headers });
      } else {
        const wait = backoffMs(
          attempt,
          this.options.retryBaseMs ?? 500,
          this.options.retryMaxMs ?? 30_000,
        );
        this.logger.warn(
          `Fallo ${event.type} (${event.id}) en ${queue}, intento ${attempt}/${maxAttempts}; reintento en ${wait} ms: ${error.message}`,
        );
        await new Promise((r) => setTimeout(r, wait));
        ch.sendToQueue(queue, msg.content, { persistent: true, headers });
      }
      await ch.waitForConfirms();
      ch.ack(msg);
    } catch (e) {
      this.logger.error(`No se pudo reprogramar ${event.id}: ${(e as Error).message}`);
      ch.nack(msg, false, true);
    }
  }

  async close(): Promise<void> {
    // Si hay una apertura en curso se espera: cerrar antes dejaría esa conexión abierta.
    await this.abriendo?.catch(() => undefined);
    await this.channel?.close().catch(() => undefined);
    await this.connection?.close().catch(() => undefined);
    this.channel = undefined;
    this.connection = undefined;
  }
}
