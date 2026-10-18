import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { runInEventSpan } from '@dyn/common';
import { EventBus, type EventEnvelope } from '@dyn/messaging';
import { uuidv7 } from '@dyn/utils';
import type { TipoTalla } from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';

/** Evento de Inventario (otro contenedor) con cada artículo que se entrega a una persona. */
export const EVENTO_ARTICULO_EPI = 'operaciones.inventario.articulo_epi_actualizado';

const TALLAS: readonly string[] = ['ropa', 'calzado', 'guante'];
const esUuid = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

/**
 * Mantiene la réplica `epi_elemento` (decisión D16): los elementos de EPI son artículos de Inventario que se entregan a una
 * persona. Inventario es otro contenedor (sin FK, D1), así que QHSE se entera por evento. Cada evento trae el estado completo del
 * artículo, por eso:
 *  - es idempotente (inbox) y también por contenido: un evento más viejo no pisa a uno más nuevo (`sincronizado_at`);
 *  - si el artículo dejó de entregarse a una persona (o se dio de baja) el elemento se desactiva, no se borra (puede estar en entregas);
 *  - un evento al que le faltan datos se ignora sin error.
 */
@Injectable()
export class ArticulosEpiConsumer implements OnApplicationBootstrap {
  private readonly logger = new Logger(ArticulosEpiConsumer.name);

  constructor(
    private readonly bus: EventBus,
    private readonly prisma: PrismaService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.bus.subscribe({
      source: 'operaciones',
      // el consumidor de Pumping también escucha a operaciones en este contenedor: cada uno con su cola
      group: 'inventario',
      patterns: [EVENTO_ARTICULO_EPI],
      handler: (e) => this.consumir(e),
    });
  }

  /** Público para poder probarlo sin RabbitMQ. */
  async consumir(event: EventEnvelope): Promise<void> {
    if (event.type !== EVENTO_ARTICULO_EPI) return;
    await runInEventSpan(`consume ${event.type}`, event.traceparent, async () => {
      await this.prisma.$transaction(async (tx) => {
        const procesado = await this.bus.handleOnce(tx, event, async () => {
          const d = event.data;
          const tipoTalla = d['tipoTalla'] ?? null;
          if (
            !esUuid(d['articuloId']) ||
            typeof d['codigo'] !== 'string' ||
            !d['codigo'].trim() ||
            typeof d['nombre'] !== 'string' ||
            !d['nombre'].trim() ||
            (tipoTalla !== null && !(typeof tipoTalla === 'string' && TALLAS.includes(tipoTalla)))
          ) {
            this.logger.warn(
              `${event.type}: faltan articuloId, codigo o nombre válidos; se ignora`,
            );
            return;
          }
          const articuloId = d['articuloId'];
          const momento = new Date(event.occurredAt);
          const activo = d['entregaPersonal'] === true && d['activo'] !== false;
          const actual = await tx.epiElemento.findUnique({
            where: { articuloId },
            select: { id: true, sincronizadoAt: true },
          });
          if (actual && actual.sincronizadoAt > momento) {
            this.logger.log(`Artículo ${d['codigo']}: evento más viejo que el aplicado; se ignora`);
            return;
          }
          const datos = {
            codigo: d['codigo'].trim(),
            nombre: d['nombre'].trim(),
            tipoTalla: tipoTalla as TipoTalla | null,
            activo,
            sincronizadoAt: momento,
            updatedBy: event.actor?.userId ?? null,
          };
          if (actual) {
            await tx.epiElemento.update({ where: { id: actual.id }, data: datos });
          } else if (activo) {
            // un artículo que nunca se entregó a una persona no entra al catálogo de QHSE
            await tx.epiElemento.create({
              data: { id: uuidv7(), articuloId, ...datos, createdBy: event.actor?.userId ?? null },
            });
          }
        });
        if (!procesado) this.logger.warn(`Evento ${event.id} duplicado: se ignora`);
      });
    });
  }
}
