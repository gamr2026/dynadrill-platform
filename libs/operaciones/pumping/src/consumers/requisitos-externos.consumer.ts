import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { currentTraceparent, runInEventSpan } from '@dyn/common';
import { EventBus, type EventEnvelope } from '@dyn/messaging';
import { REQ } from '../catalog/sembrar-traslado-salida';
import { PrismaService } from '../prisma/prisma.service';
import { RequisitosService } from '../services/requisitos.service';
import { nombreDe } from '../services/tickets.service';

interface Regla {
  /** Código del requisito; si depende de los datos del evento (p. ej. el viaje de salida o de retorno), una función que lo calcula (`null` = ignorar). */
  codigo: string | ((data: Record<string, unknown>) => string | null);
  accion: 'cumplir' | 'reabrir';
  /** Qué trae el evento para ubicar la fila: la cuenta del operador, la unidad o nada más que el ticket. */
  por: 'usuarioId' | 'vehiculoId' | 'ticket';
}

/** `tipo` del evento de gerenciamiento de viaje → requisito. */
const requisitoDeViaje = (data: Record<string, unknown>): string | null =>
  data['tipo'] === 'salida'
    ? REQ.gerenciamientoSalida
    : data['tipo'] === 'retorno'
      ? REQ.gerenciamientoRetorno
      : null;

/**
 * CONTRATO con los módulos dueños (QHSE y Flota) de los datos que cumplen requisitos del traslado de salida (ver
 * documentacion/pumping/PLAN-TRASLADO-SALIDA.md). Cada evento trae `ticketId` y la cuenta o la unidad. Mientras esos módulos no
 * existan, el puente temporal del propio ticket cumple esos requisitos con motivo.
 */
export const REGLAS_EXTERNAS: Record<string, Regla> = {
  // QHSE
  'qhse.epi.despachada': { codigo: REQ.epiDespachado, accion: 'cumplir', por: 'usuarioId' },
  'qhse.epi.revertida': { codigo: REQ.epiDespachado, accion: 'reabrir', por: 'usuarioId' },
  // QHSE: Acta de Entrega de Locación (contrato 4.11); se exige para cerrar el servicio
  'qhse.acta_entrega.cargada': {
    codigo: REQ.actaEntregaLocacion,
    accion: 'cumplir',
    por: 'ticket',
  },
  'qhse.acta_entrega.anulada': {
    codigo: REQ.actaEntregaLocacion,
    accion: 'reabrir',
    por: 'ticket',
  },
  // Flota (dueña de la inspección de vehículos)
  'flota.inspeccion_vehiculo.realizada': {
    codigo: REQ.inspeccionRealizada,
    accion: 'cumplir',
    por: 'vehiculoId',
  },
  'flota.inspeccion_vehiculo.anulada': {
    codigo: REQ.inspeccionRealizada,
    accion: 'reabrir',
    por: 'vehiculoId',
  },
  'flota.inspeccion_vehiculo.aprobada': {
    codigo: REQ.inspeccionAprobada,
    accion: 'cumplir',
    por: 'vehiculoId',
  },
  'flota.inspeccion_vehiculo.rechazada': {
    codigo: REQ.inspeccionAprobada,
    accion: 'reabrir',
    por: 'vehiculoId',
  },
  // Flota: gerenciamiento de viaje (lo solicita el Conductor; su aprobación es condición para salir de la revisión de salida y del control de retorno)
  'flota.gerenciamiento_viaje.aprobado': {
    codigo: requisitoDeViaje,
    accion: 'cumplir',
    por: 'vehiculoId',
  },
  'flota.gerenciamiento_viaje.rechazado': {
    codigo: requisitoDeViaje,
    accion: 'reabrir',
    por: 'vehiculoId',
  },
};

