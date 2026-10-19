import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { currentTraceparent, type AuthUser } from '@dyn/common';
import { MovimientosService, type LineaDeTicket } from '@dyn/inventario';
import { EventBus } from '@dyn/messaging';
import { uuidv7 } from '@dyn/utils';
import { PrismaService } from '../prisma/prisma.service';
import { IngresoService } from './ingreso.service';
import { RequisitosService } from './requisitos.service';
import { nombreDe, puedeActuar, TicketsService } from './tickets.service';

/**
 * Lo que el Jefe de Base elige: solo ids. Cada operador lleva su unidad (como en la demo); las unidades del servicio son las de sus
 * operadores. Los químicos (artículo, bodega y cantidad) salen de bodega al asignar y exigen el documento de mezcla.
 */
export interface AsignacionEntrada {
  supervisorId: string;
  operadores: Array<{ usuarioId: string; vehiculoId: string }>;
  quimicos?: LineaDeTicket[];
  /** Archivo (de `archivos`) con el documento de mezcla: obligatorio si hay químicos. */
  documentoMezclaId?: string | null;
}

/** Paso en el que el Jefe de Base asigna, y paso al que pasa el ticket cuando la asignación queda completa. */
const PASO_ASIGNACION = 'asignacion';
const PASO_SIGUIENTE = 'traslado_salida';
/** Roles de cuenta que pueden ser supervisor / operador de un servicio. */
const ROLES_SUPERVISOR = ['supervisor', 'supervisor_pumping'];
const ROLES_OPERADOR = ['operador'];

/**
 * Asignación del Jefe de Base: supervisor y operadores, cada uno con su unidad. Al completarla el ticket pasa a "Traslado de salida",
 * se crean los requisitos de ese paso y se publica `operaciones.pumping.asignacion_realizada` con las cuentas elegidas, para
 * avisarles a ellas (no a todos los de su rol) y para que QHSE y Mantenimiento abran lo suyo.
 */
@Injectable()
export class AsignacionService {
  private readonly logger = new Logger(AsignacionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: EventBus,
    private readonly tickets: TicketsService,
    private readonly requisitos: RequisitosService,
    private readonly ingreso: IngresoService,
    private readonly inventario: MovimientosService,
  ) {}

  async asignar(id: string, entrada: AsignacionEntrada, actor: AuthUser) {
    const { supervisorId, operadores, quimicos = [], documentoMezclaId = null } = entrada;
    const operadorIds = operadores.map((o) => o.usuarioId);
    const personasIds = [supervisorId, ...operadorIds];
    if (!operadores.length) throw new BadRequestException('Indique al menos un operador');
    if (new Set(personasIds).size !== personasIds.length)
      throw new BadRequestException('Una misma persona no puede asignarse dos veces');
    const unidadIds = [...new Set(operadores.map((o) => o.vehiculoId))];
    if (quimicos.length && !documentoMezclaId) {
      throw new BadRequestException({
        message: 'Adjunte el documento de mezcla: es obligatorio cuando se asignan químicos',
        code: 'MEZCLA_REQUERIDA',
      });
    }

    // Los químicos salen de bodega en la transacción de Inventario (Pumping no puede compartir la suya). Si algo falla después de la
    // salida, se deshace con una devolución: el kardex no se borra.
    let salidas: Array<{ articuloId: string; cantidad: number }> = [];
    try {
      await this.asignarEnTransaccion(
        id,
        supervisorId,
        operadores,
        unidadIds,
        personasIds,
        quimicos,
        documentoMezclaId,
        actor,
        (s) => (salidas = s),
      );
    } catch (e) {
      if (salidas.length) await this.deshacerSalida(id, quimicos, actor);
      throw e;
    }
    return this.tickets.detalle(id, actor);
  }

  private async deshacerSalida(ticketId: string, quimicos: LineaDeTicket[], actor: AuthUser) {
    try {
      await this.inventario.devolverDeTicket(
        ticketId,
        quimicos,
        actor,
        'Se deshace la salida: la asignación no se completó',
      );
    } catch (e) {
      // lo que queda a cargo del ticket se ve en su balance y se devuelve desde el control de retorno
      this.logger.error(
        `No se pudo deshacer la salida de químicos del ticket ${ticketId}: ${String(e)}`,
      );
    }
  }

