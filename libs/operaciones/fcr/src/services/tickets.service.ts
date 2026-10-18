import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { currentTraceparent, type AuthUser } from '@dyn/common';
import { EventBus, type EventEnvelope } from '@dyn/messaging';
import { uuidv7 } from '@dyn/utils';
import type { Prisma, TipoOt } from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';
import { RequisitosService } from './requisitos.service';

/** Lo que `comercial` publica al abrir un pedido (`comercial.pedido.abierto`) y este módulo necesita. */
export interface PedidoAbiertoData {
  /** Código del pedido (PED-...). */
  codigo: string;
  lineaServicio: string | null;
  /** `venta` o `servicio` (catálogo de comercial). Sin dato se trata como venta: es el recorrido de siempre. */
  tipoOt?: string | null;
  tiposServicio?: string[];
  /** Número de ticket reservado por comercial (el de la prefactura que vendrá). */
  ticketNumero?: number | null;
  /** Solo ids (FK a los catálogos): el nombre se obtiene con JOIN. */
  clienteId?: string | null;
  campoId?: string | null;
  bloqueId?: string | null;
  pozoId?: string | null;
  taladroId?: string | null;
  rigless?: boolean;
  numeroContrato?: string | null;
  fechaInicioServicio?: string | null;
  fechaFinServicio?: string | null;
  as2Numero?: string | null;
}

/** `control_fluidos` -> "Control fluidos" (para leerlo en un correo o en la campanita). */
const textoServicio = (codigo: string) => {
  const t = codigo.replace(/_/g, ' ').trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : codigo;
};

const aDia = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const deDia = (f: string | null | undefined) => (f ? new Date(`${f}T00:00:00.000Z`) : null);
const ROL_SUPERADMIN = 'superadmin';
/** Roles que coordinan el servicio: ven y actúan sin estar en el equipo asignado. */
export const ROLES_COORDINA = [ROL_SUPERADMIN, 'jefe_base'];
/** Rol de cuenta del Supervisor de FCR: toma el ticket al sacarlo de los pasos de arranque. */
export const ROL_SUPERVISOR = 'supervisor';

/** Los nombres salen de las FK (JOIN), no se copian al ticket. */
const NOMBRES = { cliente: true, campo: true, bloque: true, pozo: true, taladro: true } as const;
const INCLUDE_LISTA = {
  ...NOMBRES,
  paso: { include: { roles: true } },
  tiposServicio: true,
} as const;
const INCLUDE_DETALLE = {
  ...NOMBRES,
  paso: {
    include: { roles: true, salidas: { where: { activa: true }, include: { destino: true } } },
  },
  tiposServicio: true,
  tipoOperador: true,
  inspector: { select: { id: true, nombre: true } },
  historial: { include: { actor: true }, orderBy: { createdAt: 'asc' } },
  personas: { include: { usuario: true, vehiculo: true }, orderBy: { usuario: { nombre: 'asc' } } },
  unidades: {
    include: { vehiculo: { include: { tipoVehiculo: true } } },
    orderBy: { vehiculo: { placa: 'asc' } },
  },
} as const;
type TicketLista = Prisma.TicketGetPayload<{ include: typeof INCLUDE_LISTA }>;
type TicketDetalle = Prisma.TicketGetPayload<{ include: typeof INCLUDE_DETALLE }>;
export type TicketParaMover = Prisma.TicketGetPayload<{ include: typeof INCLUDE_DETALLE }>;

export const puedeActuar = (roles: { rolCodigo: string }[], rol: string) =>
  rol === ROL_SUPERADMIN || roles.some((r) => r.rolCodigo === rol);

/** ¿Es del equipo del ticket? El supervisor, los operadores asignados y el operador que inspecciona (SERVICIOS). */
export const esDelEquipo = (
  t: { personas: { usuarioId: string }[]; inspectorId: string | null },
  usuarioId: string,
): boolean => t.inspectorId === usuarioId || t.personas.some((p) => p.usuarioId === usuarioId);

