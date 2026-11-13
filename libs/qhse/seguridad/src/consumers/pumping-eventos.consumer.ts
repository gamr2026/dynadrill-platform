import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { runInEventSpan, type AuthUser } from '@dyn/common';
import { EventBus, type EventEnvelope } from '@dyn/messaging';
import { PtwService } from '../ptw/ptw.service';
import { PrismaService } from '../prisma/prisma.service';

const esUuid = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

/** Tipos de evento que abren casos de QHSE: los de Pumping y los de FCR llevan la misma forma (ticket, pedido, asignados). */
const TIPOS = [
  'operaciones.pumping.ticket_creado',
  'operaciones.pumping.asignacion_realizada',
  'operaciones.fcr.ticket_creado',
  'operaciones.fcr.asignacion_realizada',
  'operaciones.pumping.dias_de_servicio_actualizados',
  'operaciones.pumping.terminos_aceptados',
] as const;

const FECHA = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Recibe de Pumping y de FCR (contenedor operaciones) los hechos que abren casos de QHSE (contratos 4.6 y 3):
 *  - `ticket_creado`: QHSE conoce el ticket (para preparar el PTW, cargar sus documentos y referenciarlo);
 *  - `asignacion_realizada`: guarda los operadores asignados (la solicitud de EPI la hace el equipo de Pumping desde el ticket);
 *  - `dias_de_servicio_actualizados`: los días de servicio activos del ticket (cada aviso reemplaza al anterior); de ahí la tarea programada abre el PTW de cada día.
 *  - `terminos_aceptados`: el operador aceptó los términos en Pumping; es su declaración en la entrega de EPI (no hay que registrarla aparte).
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
      patterns: [...TIPOS],
      handler: (e) => this.consumir(e),
    });
  }

  /** Reemplaza los días de servicio activos del ticket. Un aviso de un ticket que QHSE todavía no conoce, o sin lista de fechas, se ignora. */
  private async diasDeServicio(
    tx: Parameters<Parameters<PrismaService['$transaction']>[0]>[0],
    d: Record<string, unknown>,
  ): Promise<void> {
    const ticketId = d['ticketId'];
    if (!esUuid(ticketId) || !Array.isArray(d['dias'])) {
      this.logger.warn('dias_de_servicio_actualizados: faltan ticketId o dias; se ignora');
      return;
    }
    if (!(await tx.ticketRef.count({ where: { ticketId } }))) {
      this.logger.warn(
        `dias_de_servicio_actualizados: QHSE no conoce el ticket ${ticketId}; se ignora`,
      );
      return;
    }
    const dias = [
      ...new Set(
        (d['dias'] as unknown[]).filter((x): x is string => typeof x === 'string' && FECHA.test(x)),
      ),
    ];
    await tx.ticketDiaServicio.deleteMany({ where: { ticketId } });
    if (dias.length)
      await tx.ticketDiaServicio.createMany({
        data: dias.map((f) => ({ ticketId, fecha: new Date(`${f}T00:00:00.000Z`) })),
      });
  }

  /** El operador aceptó los términos y condiciones en Pumping: queda como su declaración para la entrega de EPI. */
  private async terminosAceptados(
    tx: Parameters<Parameters<PrismaService['$transaction']>[0]>[0],
    d: Record<string, unknown>,
  ): Promise<void> {
    const { ticketId, usuarioId, versionCodigo, aceptadoAt } = d;
    const cuando = typeof aceptadoAt === 'string' ? new Date(aceptadoAt) : null;
    if (
      !esUuid(ticketId) ||
      !esUuid(usuarioId) ||
      typeof versionCodigo !== 'string' ||
      !cuando ||
      Number.isNaN(cuando.getTime())
    ) {
      this.logger.warn('terminos_aceptados: faltan datos; se ignora');
      return;
    }
    if (!(await tx.ticketRef.count({ where: { ticketId } }))) {
      this.logger.warn(`terminos_aceptados: QHSE no conoce el ticket ${ticketId}; se ignora`);
      return;
    }
    await tx.ticketOperadorTerminos.upsert({
      where: { ticketId_usuarioId: { ticketId, usuarioId } },
      create: { ticketId, usuarioId, versionCodigo, aceptadoAt: cuando },
      update: { versionCodigo, aceptadoAt: cuando },
    });
  }

  /** Público para poder probarlo sin RabbitMQ. */
  async consumir(event: EventEnvelope): Promise<void> {
    if (!(TIPOS as readonly string[]).includes(event.type)) return;
    await runInEventSpan(`consume ${event.type}`, event.traceparent, async () => {
      await this.prisma.$transaction(async (tx) => {
        const procesado = await this.bus.handleOnce(tx, event, async () => {
          const d = event.data;
          if (event.type === 'operaciones.pumping.dias_de_servicio_actualizados')
            return this.diasDeServicio(tx, d);
          if (event.type === 'operaciones.pumping.terminos_aceptados')
            return this.terminosAceptados(tx, d);
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
          // la bodega del pedido (catalogos.bodega): solo se pisa si el evento la trae y existe en el catálogo
          const bodega = d['bodegaId'];
          const bodegaId =
            esUuid(bodega) && (await tx.catBodega.count({ where: { id: bodega } }))
              ? { bodegaId: bodega }
              : {};
          const datos = {
            ticketNumero: Number.isInteger(numero) ? numero : null,
            pedidoId,
            pedidoCodigo: d['pedidoCodigo'],
            ...opcional('cliente'),
            ...opcional('campo'),
            ...opcional('pozo'),
            ...bodegaId,
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
          // el PTW del primer día de operación nace con el servicio (como la demo): cuando Ventas pasa el pedido a Pumping, a nombre de quien lo abrió;
          // si el ticket ya existía, la asignación lo asegura a nombre de quien asignó el equipo. Un PTW vigente del mismo día no se duplica.
          const inicio = d['fechaInicioServicio'];
          const dia =
            typeof inicio === 'string' && /^\d{4}-\d{2}-\d{2}/.test(inicio)
              ? inicio.slice(0, 10)
              : null;
          const quienAbre = event.actor?.userId;
          if (!dia) {
            this.logger.warn(
              `Ticket ${datos.ticketNumero ?? ticketId}: el evento no trae fechaInicioServicio; no se abre el PTW (QHSE lo abre a mano)`,
            );
          } else if (
            !quienAbre ||
            !esUuid(quienAbre) ||
            !(await tx.idUsuario.count({ where: { id: quienAbre } }))
          ) {
            this.logger.warn(
              `Ticket ${datos.ticketNumero ?? ticketId}: la cuenta que originó el evento no existe en identidad; no se abre el PTW (QHSE lo abre a mano)`,
            );
          } else {
            const id = await this.ptw.abrirDelPrimerDia(tx, ticketId, dia, {
              id: quienAbre,
              roleCode: (event.actor?.role ?? 'sistema') as AuthUser['roleCode'],
            });
            if (id)
              this.logger.log(`Ticket ${datos.ticketNumero ?? ticketId}: PTW del ${dia} abierto`);
          }

          if (!event.type.endsWith('.asignacion_realizada')) return;

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
        });
        if (!procesado) this.logger.warn(`Evento ${event.id} duplicado: se ignora`);
      });
    });
  }
}