const FUENTES = [
  {
    source: 'qhse',
    patterns: [
      'qhse.swa.activado',
      'qhse.swa.cerrado',
      'qhse.ptw.abierto',
      'qhse.ptw.firmado',
      'qhse.ptw.cerrado',
      'qhse.ptw.anulado',
      'qhse.epi.despachada',
      'qhse.epi.revertida',
      'qhse.acta_entrega.cargada',
      'qhse.acta_entrega.anulada',
    ],
  },
  {
    source: 'flota',
    patterns: [
      'flota.inspeccion_vehiculo.realizada',
      'flota.inspeccion_vehiculo.anulada',
      'flota.inspeccion_vehiculo.aprobada',
      'flota.inspeccion_vehiculo.rechazada',
      'flota.gerenciamiento_viaje.aprobado',
      'flota.gerenciamiento_viaje.rechazado',
    ],
  },
];

/** Recibe los eventos de QHSE y Flota y cumple (o reabre) el requisito del ticket. El inbox evita procesarlos dos veces. */
@Injectable()
export class RequisitosExternosConsumer implements OnApplicationBootstrap {
  private readonly logger = new Logger(RequisitosExternosConsumer.name);

  constructor(
    private readonly bus: EventBus,
    private readonly prisma: PrismaService,
    private readonly requisitos: RequisitosService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    for (const f of FUENTES) {
      await this.bus.subscribe({
        source: f.source,
        patterns: f.patterns,
        handler: (e) => this.consumir(e),
      });
    }
  }

  /**
   * Un aviso al Supervisor asignado al ticket: «la inspección de la unidad X quedó realizada y espera su aprobación». Sale como hecho de
   * Pumping (con la cuenta del supervisor en `asignados`), igual que el aviso de salida reportada.
   */
  private async avisarSupervisor(
    tx: Parameters<Parameters<PrismaService['$transaction']>[0]>[0],
    ticketId: string,
    vehiculoId: string,
    causa: EventEnvelope,
  ): Promise<void> {
    const t = await tx.ticket.findUnique({
      where: { id: ticketId },
      include: {
        cliente: true,
        campo: true,
        pozo: true,
        taladro: true,
        personas: true,
        unidades: { include: { vehiculo: true } },
      },
    });
    const supervisor = t?.personas.find((p) => p.rol === 'supervisor');
    if (!t || !supervisor) return;
    const actorId = causa.actor?.userId;
    const quien = actorId
      ? await tx.idUsuario.findUnique({ where: { id: actorId }, select: { nombre: true } })
      : null;
    await this.bus.publish(
      tx,
      this.bus.create({
        type: 'operaciones.pumping.inspeccion_realizada',
        subject: { type: 'pumping_ticket', id: ticketId },
        data: {
          ticketId,
          ticketNumero: t.ticketNumero,
          pedidoId: t.pedidoId,
          pedidoCodigo: t.pedidoCodigo,
          cliente: nombreDe(t.cliente),
          campo: t.campo?.nombre ?? null,
          pozo: t.pozo?.nombreCompleto ?? null,
          taladro: t.rigless ? 'RIGLESS' : (t.taladro?.nombre ?? null),
          unidad: t.unidades.find((u) => u.vehiculoId === vehiculoId)?.vehiculo.placa ?? null,
          realizadaPor: quien?.nombre ?? null,
          asignados: [{ usuarioId: supervisor.usuarioId, rolCodigo: 'supervisor' }],
        },
        causationId: causa.id,
        correlationId: causa.correlationId,
        traceparent: currentTraceparent(),
      }),
    );
  }