/**
 * ¿Puede esta cuenta actuar en el paso? Además del rol, en los pasos que requieren equipo solo el equipo asignado al ticket (o quien
 * coordina). Los pasos de arranque y los de Bodega los atiende cualquier cuenta de su rol.
 */
export const puedeActuarEn = (
  t: {
    paso: { roles: { rolCodigo: string }[]; requiereEquipo: boolean };
    personas: { usuarioId: string }[];
    inspectorId: string | null;
  },
  actor: { id: string; roleCode: string },
): boolean =>
  puedeActuar(t.paso.roles, actor.roleCode) &&
  (ROLES_COORDINA.includes(actor.roleCode) || !t.paso.requiereEquipo || esDelEquipo(t, actor.id));

/** Nombre del cliente: el fiscal si existe, si no el comercial. */
export const nombreDe = (c: { nombreFiscal: string | null; nombreComercial: string } | null) =>
  c ? (c.nombreFiscal ?? c.nombreComercial) : null;
/** Tipo, marca y modelo del vehículo (p. ej. "CAMION JAC HFC1040K2"); `null` si el catálogo no los tiene. */
export const descripcionVehiculo = (v: {
  marca: string | null;
  modelo: string | null;
  tipoVehiculo: { nombre: string } | null;
}) => [v.tipoVehiculo?.nombre, v.marca, v.modelo].filter(Boolean).join(' ') || null;

const resumen = (t: TicketLista) => ({
  id: t.id,
  ticketNumero: t.ticketNumero,
  pedidoId: t.pedidoId,
  pedidoCodigo: t.pedidoCodigo,
  tipoOt: t.tipoOt,
  paso: {
    codigo: t.pasoCodigo,
    nombre: t.paso.nombre,
    macro: t.paso.macro,
    roles: t.paso.roles.map((r) => r.rolCodigo),
  },
  cliente: nombreDe(t.cliente),
  campo: t.campo?.nombre ?? null,
  pozo: t.pozo?.nombreCompleto ?? null,
  taladro: t.rigless ? 'RIGLESS' : (t.taladro?.nombre ?? null),
  tiposServicio: t.tiposServicio.map((x) => x.tipoCodigo).sort(),
  fechaInicioServicio: aDia(t.fechaInicioServicio),
  createdAt: t.createdAt,
});

export interface MoverOpciones {
  motivo?: string | null;
  /** Falso en los rechazos y en lo que el propio servicio ya validó. */
  exigirRequisitos?: boolean;
  /** Si no se indica, el rol con el que actúa la cuenta. */
  origen?: 'manual' | 'sistema';
}

/**
 * Ticket de servicio de FCR. Nace del pedido abierto de la línea (uno por pedido, sin duplicar aunque el evento llegue dos veces) por el
 * paso que corresponde a su tipo de OT, y lo llevan los roles de cada paso. Los pasos válidos, sus responsables y los dos recorridos
 * viven en la base de datos.
 */
@Injectable()
export class TicketsService {
  private readonly logger = new Logger(TicketsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: EventBus,
    private readonly requisitos: RequisitosService,
  ) {}

