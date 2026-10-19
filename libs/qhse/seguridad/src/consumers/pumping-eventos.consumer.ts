import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { currentTraceparent, runInEventSpan } from '@dyn/common';
import { EventBus, type EventEnvelope } from '@dyn/messaging';
import { EpiService } from '../epi/epi.service';
import { PrismaService } from '../prisma/prisma.service';

const esUuid = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

/**
 * Recibe de Pumping (contenedor operaciones) los hechos que abren casos de QHSE (contratos 4.6 y 3):
 *  - `ticket_creado`: QHSE conoce el ticket (para preparar el PTW y referenciarlo);
 *  - `asignacion_realizada`: abre una solicitud de EPI por cada operador asignado.
 * Un evento al que le faltan datos se ignora sin error. El inbox evita abrir dos veces la misma solicitud.
 */
@Injectable()
export class PumpingEventosConsumer implements OnApplicationBootstrap {
  private readonly logger = new Logger(PumpingEventosConsumer.name);

  constructor(
    private readonly bus: EventBus,
    private readonly prisma: PrismaService,
    private readonly epi: EpiService,
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

          // los operadores asignados: cada uno con su unidad; las cuentas deben existir y estar activas
          const operadores = Array.isArray(d['operadoresUnidades'])
            ? (d['operadoresUnidades'] as Array<Record<string, unknown>>)
                .map((o) => o['usuarioId'])
                .filter(esUuid)
            : [];
          const cuentas = await tx.idUsuario.findMany({
            where: { id: { in: operadores }, activo: true },
            select: { id: true, nombre: true },
          });
          const existentes = new Map(cuentas.map((u) => [u.id, u.nombre]));
          const actorId = event.actor?.userId;
          const actor = {
            role: event.actor?.role,
            userId:
              actorId && esUuid(actorId) && (await tx.idUsuario.count({ where: { id: actorId } }))
                ? actorId
                : null,
          };
          const abiertas: string[] = [];
          for (const usuarioId of [...new Set(operadores)]) {
            if (!existentes.has(usuarioId)) {
              this.logger.warn(
                `Operador ${usuarioId} no existe o está inactivo; no se abre su EPI`,
              );
              continue;
            }
            if (await this.epi.abrirParaOperador(tx, ticketId, usuarioId, actor, event))
              abiertas.push(existentes.get(usuarioId) as string);
          }
          this.logger.log(
            `Ticket ${datos.ticketNumero ?? ticketId}: ${abiertas.length} solicitud(es) de EPI abiertas`,
          );
          if (abiertas.length) await this.avisarSolicitudes(tx, event, ticketId, datos, abiertas);
        });
        if (!procesado) this.logger.warn(`Evento ${event.id} duplicado: se ignora`);
      });
    });
  }

  /**
   * Un solo aviso por asignación (no uno por operador) para el equipo de QHSE: «hay N solicitudes de EPI por revisar». Lleva el texto que
   * necesita el aviso (cliente, pozo, nombres), copiado del evento de Pumping, porque QHSE no puede obtenerlo con un JOIN.
   */
  private async avisarSolicitudes(
    tx: Parameters<Parameters<PrismaService['$transaction']>[0]>[0],
    causa: EventEnvelope,
    ticketId: string,
    ticket: { ticketNumero: number | null; pedidoCodigo: string },
    trabajadores: string[],
  ): Promise<void> {
    const d = causa.data;
    const texto = (k: string) => (typeof d[k] === 'string' ? (d[k] as string) : null);
    await this.bus.publish(
      tx,
      this.bus.create({
        type: 'qhse.epi.solicitudes_abiertas',
        subject: { type: 'pumping_ticket', id: ticketId },
        data: {
          ticketId,
          ticketNumero: ticket.ticketNumero,
          pedidoCodigo: ticket.pedidoCodigo,
          cliente: texto('cliente'),
          campo: texto('campo'),
          pozo: texto('pozo'),
          cantidad: trabajadores.length,
          trabajadores: trabajadores.join(', '),
        },
        causationId: causa.id,
        correlationId: causa.correlationId,
        traceparent: currentTraceparent(),
      }),
    );
  }
}
