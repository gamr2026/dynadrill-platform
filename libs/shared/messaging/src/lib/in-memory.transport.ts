import type { EventEnvelope } from './envelope';
import type { EventTransport, Subscription } from './transport';

/** Transporte en memoria para pruebas unitarias de los módulos (sin RabbitMQ). */
export class InMemoryTransport implements EventTransport {
  readonly published: EventEnvelope[] = [];
  private readonly subs: Subscription[] = [];

  async publish(event: EventEnvelope): Promise<void> {
    this.published.push(event);
    for (const s of this.subs) {
      if (s.source !== event.source) continue;
      if (s.patterns.some((p) => matches(p, event.type))) await s.handler(event);
    }
  }

  async subscribe(subscription: Subscription): Promise<void> {
    this.subs.push(subscription);
  }

  async close(): Promise<void> {
    this.subs.length = 0;
  }
}

function matches(pattern: string, type: string): boolean {
  const p = pattern.split('.');
  const t = type.split('.');
  return p.length === t.length && p.every((seg, i) => seg === '*' || seg === t[i]);
}
