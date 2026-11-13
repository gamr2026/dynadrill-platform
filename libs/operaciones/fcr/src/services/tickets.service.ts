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
import { PASO_ANULADO } from '../catalog/sembrar-pasos';
import { PrecargaService, type LineaPedido } from './precarga.service';
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
  /** Bodega del pedido (solo el id): QHSE la usa para prellenar la entrega de EPI. */
  bodegaId?: string | null;
  rigless?: boolean;
  numeroContrato?: string | null;
  fechaInicioServicio?: string | null;
  fechaFinServicio?: string | null;
  as2Numero?: string | null;
  /** Las líneas cotizadas: de ellas sale la precarga de herramientas. */
  lineas?: LineaPedido[];
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
/** Roles que supervisan el ticket: los de FCR que lo llevan y quienes coordinan. Exoneran requisitos y asignan o reasignan al responsable. */
export const ROLES_SUPERVISAN = [
  ...ROLES_COORDINA,
  'supervisor',
  'supervisor_operaciones_fcr',
] as const;
/** Rol de cuenta del Supervisor de FCR: toma el ticket al sacarlo de los pasos de arranque. */
export const ROL_SUPERVISOR = 'supervisor';

/** Los nombres salen de las FK (JOIN), no se copian al ticket. */
const NOMBRES = { cliente: true, campo: true, bloque: true, pozo: true, taladro: true } as const;
const INCLUDE_LISTA = {
  ...NOMBRES,
  responsable: { select: { id: true, nombre: true } },
  paso: { include: { roles: true } },
  tiposServicio: true,
} as const;
const INCLUDE_DETALLE = {
  ...NOMBRES,
  responsable: { select: { id: true, nombre: true } },
  paso: {
    include: {
      roles: true,
      salidas: {
        where: { activa: true, soloPorAccion: false },
        include: { destino: true },
      },
    },
  },
  tiposServicio: true,
  tipoOperador: true,
  inspector: { select: { id: true, nombre: true } },
  historial: { include: { actor: true }, orderBy: { createdAt: 'asc' } },
  personas: { include: { usuario: true }, orderBy: { usuario: { nombre: 'asc' } } },
} as const;
type TicketLista = Prisma.TicketGetPayload<{ include: typeof INCLUDE_LISTA }>;
type TicketDetalle = Prisma.TicketGetPayload<{ include: typeof INCLUDE_DETALLE }>;
export type TicketParaMover = Prisma.TicketGetPayload<{ include: typeof INCLUDE_DETALLE }>;

/**
 * Un ticket anulado (el pedido se anuló) es de solo lectura: toda acción que lo cambia lo rechaza con este 409. Lo comprueba `cargarEnTx`,
 * por donde pasan las acciones de escritura, y las que cargan el ticket por su cuenta lo llaman directamente.
 */
export function exigirNoAnulado(pasoCodigo: string): void {
  if (pasoCodigo === PASO_ANULADO) {
    throw new ConflictException({
      message: 'El ticket está anulado porque se anuló el pedido: ya no admite cambios',
      code: 'TICKET_ANULADO',
    });
  }
}

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
  /** Supervisor de FCR a quien le pertenece el ticket en la bandeja (`null`: sin asignar). No restringe quién lo ve. */
  responsableId: t.responsableId,
  responsableNombre: t.responsable?.nombre ?? null,
  fechaInicioServicio: aDia(t.fechaInicioServicio),
  createdAt: t.createdAt,
});

