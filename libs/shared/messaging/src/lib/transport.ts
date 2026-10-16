import type { EventEnvelope } from './envelope';

/** Puerto de transporte. Hoy RabbitMQ; en Azure se agrega un adaptador de Service Bus. */
export interface EventTransport {
  publish(event: EventEnvelope): Promise<void>;
  subscribe(subscription: Subscription): Promise<void>;
  close(): Promise<void>;
}

export interface Subscription {
  /** Contenedor consumidor: nombra la cola (`operaciones`). */
  consumer: string;
  /** Contenedor productor al que se suscribe (`comercial`). */
  source: string;
  /** Patrones de tipo, ej. `comercial.pedido.*`. Cada uno coincide con cualquier versión. */
  patterns: string[];
  /** Lanza para reintentar; tras agotar los intentos el mensaje va a la cola de fallidos (DLQ). */
  handler: (event: EventEnvelope) => Promise<void>;
}