  private async asignarEnTransaccion(
    id: string,
    supervisorId: string,
    operadores: AsignacionEntrada['operadores'],
    unidadIds: string[],
    personasIds: string[],
    quimicos: LineaDeTicket[],
    documentoMezclaId: string | null,
    actor: AuthUser,
    alSalir: (s: Array<{ articuloId: string; cantidad: number }>) => void,
  ) {
    await this.prisma.$transaction(async (tx) => {
      const t = await tx.ticket.findUnique({
        where: { id },
        include: {
          paso: { include: { roles: true } },
          cliente: true,
          campo: true,
          pozo: true,
          taladro: true,
        },
      });
      if (!t) throw new NotFoundException('El ticket no existe');
      if (!puedeActuar(t.paso.roles, actor.roleCode)) {
        throw new ForbiddenException(`El paso "${t.paso.nombre}" lo atiende otro rol`);
      }
      if (t.pasoCodigo !== PASO_ASIGNACION) {
        throw new ConflictException('El ticket no está en el paso de Asignación');
      }

      // las cuentas y las unidades salen de sus tablas maestras: existen, están activas y tienen el rol que corresponde
      const personas = await tx.idUsuario.findMany({
        where: { id: { in: personasIds } },
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
      const supervisor = persona(supervisorId, 'supervisor', ROLES_SUPERVISOR);
      const equipo = operadores.map((o) => ({
        ...o,
        persona: persona(o.usuarioId, 'operador', ROLES_OPERADOR),
      }));
      const unidades = await tx.catVehiculo.findMany({ where: { id: { in: unidadIds } } });
      if (unidades.length !== unidadIds.length || unidades.some((u) => !u.habilitado)) {
        throw new BadRequestException(
          'Alguna de las unidades indicadas no existe o no está habilitada',
        );
      }

      if (documentoMezclaId) {
        const archivo = await tx.archivoRef.findUnique({ where: { id: documentoMezclaId } });
        if (!archivo) throw new BadRequestException('El documento de mezcla no existe');
      }

      // se reemplaza lo anterior: primero las personas (apuntan a la unidad) y después las unidades
      await tx.ticketPersona.deleteMany({ where: { ticketId: id } });
      await tx.ticketUnidad.deleteMany({ where: { ticketId: id } });
      await tx.ticketUnidad.createMany({
        data: unidades.map((u) => ({ ticketId: id, vehiculoId: u.id, asignadoPor: actor.id })),
      });
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
            vehiculoId: o.vehiculoId,
            asignadoPor: actor.id,
          })),
        ],
      });

      const r = await tx.ticket.updateMany({
        where: { id, pasoCodigo: PASO_ASIGNACION },
        data: { pasoCodigo: PASO_SIGUIENTE, version: { increment: 1 } },
      });
      if (r.count === 0)
        throw new ConflictException('El ticket cambió de paso; vuelva a intentarlo');
      await tx.ticketHistorial.create({
        data: {
          id: uuidv7(),
          ticketId: id,
          pasoAnterior: PASO_ASIGNACION,
          pasoNuevo: PASO_SIGUIENTE,
          motivo: `Asignado: supervisor ${supervisor.nombre}; ${equipo.length} operador(es); ${unidades.length} unidad(es)`,
          actorId: actor.id,
          actorRol: actor.roleCode,
          origen: 'manual',
        },
      });

      // lo que el paso siguiente exige y el checklist de ingreso que se llenará allí
      await this.requisitos.generar(tx, id);
      await this.ingreso.crear(tx, id);

      // químicos: salen de bodega a cargo del ticket (todos o ninguno); el documento de mezcla queda adjunto al ticket
      if (quimicos.length) {
        alSalir(
          await this.inventario.registrarSalidasDeTicket(
            id,
            quimicos,
            actor,
            `Asignación del ticket ${t.ticketNumero ?? t.pedidoCodigo}`,
          ),
        );
        await tx.ticketDocumento.create({
          data: {
            id: uuidv7(),
            ticketId: id,
            tipo: 'mezcla_quimica',
            archivoId: documentoMezclaId as string,
            createdBy: actor.id,
          },
        });
      }

      const placaDe = (vid: string) => unidades.find((u) => u.id === vid)?.placa ?? '';
      await this.bus.publish(
        tx,
        this.bus.create({
          type: 'operaciones.pumping.asignacion_realizada',
          subject: { type: 'pumping_ticket', id },
          data: {
            ticketId: id,
            ticketNumero: t.ticketNumero,
            pedidoId: t.pedidoId,
            pedidoCodigo: t.pedidoCodigo,
            cliente: nombreDe(t.cliente),
            campo: t.campo?.nombre ?? null,
            pozo: t.pozo?.nombreCompleto ?? null,
            taladro: t.rigless ? 'RIGLESS' : (t.taladro?.nombre ?? null),
            fechaInicioServicio: t.fechaInicioServicio
              ? t.fechaInicioServicio.toISOString().slice(0, 10)
              : null,
            asignadoPor: actor.name,
            supervisor: supervisor.nombre,
            operadores: equipo
              .map((o) => `${o.persona.nombre} (${placaDe(o.vehiculoId)})`)
              .join(', '),
            unidades: unidades.map((u) => u.placa).join(', '),
            // Las cuentas elegidas: a ellas (y solo a ellas) se les avisa, con la plantilla de su rol de asignación. Los demás módulos
            // (QHSE: EPI de cada operador; Mantenimiento: inspección de cada unidad) abren sus casos con `operadores` y `unidadesIds`.
            asignados: [
              { usuarioId: supervisor.id, rolCodigo: 'supervisor' },
              ...equipo.map((o) => ({ usuarioId: o.persona.id, rolCodigo: 'operador' })),
            ],
            operadoresUnidades: equipo.map((o) => ({
              usuarioId: o.persona.id,
              vehiculoId: o.vehiculoId,
            })),
            conQuimicos: quimicos.length > 0,
          },
          actor: { userId: actor.id, role: actor.roleCode },
          traceparent: currentTraceparent(),
        }),
      );
    });
  }
}