  /** Crea el ticket de un pedido de FCR abierto. `null` si el pedido no es de FCR o ya tiene su ticket. */
  async crearDesdePedido(
    tx: Prisma.TransactionClient,
    event: EventEnvelope<PedidoAbiertoData>,
  ): Promise<{ ticketId: string; pedidoCodigo: string } | null> {
    const d = event.data;
    if (d.lineaServicio !== 'fcr') return null;
    const pedidoId = event.subject.id;
    if (await tx.ticket.findUnique({ where: { pedidoId }, select: { id: true } })) return null;

    const tipoOt: TipoOt = d.tipoOt === 'servicio' ? 'servicio' : 'venta';
    if (d.tipoOt !== 'servicio' && d.tipoOt !== 'venta') {
      this.logger.warn(`Pedido ${d.codigo}: sin tipo de OT; se trata como venta`);
    }
    const entrada = await tx.entradaOt.findUniqueOrThrow({ where: { tipoOt } });
    const creador = event.actor?.userId;
    const id = uuidv7();
    await tx.ticket.create({
      data: {
        id,
        pedidoId,
        pedidoCodigo: d.codigo,
        ticketNumero: d.ticketNumero ?? null,
        pasoCodigo: entrada.pasoCodigo,
        tipoOt,
        clienteId: d.clienteId ?? null,
        campoId: d.campoId ?? null,
        bloqueId: d.bloqueId ?? null,
        pozoId: d.pozoId ?? null,
        taladroId: d.taladroId ?? null,
        rigless: d.rigless ?? false,
        numeroContrato: d.numeroContrato ?? null,
        as2Numero: d.as2Numero ?? null,
        fechaInicioServicio: deDia(d.fechaInicioServicio),
        fechaFinServicio: deDia(d.fechaFinServicio),
        // quien abrió el pedido (si la cuenta existe en identidad; si no, queda sin autor)
        createdBy: creador && (await this.existeCuenta(tx, creador)) ? creador : null,
        tiposServicio: {
          create: [...new Set(d.tiposServicio ?? [])].map((tipoCodigo) => ({ tipoCodigo })),
        },
        historial: {
          create: {
            id: uuidv7(),
            pasoAnterior: null,
            pasoNuevo: entrada.pasoCodigo,
            motivo: 'Pedido abierto',
            origen: 'sistema',
          },
        },
      },
    });
    // los requisitos del ticket (los de unidad u operador se crean al asignar el equipo)
    await this.requisitos.generar(tx, id);

    // el evento lleva los nombres ya resueltos (los avisos los muestran tal cual), obtenidos de los catálogos por las FK
    const n = await tx.ticket.findUniqueOrThrow({ where: { id }, include: NOMBRES });
    await this.bus.publish(
      tx,
      this.bus.create({
        type: 'operaciones.fcr.ticket_creado',
        subject: { type: 'fcr_ticket', id },
        data: {
          ticketId: id,
          ticketNumero: d.ticketNumero ?? null,
          pedidoId,
          pedidoCodigo: d.codigo,
          tipoOt,
          paso: entrada.pasoCodigo,
          cliente: nombreDe(n.cliente),
          campo: n.campo?.nombre ?? null,
          pozo: n.pozo?.nombreCompleto ?? null,
          taladro: d.rigless ? 'RIGLESS' : (n.taladro?.nombre ?? null),
          tiposServicio: [...new Set(d.tiposServicio ?? [])],
          servicios: [...new Set(d.tiposServicio ?? [])].map(textoServicio).join(', '),
          fechaInicioServicio: d.fechaInicioServicio ?? null,
        },
        causationId: event.id,
        correlationId: event.correlationId,
        traceparent: currentTraceparent(),
      }),
    );
    return { ticketId: id, pedidoCodigo: d.codigo };
  }

  /**
   * Bandeja: todos los tickets, o los que esperan a un rol (`rol`), o de un paso. Con `rol` y `usuarioId` quien no coordina ve solo los
   * pasos sin equipo y los tickets de los que es parte del equipo. Se busca por número de ticket, pedido, cliente o pozo.
   */
  async listar(f: { paso?: string; rol?: string; usuarioId?: string; q?: string }) {
    const q = f.q?.trim();
    const y: Prisma.TicketWhereInput[] = [];
    if (f.paso) y.push({ pasoCodigo: f.paso });
    if (f.rol) {
      y.push({ paso: { roles: { some: { rolCodigo: f.rol } } } });
      if (f.usuarioId && !ROLES_COORDINA.includes(f.rol)) {
        y.push({
          OR: [
            { paso: { requiereEquipo: false } },
            { personas: { some: { usuarioId: f.usuarioId } } },
            { inspectorId: f.usuarioId },
          ],
        });
      }
    }
    if (q) {
      y.push({
        OR: [
          ...(/^\d{1,9}$/.test(q) ? [{ ticketNumero: Number(q) }] : []),
          { pedidoCodigo: { contains: q, mode: 'insensitive' } },
          {
            cliente: {
              OR: [
                { nombreFiscal: { contains: q, mode: 'insensitive' } },
                { nombreComercial: { contains: q, mode: 'insensitive' } },
              ],
            },
          },
          { pozo: { nombreCompleto: { contains: q, mode: 'insensitive' } } },
        ],
      });
    }
    const filas = await this.prisma.ticket.findMany({
      where: y.length ? { AND: y } : {},
      include: INCLUDE_LISTA,
      orderBy: { createdAt: 'desc' },
      take: 300,
    });
    return filas.map(resumen);
  }

