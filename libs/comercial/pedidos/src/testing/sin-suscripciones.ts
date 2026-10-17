import { TicketCerradoConsumer } from '../consumers/ticket-cerrado.consumer';

/**
 * Pruebas de integración sin RabbitMQ: los consumidores se invocan a mano, así que se evita que intenten suscribirse al arrancar
 * la aplicación. Llámelo antes de `app.init()`.
 */
export function sinSuscripciones(): void {
  jest
    .spyOn(TicketCerradoConsumer.prototype, 'onApplicationBootstrap')
    .mockResolvedValue(undefined);
}
