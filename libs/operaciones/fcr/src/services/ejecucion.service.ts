import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { currentTraceparent, type AuthUser } from '@dyn/common';
import { EventBus } from '@dyn/messaging';
import { REQ } from '../catalog/sembrar-pasos';
import { PrismaService } from '../prisma/prisma.service';
import { ReporteHerramientasService } from './reporte-herramientas.service';
import { RequisitosService } from './requisitos.service';
import { TicketsService } from './tickets.service';

const aDia = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Reunión operativa, finalización de la ejecución y revisión de reportes.
 *  - El Supervisor confirma el acta de la reunión operativa (con su fecha) para pasar a la ejecución.
 *  - El Operador finaliza la ejecución: la bitácora debe estar enviada (todos sus días) y el Reporte de Herramientas confirmado. Al finalizar se
 *    envía a Comercial el Reporte de Herramientas (una sola vez, por código de la lista de precios y con la cantidad real; consulta F-21) y el ticket pasa a la
 *    revisión de reportes, donde el operador ya no corrige.
 *  - El Supervisor aprueba los reportes (pasa al control de retorno) o los rechaza con motivo (vuelve a la ejecución).
 */
@Injectable()
export class EjecucionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: EventBus,
    private readonly tickets: TicketsService,
    private readonly requisitos: RequisitosService,
    private readonly reporte: ReporteHerramientasService,
  ) {}

  async reunion(ticketId: string) {
    const r = await this.prisma.reunionOperativa.findUnique({
      where: { ticketId },
      include: { firmante: { select: { nombre: true } } },
    });
    return r
      ? { fecha: aDia(r.fecha), firmadaAt: r.firmadaAt, firmadaPor: r.firmante.nombre }
      : null;
  }

  /** El Supervisor confirma el acta de la reunión operativa; se puede corregir la fecha mientras el ticket siga en ese paso. */
  async confirmarActa(ticketId: string, fecha: string, actor: AuthUser) {
    const d = new Date(`${fecha}T00:00:00.000Z`);
    if (Number.isNaN(d.getTime()) || aDia(d) !== fecha)
      throw new BadRequestException('La fecha no es válida');
    await this.prisma.$transaction(async (tx) => {
      const t = await this.tickets.cargarEnTx(tx, ticketId);
      if (t.pasoCodigo !== 'reunion_operativa') {
        throw new ConflictException('El acta se confirma en el paso «Reunión operativa»');
      }
      this.tickets.exigirActuar(t, actor);
      await tx.reunionOperativa.upsert({
        where: { ticketId },
        create: { ticketId, fecha: d, firmadaPor: actor.id },
        update: { fecha: d, firmadaPor: actor.id, firmadaAt: new Date() },
      });
      await this.requisitos.marcar(
        tx,
        { ticketId, codigo: REQ.actaReunionOperativa },
        'sistema',
        actor.id,
      );
    });
    return this.reunion(ticketId);
  }

  /** El Operador finaliza la ejecución y sube los reportes: envía el Reporte de Herramientas y pasa a la revisión de reportes. */
  async finalizar(ticketId: string, actor: AuthUser) {
    await this.prisma.$transaction(async (tx) => {
      const t = await this.tickets.cargarEnTx(tx, ticketId);
      if (t.pasoCodigo !== 'ejecucion_operativa') {
        throw new ConflictException('La ejecución se finaliza en el paso «Ejecución operativa»');
      }
      this.tickets.exigirActuar(t, actor);
      const sinEnviar = await tx.bitacoraDia.count({
        where: { ticketId, enviadaAt: null, corregidaAt: null, actividades: { some: {} } },
      });
      if (sinEnviar) {
        throw new ConflictException({
          message: `Hay ${sinEnviar} día(s) de la bitácora sin enviar a Facturación`,
          code: 'BITACORA_SIN_ENVIAR',
        });
      }
      await this.requisitos.exigirCumplidos(tx, ticketId, t.pasoCodigo, t.paso.nombre);

      const items = await this.reporte.paraEnvio(tx, ticketId);
      const supervisor = t.personas.find((p) => p.rol === 'supervisor');
      const operador = t.personas.find((p) => p.rol === 'operador' && p.usuarioId === actor.id);
      const ahora = new Date();
      await this.tickets.moverPaso(tx, t, 'revision_reportes', actor, { exigirRequisitos: false });
      // el Reporte de Herramientas lleva las filas por código de la lista de precios con su cantidad real: de ahí salen la guía, la prefactura y la OT
      await this.bus.publish(
        tx,
        this.bus.create({
          type: 'operaciones.fcr.reporte_herramientas_completado',
          subject: { type: 'fcr_ticket', id: ticketId },
          data: {
            ticketId,
            ticketNumero: t.ticketNumero,
            pedidoId: t.pedidoId,
            firmadoPor: actor.name,
            firmadoAt: ahora.toISOString(),
            supervisorId: supervisor?.usuarioId ?? null,
            operadorId: operador?.usuarioId ?? null,
            herramientas: items,
          },
          actor: { userId: actor.id, role: actor.roleCode },
          traceparent: currentTraceparent(),
        }),
      );
    });
    return this.tickets.detalle(ticketId, actor);
  }

  /** El Supervisor aprueba los reportes: el ticket pasa al control de retorno. */
  async aprobarReportes(ticketId: string, actor: AuthUser) {
    await this.prisma.$transaction(async (tx) => {
      const t = await this.tickets.cargarEnTx(tx, ticketId);
      if (t.pasoCodigo !== 'revision_reportes') {
        throw new ConflictException('Los reportes se revisan en el paso «Revisión de reportes»');
      }
      this.tickets.exigirActuar(t, actor);
      await this.tickets.moverPaso(tx, t, 'control_retorno', actor);
    });
    return this.tickets.detalle(ticketId, actor);
  }

  /** El Supervisor rechaza los reportes con motivo: vuelve a la ejecución y el listado de uso se debe confirmar de nuevo. */
  async rechazarReportes(ticketId: string, motivo: string, actor: AuthUser) {
    const texto = motivo?.trim();
    if (!texto) throw new BadRequestException('El motivo es obligatorio');
    await this.prisma.$transaction(async (tx) => {
      const t = await this.tickets.cargarEnTx(tx, ticketId);
      if (t.pasoCodigo !== 'revision_reportes') {
        throw new ConflictException('Los reportes se revisan en el paso «Revisión de reportes»');
      }
      this.tickets.exigirActuar(t, actor);
      await this.requisitos.reabrir(tx, { ticketId, codigo: REQ.listadoUsoConfirmado });
      await this.tickets.moverPaso(tx, t, 'ejecucion_operativa', actor, {
        motivo: texto,
        exigirRequisitos: false,
      });
    });
    return this.tickets.detalle(ticketId, actor);
  }
}