  async detalle(id: string, actor: AuthUser) {
    const t = await this.cargar(id);
    return { ...this.aDetalle(t, actor), requisitos: await this.requisitos.estado(id) };
  }

  /** Pasa el ticket al siguiente paso. Solo los roles del paso actual (y Superadmin) pueden hacerlo. */
  async avanzar(id: string, hacia: string, actor: AuthUser, motivo?: string) {
    await this.prisma.$transaction(async (tx) => {
      const t = await this.cargarEnTx(tx, id);
      this.exigirActuar(t, actor);
      const salida = t.paso.salidas.find((s) => s.destinoCodigo === hacia);
      if (!salida) {
        throw new ConflictException(`Desde "${t.paso.nombre}" no se puede pasar a "${hacia}"`);
      }
      if (salida.requiereMotivo && !motivo?.trim())
        throw new BadRequestException('El motivo es obligatorio');
      await this.moverPaso(tx, t, hacia, actor, {
        motivo,
        exigirRequisitos: salida.exigeRequisitos,
      });
    });
    return this.detalle(id, actor);
  }

  /** El rol del paso y el equipo asignado: lo que cualquier acción sobre el ticket debe comprobar primero. */
  exigirActuar(t: TicketParaMover, actor: AuthUser): void {
    if (!puedeActuar(t.paso.roles, actor.roleCode)) {
      throw new ForbiddenException(`El paso "${t.paso.nombre}" lo atiende otro rol`);
    }
    if (!puedeActuarEn(t, actor)) {
      throw new ForbiddenException('Solo el equipo asignado a este ticket puede hacerlo');
    }
  }

  /**
   * Mueve el ticket a otro paso dentro de la transacción de quien llama: valida requisitos (si corresponde), cambia el paso con control
   * de concurrencia, deja el historial y publica los eventos. Sin comprobar roles ni transiciones: eso es de quien llama.
   * Al sacarlo de un paso de arranque, el Supervisor que lo mueve toma el ticket (queda como su supervisor).
   */
  async moverPaso(
    tx: Prisma.TransactionClient,
    t: TicketParaMover,
    hacia: string,
    actor: AuthUser,
    o: MoverOpciones = {},
  ): Promise<void> {
    if (o.exigirRequisitos ?? true) {
      await this.requisitos.exigirCumplidos(tx, t.id, t.pasoCodigo, t.paso.nombre);
    }
    const r = await tx.ticket.updateMany({
      where: { id: t.id, pasoCodigo: t.pasoCodigo },
      data: { pasoCodigo: hacia, version: { increment: 1 }, updatedBy: actor.id },
    });
    if (r.count === 0) throw new ConflictException('El ticket cambió de paso; vuelva a intentarlo');
    await tx.ticketHistorial.create({
      data: {
        id: uuidv7(),
        ticketId: t.id,
        pasoAnterior: t.pasoCodigo,
        pasoNuevo: hacia,
        motivo: o.motivo?.trim() || null,
        actorId: actor.id,
        actorRol: actor.roleCode,
        origen: o.origen ?? 'manual',
      },
    });
    if (!t.paso.requiereEquipo && actor.roleCode === ROL_SUPERVISOR) {
      await this.tomar(tx, t, actor);
    }
    await this.bus.publish(
      tx,
      this.bus.create({
        type: 'operaciones.fcr.paso_cambiado',
        subject: { type: 'fcr_ticket', id: t.id },
        data: { ticketId: t.id, pedidoId: t.pedidoId, desde: t.pasoCodigo, hacia },
        actor: { userId: actor.id, role: actor.roleCode },
        traceparent: currentTraceparent(),
      }),
    );
    // el cierre del servicio: Comercial genera la prefactura con lo que el ticket dejó (contrato 4.10)
    if (hacia === 'cerrado') {
      await this.bus.publish(
        tx,
        this.bus.create({
          type: 'operaciones.fcr.cerrado',
          subject: { type: 'fcr_ticket', id: t.id },
          data: { ticketId: t.id, ticketNumero: t.ticketNumero, pedidoId: t.pedidoId },
          actor: { userId: actor.id, role: actor.roleCode },
          traceparent: currentTraceparent(),
        }),
      );
    }
  }

