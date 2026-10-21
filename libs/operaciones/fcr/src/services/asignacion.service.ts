import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { currentTraceparent, type AuthUser } from '@dyn/common';
import { EventBus } from '@dyn/messaging';
import { PrismaService } from '../prisma/prisma.service';
import { RequisitosService } from './requisitos.service';
import { nombreDe, ROL_SUPERVISOR, TicketsService } from './tickets.service';

/** Lo que el Supervisor elige: solo ids. */
export interface AsignacionEntrada {
  /** Si el ticket ya tiene supervisor no hace falta; solo lo cambia quien coordina. */
  supervisorId?: string;
  operadores: Array<{ usuarioId: string }>;
}

/** Paso en el que se asigna, y paso al que pasa el ticket cuando la asignación queda completa. */
const PASO_ASIGNACION = 'asignacion';
const PASO_SIGUIENTE = 'reunion_operativa';
/** Roles de cuenta que pueden ser supervisor / operador de un servicio de FCR. */
const ROLES_OPERADOR = ['operador_fcr'];

/**
 * Asignación del Supervisor: el operador (o los operadores) del servicio. Al completarla el ticket pasa a
 * «Reunión operativa», se crean los requisitos de operador y se publica `operaciones.fcr.asignacion_realizada` con las
 * cuentas elegidas, para avisarles a ellas (no a todos los de su rol) y para que QHSE abra la entrega de EPI de cada operador.
 */
@Injectable()
export class AsignacionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: EventBus,
    private readonly tickets: TicketsService,
    private readonly requisitos: RequisitosService,
  ) {}

  async asignar(id: string, entrada: AsignacionEntrada, actor: AuthUser) {
    const operadores = entrada.operadores;
    if (!operadores.length) throw new BadRequestException('Indique al menos un operador');
    const operadorIds = operadores.map((o) => o.usuarioId);
    if (new Set(operadorIds).size !== operadorIds.length)
      throw new BadRequestException('Un operador no puede asignarse dos veces');

    await this.prisma.$transaction(async (tx) => {
      const t = await this.tickets.cargarEnTx(tx, id);
      this.tickets.exigirActuar(t, actor);
      if (t.pasoCodigo !== PASO_ASIGNACION) {
        throw new ConflictException('El ticket no está en el paso de Asignación');
      }

      const supervisorActual = t.personas.find((p) => p.rol === 'supervisor')?.usuarioId ?? null;
      const supervisorId =
        entrada.supervisorId ??
        supervisorActual ??
        (actor.roleCode === ROL_SUPERVISOR ? actor.id : null);
      if (!supervisorId) throw new BadRequestException('Indique el supervisor del servicio');
      if (
        supervisorActual &&
        supervisorId !== supervisorActual &&
        actor.roleCode === ROL_SUPERVISOR
      ) {
        throw new ConflictException(
          'El ticket ya tiene supervisor: solo quien coordina puede cambiarlo',
        );
      }
      if (operadorIds.includes(supervisorId))
        throw new BadRequestException('Una misma persona no puede ser supervisor y operador');

      // las cuentas salen de su tabla maestra: existen, están activas y tienen el rol que corresponde
      const personas = await tx.idUsuario.findMany({
        where: { id: { in: [supervisorId, ...operadorIds] } },
        include: { rol: true },
      });
      const persona = (uid: string, etiqueta: string, roles: string[]) => {
        const u = personas.find((x) => x.id === uid);
        if (!u || !u.activo)
          throw new BadRequestException(`El ${etiqueta} indicado no existe o está inactivo`);
        if (!roles.includes(u.rol.codigo))
          throw new BadRequestException(`${u.nombre} no tiene el rol de ${etiqueta}`);
        return u;
      };
      const supervisor = persona(supervisorId, 'supervisor', [ROL_SUPERVISOR]);
      const equipo = operadores.map((o) => ({
        ...o,
        persona: persona(o.usuarioId, 'operador', ROLES_OPERADOR),
      }));
      // se reemplaza el equipo anterior
      await tx.ticketPersona.deleteMany({ where: { ticketId: id } });
      await tx.ticketPersona.createMany({
        data: [
          {
            ticketId: id,
            usuarioId: supervisor.id,
            rol: 'supervisor' as const,
            asignadoPor: actor.id,
          },
          ...equipo.map((o) => ({
            ticketId: id,
            usuarioId: o.persona.id,
            rol: 'operador' as const,
            asignadoPor: actor.id,
          })),
        ],
      });

      await this.tickets.moverPaso(tx, t, PASO_SIGUIENTE, actor, {
        // el equipo se acaba de guardar: no hay requisitos del paso de asignación
        exigirRequisitos: false,
        motivo: `Asignado: supervisor ${supervisor.nombre}; ${equipo.length} operador(es)`,
      });
      // lo que los pasos siguientes exigen a cada operador
      await this.requisitos.generar(tx, id);

      const n = await tx.ticket.findUniqueOrThrow({
        where: { id },
        include: { cliente: true, campo: true, pozo: true, taladro: true },
      });
      await this.bus.publish(
        tx,
        this.bus.create({
          type: 'operaciones.fcr.asignacion_realizada',
          subject: { type: 'fcr_ticket', id },
          data: {
            ticketId: id,
            ticketNumero: n.ticketNumero,
            pedidoId: n.pedidoId,
            pedidoCodigo: n.pedidoCodigo,
            tipoOt: n.tipoOt,
            cliente: nombreDe(n.cliente),
            campo: n.campo?.nombre ?? null,
            pozo: n.pozo?.nombreCompleto ?? null,
            taladro: n.rigless ? 'RIGLESS' : (n.taladro?.nombre ?? null),
            fechaInicioServicio: n.fechaInicioServicio
              ? n.fechaInicioServicio.toISOString().slice(0, 10)
              : null,
            asignadoPor: actor.name,
            supervisor: supervisor.nombre,
            operadores: equipo.map((o) => o.persona.nombre).join(', '),
            // Las cuentas elegidas: a ellas (y solo a ellas) se les avisa, con la plantilla de su rol de asignación. `operadoresUnidades` conserva
            // la forma que lee QHSE (solo `usuarioId`): FCR no lleva unidades.
            asignados: [
              { usuarioId: supervisor.id, rolCodigo: 'supervisor' },
              ...equipo.map((o) => ({ usuarioId: o.persona.id, rolCodigo: 'operador' })),
            ],
            operadoresUnidades: equipo.map((o) => ({ usuarioId: o.persona.id })),
          },
          actor: { userId: actor.id, role: actor.roleCode },
          traceparent: currentTraceparent(),
        }),
      );
    });
    return this.tickets.detalle(id, actor);
  }
}
