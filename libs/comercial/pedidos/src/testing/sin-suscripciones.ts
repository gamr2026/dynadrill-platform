import { CambioItemsConsumer } from '../consumers/cambio-items.consumer';
import { ReporteDiarioConsumer } from '../consumers/reporte-diario.consumer';
import { TicketCerradoConsumer } from '../consumers/ticket-cerrado.consumer';
import { TicketOperativoConsumer } from '../consumers/ticket-operativo.consumer';

/**
 * Pruebas de integración sin RabbitMQ: los consumidores se invocan a mano, así que se evita que intenten suscribirse al arrancar
 * la aplicación. Llámelo antes de `app.init()`.
 */
export function sinSuscripciones(): void {
  jest
    .spyOn(TicketCerradoConsumer.prototype, 'onApplicationBootstrap')
    .mockResolvedValue(undefined);
  jest
    .spyOn(ReporteDiarioConsumer.prototype, 'onApplicationBootstrap')
    .mockResolvedValue(undefined);
  jest
    .spyOn(TicketOperativoConsumer.prototype, 'onApplicationBootstrap')
    .mockResolvedValue(undefined);
  jest.spyOn(CambioItemsConsumer.prototype, 'onApplicationBootstrap').mockResolvedValue(undefined);
}
