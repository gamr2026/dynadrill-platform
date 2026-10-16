import type { EventEnvelope } from './envelope';

/**
 * Lo mínimo que necesita el outbox/inbox de una conexión SQL. Lo cumplen tanto `PrismaClient`
 * como el cliente de una transacción interactiva (`prisma.$transaction(async (tx) => ...)`),
 * así este módulo no depende del cliente generado de ningún módulo.
 */
export interface SqlExecutor {
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}

const SCHEMA_RE = /^msg_[a-z_]+$/;

function assertMsgSchema(schema: string): void {
  if (!SCHEMA_RE.test(schema)) throw new Error(`Schema de mensajería inválido: ${schema}`);
}

/**
 * Guarda el evento en `msg_<contenedor>.outbox`. Debe llamarse con el cliente de la MISMA
 * transacción que cambia el estado de negocio: si la transacción confirma, el evento existe;
 * si se revierte, desaparece (nunca hay estado sin evento ni evento sin estado).
 */
export async function writeOutbox(
  executor: SqlExecutor,
  schema: string,
  event: EventEnvelope,
): Promise<void> {
  assertMsgSchema(schema);
  await executor.$executeRawUnsafe(
    `INSERT INTO ${schema}.outbox (id, tipo, version_evento, datos) VALUES ($1::uuid, $2, $3, $4::jsonb)`,
    event.id,
    event.type,
    event.version,
    JSON.stringify(event),
  );
}

/**
 * Idempotencia del consumidor: registra el id del evento y ejecuta el efecto solo si es la primera
 * vez. Llamar dentro de la misma transacción del efecto; si el evento llega dos veces, la segunda
 * no ejecuta nada y devuelve `false`.
 */
export async function runOnce(
  executor: SqlExecutor,
  schema: string,
  event: Pick<EventEnvelope, 'id' | 'type'>,
  effect: () => Promise<void>,
): Promise<boolean> {
  assertMsgSchema(schema);
  const inserted = await executor.$executeRawUnsafe(
    `INSERT INTO ${schema}.inbox (id, tipo) VALUES ($1::uuid, $2) ON CONFLICT (id) DO NOTHING`,
    event.id,
    event.type,
  );
  if (inserted === 0) return false;
  await effect();
  return true;
}
