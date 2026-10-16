import { uuidv7 } from '@dyn/utils';

/**
 * Sobre estándar de evento (documento de arquitectura, cap. 8.5).
 * Nombre: `<contenedor>.<entidad>.<hecho_en_pasado>` + versión (`comercial.pedido.abierto` v1).
 * Lleva identificadores y datos mínimos, nunca la entidad completa.
 */
export interface EventEnvelope<TData = Record<string, unknown>> {
  /** UUIDv7; es la clave de idempotencia del consumidor. */
  id: string;
  type: string;
  version: number;
  occurredAt: string;
  /** Contenedor productor (`comercial`, `plataforma`...). */
  source: string;
  correlationId?: string;
  causationId?: string;
  traceparent?: string;
  actor?: { userId: string; role: string };
  subject: { type: string; id: string };
  data: TData;
}

export interface NewEvent<TData> {
  type: string;
  version?: number;
  source: string;
  subject: { type: string; id: string };
  data: TData;
  correlationId?: string;
  causationId?: string;
  traceparent?: string;
  actor?: { userId: string; role: string };
}

const TYPE_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){2,}$/;

export function createEvent<TData>(input: NewEvent<TData>): EventEnvelope<TData> {
  if (!TYPE_RE.test(input.type)) {
    throw new Error(
      `Tipo de evento inválido "${input.type}": use <contenedor>.<entidad>.<hecho_en_pasado>`,
    );
  }
  if (!input.type.startsWith(`${input.source}.`)) {
    throw new Error(
      `El evento "${input.type}" debe empezar con su contenedor productor "${input.source}."`,
    );
  }
  return {
    id: uuidv7(),
    type: input.type,
    version: input.version ?? 1,
    occurredAt: new Date().toISOString(),
    source: input.source,
    subject: input.subject,
    data: input.data,
    ...(input.correlationId ? { correlationId: input.correlationId } : {}),
    ...(input.causationId ? { causationId: input.causationId } : {}),
    ...(input.traceparent ? { traceparent: input.traceparent } : {}),
    ...(input.actor ? { actor: input.actor } : {}),
  };
}

/** Clave de enrutamiento en RabbitMQ: `comercial.pedido.abierto.v1`. */
export function routingKeyOf(envelope: Pick<EventEnvelope, 'type' | 'version'>): string {
  return `${envelope.type}.v${envelope.version}`;
}