export interface MoverOpciones {
  motivo?: string | null;
  /** Falso en los rechazos y en lo que el propio servicio ya validó. */
  exigirRequisitos?: boolean;
  /** Si no se indica, el rol con el que actúa la cuenta. */
  origen?: 'manual' | 'sistema';
  /** Solo al cerrar: el correo del cliente al que se envía la encuesta de satisfacción. */
  correoCliente?: string;
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
    private readonly precarga: PrecargaService,
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
    const actorId = event.actor?.userId;
    // quien abrió el pedido, si es una cuenta de identidad; si no, la creación queda sin autor
    const creador = actorId && (await this.existeCuenta(tx, actorId)) ? actorId : null;
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
        bodegaId: d.bodegaId ?? null,
        rigless: d.rigless ?? false,
        numeroContrato: d.numeroContrato ?? null,
        as2Numero: d.as2Numero ?? null,
        fechaInicioServicio: deDia(d.fechaInicioServicio),
        fechaFinServicio: deDia(d.fechaFinServicio),
        createdBy: creador,
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
    // los requisitos del ticket (los de operador se crean al asignar el equipo)
    await this.requisitos.generar(tx, id);
    // las líneas del pedido y la precarga de herramientas desde su configuración por cliente y código
    await this.precarga.guardarLineas(tx, id, d.lineas ?? []);
    await this.precarga.armar(tx, id, creador);
    await this.requisitos.sincronizarDeHerramientas(tx, id, creador);

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
          bodegaId: n.bodegaId,
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
   * El pedido cambió en `comercial` (`comercial.pedido.actualizado`): se actualizan las fechas del servicio y, si cambiaron los ítems, las
   * líneas del ticket. Las herramientas NO se tocan solas: el Supervisor decide cuándo «Recargar desde el pedido» (consulta F-13).
   * Un ticket ya cerrado no cambia.
   */
  async actualizarDesdePedido(
    tx: Prisma.TransactionClient,
    event: EventEnvelope<Partial<PedidoAbiertoData>>,
  ): Promise<boolean> {
    const t = await tx.ticket.findUnique({
      where: { pedidoId: event.subject.id },
      select: { id: true, paso: { select: { terminal: true } } },
    });
    if (!t || t.paso.terminal) return false;
    const d = event.data;
    const fechas = {
      ...(d.fechaInicioServicio !== undefined
        ? { fechaInicioServicio: deDia(d.fechaInicioServicio) }
        : {}),
      ...(d.fechaFinServicio !== undefined ? { fechaFinServicio: deDia(d.fechaFinServicio) } : {}),
    };
    const bodega = d.bodegaId !== undefined ? { bodegaId: d.bodegaId } : {};
    const cambios = { ...fechas, ...bodega };
    if (Object.keys(cambios).length) await tx.ticket.update({ where: { id: t.id }, data: cambios });
    if (Array.isArray(d.lineas)) await this.precarga.guardarLineas(tx, t.id, d.lineas);
    return true;
  }

  /**
   * El pedido se anuló en `comercial` (`comercial.pedido.anulado`): el ticket pasa al paso terminal «anulado» (lo hace el sistema, con el motivo
   * y el actor del evento), queda de solo lectura y sale de las revisiones periódicas (que solo miran tickets abiertos). Publica
   * `operaciones.fcr.ticket_anulado` con las herramientas que ya se habían solicitado a Bodega, para que Inventario pueda cancelar la solicitud de
   * despacho. Un ticket que no existe (el pedido no era de FCR), que ya está anulado o que ya se cerró no cambia. Idempotente.
   */
  async anularDesdePedido(
    tx: Prisma.TransactionClient,
    event: EventEnvelope<{ codigo?: string; motivo?: string | null }>,
  ): Promise<boolean> {
    const t = await tx.ticket.findUnique({
      where: { pedidoId: event.subject.id },
      include: { paso: true, personas: true },
    });
    if (!t || t.pasoCodigo === PASO_ANULADO) return false;
    if (t.paso.terminal) {
      this.logger.warn(
        `Pedido ${t.pedidoCodigo} anulado, pero su ticket ya está cerrado: no se anula`,
      );
      return false;
    }
    const motivo = event.data.motivo?.trim() || 'Pedido anulado';
    const actorId = event.actor?.userId;
    const actor = actorId && (await this.existeCuenta(tx, actorId)) ? actorId : null;
    const r = await tx.ticket.updateMany({
      where: { id: t.id, pasoCodigo: t.pasoCodigo },
      data: { pasoCodigo: PASO_ANULADO, version: { increment: 1 }, updatedBy: actor },
    });
    if (r.count === 0) throw new ConflictException('El ticket cambió de paso; vuelva a intentarlo');
    await tx.ticketHistorial.create({
      data: {
        id: uuidv7(),
        ticketId: t.id,
        pasoAnterior: t.pasoCodigo,
        pasoNuevo: PASO_ANULADO,
        motivo,
        actorId: actor,
        actorRol: actor ? (event.actor?.role ?? null) : null,
        origen: 'sistema',
      },
    });
    // lo que Inventario necesita para cancelar la solicitud de despacho: las herramientas solicitadas a Bodega que siguen en el ticket
    const solicitadas = await tx.ticketHerramienta.findMany({
      where: { ticketId: t.id, solicitadaAt: { not: null }, devueltaAt: null, faltanteAt: null },
      include: { articulo: { select: { codigo: true, nombre: true } } },
      orderBy: { createdAt: 'asc' },
    });
    await this.bus.publish(
      tx,
      this.bus.create({
        type: 'operaciones.fcr.ticket_anulado',
        subject: { type: 'fcr_ticket', id: t.id },
        data: {
          ticketId: t.id,
          ticketNumero: t.ticketNumero,
          pedidoId: t.pedidoId,
          pedidoCodigo: t.pedidoCodigo,
          motivo,
          pasoAnterior: t.pasoCodigo,
          anuladoPorId: actor,
          anuladoAt: new Date().toISOString(),
          // se le avisa al equipo del ticket y a quien lo tenía en su bandeja
          responsableId: t.responsableId,
          asignados: t.personas
            .filter((p) => p.rol === 'supervisor' || p.rol === 'operador')
            .map((p) => ({ usuarioId: p.usuarioId, rolCodigo: p.rol })),
          // `enviada`: Bodega ya la despachó, así que además de cancelar la solicitud hay que recuperarla; si no, solo se cancela
          herramientasSolicitadas: solicitadas.map((h) => ({
            herramientaId: h.id,
            articuloId: h.articuloId,
            codigo: h.articulo.codigo,
            descripcion: h.articulo.nombre,
            numeroSerie: h.numeroSerie,
            solicitadaAt: h.solicitadaAt?.toISOString() ?? null,
            enviada: h.enviadaAt !== null,
            recibida: h.recibidaAt !== null,
          })),
          cancelarDespacho: solicitadas.some((h) => h.enviadaAt === null),
        },
        causationId: event.id,
        correlationId: event.correlationId,
        ...(actor ? { actor: { userId: actor, role: event.actor?.role ?? '' } } : {}),
        traceparent: currentTraceparent(),
      }),
    );
    return true;
  }