  /**
   * SWA y PTW de QHSE bloquean la salida del traslado (decisión del 21/10/2026). Son requisitos DEL TICKET que se crean si todavía no
   * existen, porque el PTW del primer día nace con el servicio, antes de la asignación:
   * - `swa_sin_activar`: `qhse.swa.activado` lo reabre; `qhse.swa.cerrado` lo cumple solo si ya no queda ninguna SWA activa en el ticket.
   * - `ptw_primer_dia_abierto`: cualquier hecho del PTW del primer día (abierto, firmado o cerrado) lo cumple; si se anula, vuelve a exigirse.
   */
  private async bloqueoQhse(
    tx: Parameters<Parameters<PrismaService['$transaction']>[0]>[0],
    event: EventEnvelope,
  ): Promise<void> {
    const ticketId = String(event.data['ticketId'] ?? '');
    if (!ticketId) return; // una SWA o un PTW sin servicio no afecta a ningún ticket
    const actor = (event.actor?.userId as string | undefined) ?? null;
    if (event.type.startsWith('qhse.swa.')) {
      if (event.type === 'qhse.swa.activado') {
        await this.requisitos.fijar(tx, ticketId, REQ.swaSinActivar, 'pendiente', 'evento');
      } else if (event.data['sinSwaActivas'] === true) {
        await this.requisitos.fijar(tx, ticketId, REQ.swaSinActivar, 'cumplido', 'evento', actor);
      }
      return;
    }
    const ticket = await tx.ticket.findUnique({
      where: { id: ticketId },
      select: { fechaInicioServicio: true },
    });
    if (!ticket) return;
    // solo el PTW del primer día de operación (si el ticket no trae fecha de inicio, cuenta cualquiera)
    const dia = String(event.data['diaOperacion'] ?? '').slice(0, 10);
    const primero = ticket.fechaInicioServicio?.toISOString().slice(0, 10);
    if (primero && dia && dia !== primero) return;
    await this.requisitos.fijar(
      tx,
      ticketId,
      REQ.ptwPrimerDia,
      event.type === 'qhse.ptw.anulado' ? 'pendiente' : 'cumplido',
      'evento',
      actor,
    );
  }

  /** Público para poder probarlo sin RabbitMQ. */
  async consumir(event: EventEnvelope): Promise<void> {
    if (/^qhse\.(swa|ptw)\./.test(event.type)) {
      await runInEventSpan(`consume ${event.type}`, event.traceparent, async () => {
        await this.prisma.$transaction(async (tx) => {
          const nuevo = await this.bus.handleOnce(tx, event, () => this.bloqueoQhse(tx, event));
          if (!nuevo) this.logger.warn(`Evento ${event.id} duplicado: se ignora`);
        });
      });
      return;
    }
    const regla = REGLAS_EXTERNAS[event.type];
    if (!regla) return;
    await runInEventSpan(`consume ${event.type}`, event.traceparent, async () => {
      await this.prisma.$transaction(async (tx) => {
        const procesado = await this.bus.handleOnce(tx, event, async () => {
          const ticketId = String(event.data['ticketId'] ?? '');
          const quien = regla.por === 'ticket' ? 'ticket' : String(event.data[regla.por] ?? '');
          const codigo =
            typeof regla.codigo === 'function' ? regla.codigo(event.data) : regla.codigo;
          if (!ticketId || !quien || !codigo) {
            this.logger.warn(`${event.type}: faltan ticketId, ${regla.por} o el tipo; se ignora`);
            return;
          }
          const clave = {
            ticketId,
            codigo,
            ...(regla.por === 'ticket' ? {} : { [regla.por]: quien }),
          };
          const n =
            regla.accion === 'cumplir'
              ? await this.requisitos.marcar(
                  tx,
                  clave,
                  'evento',
                  (event.actor?.userId as string | undefined) ?? null,
                )
              : await this.requisitos.reabrir(tx, clave);
          this.logger.log(
            `${event.type}: ${n} requisito(s) ${regla.accion === 'cumplir' ? 'cumplido(s)' : 'reabierto(s)'}`,
          );
          // la inspección del vehículo la hace el operador y la aprueba el Supervisor: al quedar realizada se le avisa
          if (event.type === 'flota.inspeccion_vehiculo.realizada' && n > 0)
            await this.avisarSupervisor(tx, ticketId, quien, event);
        });
        if (!procesado) this.logger.warn(`Evento ${event.id} duplicado: se ignora`);
      });
    });
  }
}