  /** El Supervisor que saca el ticket de un paso de arranque queda como su supervisor (si aún no tiene uno). */
  private async tomar(
    tx: Prisma.TransactionClient,
    t: TicketParaMover,
    actor: AuthUser,
  ): Promise<void> {
    if (t.personas.some((p) => p.rol === 'supervisor')) return;
    await tx.ticketPersona.create({
      data: { ticketId: t.id, usuarioId: actor.id, rol: 'supervisor', asignadoPor: actor.id },
    });
  }

  async cargarEnTx(tx: Prisma.TransactionClient, id: string): Promise<TicketParaMover> {
    const t = await tx.ticket.findUnique({ where: { id }, include: INCLUDE_DETALLE });
    if (!t) throw new NotFoundException('El ticket no existe');
    return t;
  }

  private async cargar(id: string): Promise<TicketDetalle> {
    const t = await this.prisma.ticket.findUnique({ where: { id }, include: INCLUDE_DETALLE });
    if (!t) throw new NotFoundException('El ticket no existe');
    return t;
  }

  private async existeCuenta(tx: Prisma.TransactionClient, id: string): Promise<boolean> {
    return (await tx.idUsuario.count({ where: { id } })) > 0;
  }

  private aDetalle(t: TicketDetalle, actor: AuthUser) {
    const actua = puedeActuarEn(t, actor);
    return {
      ...resumen(t),
      numeroContrato: t.numeroContrato,
      as2Numero: t.as2Numero,
      clienteRuc: t.cliente?.identificacion ?? null,
      bloque: t.bloque?.nombre ?? null,
      fechaFinServicio: aDia(t.fechaFinServicio),
      version: t.version,
      /** Mecánico o soldador y operador que inspecciona (solo entrada SERVICIOS). */
      tipoOperador: t.tipoOperador
        ? { id: t.tipoOperador.id, codigo: t.tipoOperador.codigo, nombre: t.tipoOperador.nombre }
        : null,
      inspector: t.inspector ? { usuarioId: t.inspector.id, nombre: t.inspector.nombre } : null,
      /** ¿Esta persona es de un rol que atiende el paso actual y, si el paso lo exige, es del equipo? */
      puedeActuar: actua,
      /** Pasos a los que puede pasar el ticket desde aquí (solo si la persona puede actuar en el paso). */
      siguientes: actua
        ? t.paso.salidas.map((s) => ({
            codigo: s.destinoCodigo,
            nombre: s.destino.nombre,
            requiereMotivo: s.requiereMotivo,
          }))
        : [],
      asignacion: {
        supervisor:
          t.personas
            .filter((p) => p.rol === 'supervisor')
            .map((p) => ({ usuarioId: p.usuarioId, nombre: p.usuario.nombre }))[0] ?? null,
        operadores: t.personas
          .filter((p) => p.rol === 'operador')
          .map((p) => ({
            usuarioId: p.usuarioId,
            nombre: p.usuario.nombre,
            vehiculoId: p.vehiculoId,
            placa: p.vehiculo?.placa ?? null,
          })),
        unidades: t.unidades.map((u) => ({
          vehiculoId: u.vehiculoId,
          placa: u.vehiculo.placa,
          descripcion: descripcionVehiculo(u.vehiculo),
        })),
      },
      historial: t.historial.map((h) => ({
        pasoAnterior: h.pasoAnterior,
        pasoNuevo: h.pasoNuevo,
        motivo: h.motivo,
        actor: h.actor ? { nombre: h.actor.nombre, rol: h.actorRol } : null,
        origen: h.origen,
        at: h.createdAt,
      })),
    };
  }
}