  /**
   * Bandeja: todos los tickets, o los que esperan a un rol (`rol`), o de un paso, o los de un responsable (`bandeja`; no restringe la visibilidad). Con `rol` y `usuarioId` quien no coordina ve solo los
   * pasos sin equipo y los tickets de los que es parte del equipo. Se busca por número de ticket, pedido, cliente o pozo.
   */
  async listar(f: {
    paso?: string;
    rol?: string;
    usuarioId?: string;
    q?: string;
    /** `mias`: las que tiene a su cargo `usuarioId`; `sin_asignar`: las que no tienen responsable; `todas` (o sin valor): sin filtro. */
    bandeja?: 'mias' | 'sin_asignar' | 'todas';
  }) {
    const q = f.q?.trim();
    const y: Prisma.TicketWhereInput[] = [];
    if (f.paso) y.push({ pasoCodigo: f.paso });
    if (f.bandeja === 'mias') y.push({ responsableId: f.usuarioId ?? null });
    if (f.bandeja === 'sin_asignar') y.push({ responsableId: null });
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
  async avanzar(
    id: string,
    hacia: string,
    actor: AuthUser,
    motivo?: string,
    correoCliente?: string,
  ) {
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
        ...(hacia === 'cerrado' ? { correoCliente: this.correoDelCliente(correoCliente) } : {}),
      });
    });
    return this.detalle(id, actor);
  }

  /** Al cerrar se pide el correo del cliente: la encuesta de satisfacción se le envía a esa dirección. */
  private correoDelCliente(correo?: string): string {
    const c = correo?.trim().toLowerCase();
    if (!c) {
      throw new BadRequestException(
        'Escriba el correo del cliente: a esa dirección se enviará la encuesta de satisfacción',
      );
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(c)) {
      throw new BadRequestException('El correo del cliente no es válido');
    }
    return c;
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
    // la inspección de SERVICIOS llega al Supervisor de Operaciones FCR: se le avisa a todo su rol
    if (hacia === 'aprobacion_supervisor_operaciones') {
      const n = await tx.ticket.findUniqueOrThrow({
        where: { id: t.id },
        include: { cliente: true, pozo: true },
      });
      await this.bus.publish(
        tx,
        this.bus.create({
          type: 'operaciones.fcr.aprobacion_solicitada',
          subject: { type: 'fcr_ticket', id: t.id },
          data: {
            ticketId: t.id,
            ticketNumero: n.ticketNumero,
            pedidoId: n.pedidoId,
            pedidoCodigo: n.pedidoCodigo,
            cliente: nombreDe(n.cliente),
            pozo: n.pozo?.nombreCompleto ?? null,
            enviadoPor: actor.name,
          },
          actor: { userId: actor.id, role: actor.roleCode },
          traceparent: currentTraceparent(),
        }),
      );
    }
    // el cierre del servicio: Comercial genera la prefactura con lo que el ticket dejó (contrato 4.10)
    if (hacia === 'cerrado') {
      const n = await tx.ticket.findUniqueOrThrow({
        where: { id: t.id },
        include: { cliente: true, pozo: true },
      });
      await this.bus.publish(
        tx,
        this.bus.create({
          type: 'operaciones.fcr.cerrado',
          subject: { type: 'fcr_ticket', id: t.id },
          data: {
            ticketId: t.id,
            ticketNumero: t.ticketNumero,
            pedidoId: t.pedidoId,
            // a este correo del cliente se envía la encuesta de satisfacción (plataforma); FCR no lo guarda: viaja solo en el evento
            correoCliente: o.correoCliente ?? null,
            cliente: nombreDe(n.cliente),
            pozo: n.pozo?.nombreCompleto ?? null,
          },
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
    // también queda como su responsable en la bandeja, si nadie lo era
    if (t.responsableId === null) {
      await this.cambiarResponsable(tx, t, actor.id, actor, {
        accion: 'tomar',
        motivo: 'Tomó el ticket al sacarlo del paso de arranque',
      });
    }
    if (t.personas.some((p) => p.rol === 'supervisor')) return;
    await tx.ticketPersona.create({
      data: { ticketId: t.id, usuarioId: actor.id, rol: 'supervisor', asignadoPor: actor.id },
    });
  }

  /**
   * Cambia quién es el responsable del ticket (o lo deja sin responsable con `nuevoId = null`) dentro de la transacción de quien llama: lo
   * cambia solo si sigue siendo el que se leyó (control de concurrencia), deja el historial (append-only) y publica
   * `operaciones.fcr.responsable_asignado` con el anterior y el nuevo. Sin comprobar roles: eso es de quien llama.
   */
  async cambiarResponsable(
    tx: Prisma.TransactionClient,
    t: {
      id: string;
      ticketNumero: number | null;
      pedidoId: string;
      pedidoCodigo: string;
      responsableId: string | null;
    },
    nuevoId: string | null,
    actor: AuthUser,
    o: { accion: 'tomar' | 'asignar' | 'liberar'; motivo?: string | null },
  ): Promise<void> {
    const r = await tx.ticket.updateMany({
      where: { id: t.id, responsableId: t.responsableId },
      data: { responsableId: nuevoId, updatedBy: actor.id },
    });
    if (r.count === 0) {
      throw new ConflictException('El responsable del ticket cambió; vuelva a intentarlo');
    }
    const motivo = o.motivo?.trim() || null;
    await tx.ticketResponsableHistorial.create({
      data: {
        id: uuidv7(),
        ticketId: t.id,
        anteriorId: t.responsableId,
        nuevoId,
        motivo,
        actorId: actor.id,
      },
    });
    const ids = [t.responsableId, nuevoId].filter((x): x is string => x !== null);
    const nombres = new Map(
      (ids.length
        ? await tx.idUsuario.findMany({
            where: { id: { in: ids } },
            select: { id: true, nombre: true, rol: { select: { codigo: true } } },
          })
        : []
      ).map((u) => [u.id, { nombre: u.nombre, rol: u.rol.codigo }] as const),
    );
    // a quién se le avisa: el nuevo responsable (si no lo hizo él mismo) y, si lo perdió, el anterior; cada uno con su rol de cuenta
    const aviso = (uid: string | null) =>
      uid && uid !== actor.id && nombres.get(uid)
        ? [{ usuarioId: uid, rolCodigo: nombres.get(uid)!.rol }]
        : [];
    await this.bus.publish(
      tx,
      this.bus.create({
        type: 'operaciones.fcr.responsable_asignado',
        subject: { type: 'fcr_ticket', id: t.id },
        data: {
          ticketId: t.id,
          ticketNumero: t.ticketNumero,
          pedidoId: t.pedidoId,
          pedidoCodigo: t.pedidoCodigo,
          accion: o.accion,
          anteriorId: t.responsableId,
          anteriorNombre: t.responsableId ? (nombres.get(t.responsableId)?.nombre ?? null) : null,
          nuevoId,
          nuevoNombre: nuevoId ? (nombres.get(nuevoId)?.nombre ?? null) : null,
          motivo,
          asignadoPor: actor.name,
          asignados: aviso(nuevoId),
          desasignados: aviso(t.responsableId),
        },
        actor: { userId: actor.id, role: actor.roleCode },
        traceparent: currentTraceparent(),
      }),
    );
  }

  async cargarEnTx(tx: Prisma.TransactionClient, id: string): Promise<TicketParaMover> {
    const t = await tx.ticket.findUnique({ where: { id }, include: INCLUDE_DETALLE });
    if (!t) throw new NotFoundException('El ticket no existe');
    exigirNoAnulado(t.pasoCodigo);
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
