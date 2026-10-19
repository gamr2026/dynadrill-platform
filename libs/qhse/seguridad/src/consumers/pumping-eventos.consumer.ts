import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { runInEventSpan, type AuthUser } from '@dyn/common';
import { EventBus, type EventEnvelope } from '@dyn/messaging';
import { PtwService } from '../ptw/ptw.service';
import { PrismaService } from '../prisma/prisma.service';

const esUuid = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

/**
 * Recibe de Pumping (contenedor operaciones) los hechos que abren casos de QHSE (contratos 4.6 y 3):
 *  - `ticket_creado`: QHSE conoce el ticket (para preparar el PTW y referenciarlo);
 *  - `asignacion_realizada`: guarda los operadores asignados (la solicitud de EPI la hace el equipo de Pumping desde el ticket).
 * Un evento al que le faltan datos se ignora sin error.
 */
@Injectable()
export class PumpingEventosConsumer implements OnApplicationBootstrap {
  private readonly logger = new Logger(PumpingEventosConsumer.name);

  constructor(
    private readonly bus: EventBus,
    private readonly prisma: PrismaService,
    private readonly ptw: PtwService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.bus.subscribe({
      source: 'operaciones',
      patterns: ['operaciones.pumping.ticket_creado', 'operaciones.pumping.asignacion_realizada'],
      handler: (e) => this.consumir(e),
    });
  }

  /** Público para poder probarlo sin RabbitMQ. */
  async consumir(event: EventEnvelope): Promise<void> {
    if (
      event.type !== 'operaciones.pumping.ticket_creado' &&
      event.type !== 'operaciones.pumping.asignacion_realizada'
    )
      return;
    await runInEventSpan(`consume ${event.type}`, event.traceparent, async () => {
      await this.prisma.$transaction(async (tx) => {
        const procesado = await this.bus.handleOnce(tx, event, async () => {
          const d = event.data;
          const ticketId = d['ticketId'];
          const pedidoId = d['pedidoId'];
          if (!esUuid(ticketId) || !esUuid(pedidoId) || typeof d['pedidoCodigo'] !== 'string') {
            this.logger.warn(`${event.type}: faltan ticketId, pedidoId o pedidoCodigo; se ignora`);
            return;
          }
          const numero = Number(d['ticketNumero']);
          // cliente, campo y pozo: copias justificadas (la bandeja y los avisos los muestran); solo se pisan si el evento los trae
          const opcional = (k: string) =>
            typeof d[k] === 'string' && d[k] ? { [k]: d[k] as string } : {};
          // el supervisor asignado (solo viene en la asignación) debe ser una cuenta existente
          const supervisor = Array.isArray(d['asignados'])
            ? (d['asignados'] as Array<Record<string, unknown>>).find(
                (a) => a['rolCodigo'] === 'supervisor' && esUuid(a['usuarioId']),
              )?.['usuarioId']
            : undefined;
          const supervisorId =
            typeof supervisor === 'string' &&
            (await tx.idUsuario.count({ where: { id: supervisor } }))
              ? { supervisorId: supervisor }
              : {};
          const datos = {
            ticketNumero: Number.isInteger(numero) ? numero : null,
            pedidoId,
            pedidoCodigo: d['pedidoCodigo'],
            ...opcional('cliente'),
            ...opcional('campo'),
            ...opcional('pozo'),
            ...supervisorId,
          };
          await tx.ticketRef.upsert({
            where: { ticketId },
            create: { ticketId, ...datos },
            update: datos,
          });
          // los tipos de servicio del ticket (códigos de comercial): deciden qué matrices IPERC exige su PTW; se reemplazan con cada evento
          if (Array.isArray(d['tiposServicio'])) {
            const codigos = [
              ...new Set(
                (d['tiposServicio'] as unknown[]).filter(
                  (c): c is string => typeof c === 'string' && c.trim() !== '',
                ),
              ),
            ];
            await tx.ticketServicio.deleteMany({ where: { ticketId } });
            if (codigos.length)
              await tx.ticketServicio.createMany({
                data: codigos.map((tipoCodigo) => ({ ticketId, tipoCodigo })),
              });
          }
          if (event.type !== 'operaciones.pumping.asignacion_realizada') return;

          // los operadores asignados (cuentas existentes y activas) reemplazan a los anteriores. El EPI ya no se abre solo: lo pide el equipo de
          // Pumping desde el ticket y QHSE lo atiende (EpiService.solicitarParaTicket); aquí solo se guarda quién es operador del ticket.
          const operadores = Array.isArray(d['operadoresUnidades'])
            ? (d['operadoresUnidades'] as Array<Record<string, unknown>>)
                .map((o) => o['usuarioId'])
                .filter(esUuid)
            : [];
          const cuentas = await tx.idUsuario.findMany({
            where: { id: { in: [...new Set(operadores)] }, activo: true },
            select: { id: true },
          });
          await tx.ticketOperador.deleteMany({ where: { ticketId } });
          if (cuentas.length)
            await tx.ticketOperador.createMany({
              data: cuentas.map((c) => ({ ticketId, usuarioId: c.id })),
            });
          this.logger.log(
            `Ticket ${datos.ticketNumero ?? ticketId}: ${cuentas.length} operador(es) asignado(s)`,
          );
          // el PTW del primer día de operación nace con la asignación (como la demo), a nombre de quien asignó el equipo
          const inicio = d['fechaInicioServicio'];
          const dia =
            typeof inicio === 'string' && /^\d{4}-\d{2}-\d{2}/.test(inicio)
              ? inicio.slice(0, 10)
              : null;
          const quienAsigna = event.actor?.userId;
          if (
            dia &&
            quienAsigna &&
            esUuid(quienAsigna) &&
            (await tx.idUsuario.count({ where: { id: quienAsigna } }))
          ) {
            const id = await this.ptw.abrirAlAsignar(tx, ticketId, dia, {
              id: quienAsigna,
              roleCode: (event.actor?.role ?? 'sistema') as AuthUser['roleCode'],
            });
            if (id)
              this.logger.log(`Ticket ${datos.ticketNumero ?? ticketId}: PTW del ${dia} abierto`);
          }
        });
        if (!procesado) this.logger.warn(`Evento ${event.id} duplicado: se ignora`);
      });
    });
  }
}
