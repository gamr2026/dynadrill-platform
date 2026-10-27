import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { currentTraceparent, type AuthUser } from '@dyn/common';
import { EventBus, type EventEnvelope } from '@dyn/messaging';
import { uuidv7 } from '@dyn/utils';
import type { Prisma } from '../generated/client';
import type { LineaPedido } from './reporte-herramientas.service';
import { PrismaService } from '../prisma/prisma.service';
import { RequisitosService } from './requisitos.service';
import { etiquetaDeUnidad, UNIDAD_CON_PLACA } from './unidad-etiqueta';

/** Lo que `comercial` publica al abrir un pedido (`comercial.pedido.abierto`) y este módulo necesita. */
export interface PedidoAbiertoData {
  /** Código del pedido (PED-...). */
  codigo: string;
  lineaServicio: string | null;
  tipoOt?: 'venta' | 'servicio' | null;
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
  /** Representante del cliente en campo (Company Man): solo el id. */
  representanteCampoId?: string | null;
  as2Numero?: string | null;
  /** Las líneas cotizadas vigentes (código, unidad, cantidad y tipo), de las que sale el Reporte de Herramientas. */
  lineas?: LineaPedido[];
}

/** `control_fluidos` -> "Control fluidos" (para leerlo en un correo o en la campanita). */
const textoServicio = (codigo: string) => {
  const t = codigo.replace(/_/g, ' ').trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : codigo;
};

const aDia = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const ROL_SUPERADMIN = 'superadmin';
/** Roles que coordinan el servicio: ven y actúan sin estar en el equipo asignado. */
const ROLES_COORDINA = [ROL_SUPERADMIN, 'jefe_base'];
/** Hasta la asignación el ticket es del Jefe de Base; de ahí en adelante, del equipo que él asignó. */
const PASOS_DE_COORDINACION = ['revision_inicial', 'asignacion'];

/** Los nombres salen de las FK (JOIN), no se copian al ticket. */
/** Orden de los pasos desde los que al Conductor le toca su gerenciamiento de viaje (ver `pumping.paso`). */
const ORDEN_TRASLADO_SALIDA = 30;
const ORDEN_EJECUCION = 50;
const NOMBRES = {
  cliente: true,
  campo: true,
  bloque: true,
  pozo: true,
  taladro: true,
  representanteCampo: true,
} as const;
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
  historial: { include: { actor: true }, orderBy: { createdAt: 'asc' } },
  personas: {
    include: { usuario: true, unidad: UNIDAD_CON_PLACA },
    orderBy: { usuario: { nombre: 'asc' } },
  },
  unidades: {
    include: { unidad: { include: { vehiculo: { include: { tipoVehiculo: true } } } } },
    orderBy: { unidad: { codigo: 'asc' } },
  },
} as const;
type TicketLista = Prisma.TicketGetPayload<{ include: typeof INCLUDE_LISTA }>;
type TicketDetalle = Prisma.TicketGetPayload<{ include: typeof INCLUDE_DETALLE }>;

export const puedeActuar = (roles: { rolCodigo: string }[], rol: string) =>
  rol === ROL_SUPERADMIN || roles.some((r) => r.rolCodigo === rol);

/** ¿Puede esta cuenta actuar en el paso? Además del rol, desde la asignación solo el equipo asignado al ticket (o quien coordina). */
export const puedeActuarEn = (
  t: {
    pasoCodigo: string;
    paso: { roles: { rolCodigo: string }[] };
    personas: { usuarioId: string }[];
  },
  actor: { id: string; roleCode: string },
): boolean =>
  puedeActuar(t.paso.roles, actor.roleCode) &&
  (ROLES_COORDINA.includes(actor.roleCode) ||
    PASOS_DE_COORDINACION.includes(t.pasoCodigo) ||
    t.personas.some((p) => p.usuarioId === actor.id));

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
  fechaFinServicio: aDia(t.fechaFinServicio),
  createdAt: t.createdAt,
});

/**
 * Ticket de servicio de Pumping. Nace del pedido abierto de la línea (uno por pedido, sin duplicar aunque el evento llegue
 * dos veces) y lo llevan los roles de cada paso. Los pasos válidos y sus responsables viven en la base de datos.
 */
@Injectable()
export class TicketsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: EventBus,
    private readonly requisitos: RequisitosService,
  ) {}

  /** Crea el ticket de un pedido de Pumping abierto. `null` si el pedido no es de Pumping o ya tiene su ticket. */
  async crearDesdePedido(
    tx: Prisma.TransactionClient,
    event: EventEnvelope<PedidoAbiertoData>,
  ): Promise<{ ticketId: string; pedidoCodigo: string } | null> {
    const d = event.data;
    if (d.lineaServicio !== 'pumping') return null;
    const pedidoId = event.subject.id;
    if (await tx.ticket.findUnique({ where: { pedidoId }, select: { id: true } })) return null;

    const id = uuidv7();
    await tx.ticket.create({
      data: {
        id,
        pedidoId,
        pedidoCodigo: d.codigo,
        ticketNumero: d.ticketNumero ?? null,
        pasoCodigo: 'revision_inicial',
        tipoOt: d.tipoOt ?? null,
        clienteId: d.clienteId ?? null,
        campoId: d.campoId ?? null,
        bloqueId: d.bloqueId ?? null,
        pozoId: d.pozoId ?? null,
        taladroId: d.taladroId ?? null,
        rigless: d.rigless ?? false,
        numeroContrato: d.numeroContrato ?? null,
        as2Numero: d.as2Numero ?? null,
        fechaInicioServicio: d.fechaInicioServicio
          ? new Date(`${d.fechaInicioServicio}T00:00:00.000Z`)
          : null,
        fechaFinServicio: d.fechaFinServicio
          ? new Date(`${d.fechaFinServicio}T00:00:00.000Z`)
          : null,
        representanteCampoId: d.representanteCampoId ?? null,
        tiposServicio: {
          create: [...new Set(d.tiposServicio ?? [])].map((tipoCodigo) => ({ tipoCodigo })),
        },
        historial: {
          create: {
            id: uuidv7(),
            pasoAnterior: null,
            pasoNuevo: 'revision_inicial',
            motivo: 'Pedido abierto',
            origen: 'sistema',
          },
        },
      },
    });
    // el evento lleva los nombres ya resueltos (los avisos los muestran tal cual), obtenidos de los catálogos por las FK
    const n = await tx.ticket.findUniqueOrThrow({ where: { id }, include: NOMBRES });
    await this.bus.publish(
      tx,
      this.bus.create({
        type: 'operaciones.pumping.ticket_creado',
        subject: { type: 'pumping_ticket', id },
        data: {
          ticketId: id,
          ticketNumero: d.ticketNumero ?? null,
          pedidoId,
          pedidoCodigo: d.codigo,
          cliente: nombreDe(n.cliente),
          campo: n.campo?.nombre ?? null,
          pozo: n.pozo?.nombreCompleto ?? null,
          taladro: d.rigless ? 'RIGLESS' : (n.taladro?.nombre ?? null),
          tiposServicio: [...new Set(d.tiposServicio ?? [])],
          servicios: [...new Set(d.tiposServicio ?? [])].map(textoServicio).join(', '),
          fechaInicioServicio: d.fechaInicioServicio ?? null,
          fechaFinServicio: d.fechaFinServicio ?? null,
        },
        // quien abrió el pedido: QHSE abre a su nombre el PTW del primer día
        ...(event.actor ? { actor: event.actor } : {}),
        causationId: event.id,
        correlationId: event.correlationId,
        traceparent: currentTraceparent(),
      }),
    );
    return { ticketId: id, pedidoCodigo: d.codigo };
  }

  /** Bandeja: todos los tickets, o los que esperan a un rol (`rol`), o de un paso. Se busca por número de ticket, pedido, cliente o pozo. */
  async listar(f: { paso?: string; rol?: string; usuarioId?: string; q?: string }) {
    const q = f.q?.trim();
    const filas = await this.prisma.ticket.findMany({
      where: {
        ...(f.paso ? { pasoCodigo: f.paso } : {}),
        ...(f.rol ? { paso: { roles: { some: { rolCodigo: f.rol } } } } : {}),
        // el equipo (supervisor, operador) ve solo los tickets a los que fue asignado; quien coordina, todos los de su paso
        ...(f.rol && f.usuarioId && !ROLES_COORDINA.includes(f.rol)
          ? { personas: { some: { usuarioId: f.usuarioId } } }
          : {}),
        ...(q
          ? {
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
            }
          : {}),
      },
      include: INCLUDE_LISTA,
      orderBy: { createdAt: 'desc' },
      take: 300,
    });
    return filas.map(resumen);
  }

  /**
   * Lectura mínima para el portal del Conductor (Flota, gerenciamiento de viaje): solo los tickets en los que la cuenta está asignada
   * como conductor (o como operador), aún sin cerrar, con lo necesario para autocompletar la solicitud. Los nombres salen de los catálogos (ids incluidos).
   */
  async misViajes(usuarioId: string) {
    const filas = await this.prisma.ticket.findMany({
      where: {
        personas: { some: { usuarioId, rol: { in: ['conductor', 'operador'] } } },
        paso: { terminal: false },
      },
      include: {
        ...NOMBRES,
        paso: true,
        tiposServicio: true,
        personas: {
          where: { OR: [{ rol: 'supervisor' }, { usuarioId }] },
          include: { usuario: true, unidad: UNIDAD_CON_PLACA },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return filas.map((t) => ({
      ticketId: t.id,
      ticketNumero: t.ticketNumero,
      pedidoCodigo: t.pedidoCodigo,
      cliente: t.cliente ? { id: t.cliente.id, nombre: t.cliente.nombreComercial } : null,
      destino: {
        campo: t.campo ? { id: t.campo.id, nombre: t.campo.nombre } : null,
        pozo: t.pozo ? { id: t.pozo.id, nombre: t.pozo.nombreCompleto } : null,
      },
      serviciosPrincipales: t.tiposServicio.map((s) => ({
        codigo: s.tipoCodigo,
        nombre: textoServicio(s.tipoCodigo),
      })),
      supervisor: (() => {
        const sup = t.personas.find((p) => p.rol === 'supervisor');
        return sup ? { id: sup.usuarioId, nombre: sup.usuario.nombre } : null;
      })(),
      paso: { codigo: t.pasoCodigo, nombre: t.paso.nombre },
      /** Las unidades que lleva esta cuenta en el ticket (cada conductor lleva la suya). */
      unidades: t.personas
        .filter((p) => p.usuarioId === usuarioId && p.unidadId)
        .map((p) => ({
          unidadId: p.unidadId as string,
          codigo: p.unidad?.codigo ?? '',
          placa: p.unidad?.vehiculo?.placa ?? null,
        })),
      /** Gerenciamientos de viaje que le tocan en este momento del servicio: el de salida desde el traslado, el de retorno desde la ejecución. */
      tiposViaje: [
        ...(t.paso.orden >= ORDEN_TRASLADO_SALIDA ? ['salida'] : []),
        ...(t.paso.orden >= ORDEN_EJECUCION ? ['retorno'] : []),
      ],
    }));
  }

  async detalle(id: string, actor: AuthUser) {
    const t = await this.cargar(id);
    return { ...this.aDetalle(t, actor), requisitos: await this.requisitos.estado(id) };
  }

  /** Pasa el ticket al siguiente paso. Solo los roles del paso actual (y Superadmin) pueden hacerlo. */
  async avanzar(id: string, hacia: string, actor: AuthUser, motivo?: string) {
    await this.prisma.$transaction(async (tx) => {
      const t = await tx.ticket.findUnique({ where: { id }, include: INCLUDE_DETALLE });
      if (!t) throw new NotFoundException('El ticket no existe');
      if (!puedeActuar(t.paso.roles, actor.roleCode)) {
        throw new ForbiddenException(`El paso "${t.paso.nombre}" lo atiende otro rol`);
      }
      if (!puedeActuarEn(t, actor))
        throw new ForbiddenException('Solo el equipo asignado a este ticket puede avanzarlo');
      const salida = t.paso.salidas.find((s) => s.destinoCodigo === hacia);
      if (!salida) {
        throw new ConflictException(`Desde "${t.paso.nombre}" no se puede pasar a "${hacia}"`);
      }
      if (salida.requiereMotivo && !motivo?.trim())
        throw new BadRequestException('El motivo es obligatorio');
      // para salir del paso deben estar cumplidos todos sus requisitos (la lista de lo que falta va en la respuesta)
      if (salida.exigeRequisitos) {
        await this.requisitos.exigirCumplidos(tx, id, t.pasoCodigo, t.paso.nombre);
      }
      const r = await tx.ticket.updateMany({
        where: { id, pasoCodigo: t.pasoCodigo },
        data: { pasoCodigo: hacia, version: { increment: 1 } },
      });
      if (r.count === 0)
        throw new ConflictException('El ticket cambió de paso; vuelva a intentarlo');
      await tx.ticketHistorial.create({
        data: {
          id: uuidv7(),
          ticketId: id,
          pasoAnterior: t.pasoCodigo,
          pasoNuevo: hacia,
          motivo: motivo?.trim() || null,
          actorId: actor.id,
          actorRol: actor.roleCode,
          origen: 'manual',
        },
      });
      await this.bus.publish(
        tx,
        this.bus.create({
          type: 'operaciones.pumping.paso_cambiado',
          subject: { type: 'pumping_ticket', id },
          data: { ticketId: id, pedidoId: t.pedidoId, desde: t.pasoCodigo, hacia },
          actor: { userId: actor.id, role: actor.roleCode },
          traceparent: currentTraceparent(),
        }),
      );
      // el cierre del servicio: Comercial genera la prefactura con lo que el ticket dejó (contrato 4.10)
      if (hacia === 'cierre') {
        await this.bus.publish(
          tx,
          this.bus.create({
            type: 'operaciones.pumping.cerrado',
            subject: { type: 'pumping_ticket', id },
            data: { ticketId: id, ticketNumero: t.ticketNumero, pedidoId: t.pedidoId },
            actor: { userId: actor.id, role: actor.roleCode },
            traceparent: currentTraceparent(),
          }),
        );
      }
      // al terminar el traslado de salida se avisa al supervisor asignado (los reportes de salida le esperan para revisión)
      if (hacia === 'revision_reportes_salida') {
        const supervisor = t.personas.find((p) => p.rol === 'supervisor');
        await this.bus.publish(
          tx,
          this.bus.create({
            type: 'operaciones.pumping.salida_reportada',
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
              reportadoPor: actor.name,
              unidades: t.unidades.map((u) => etiquetaDeUnidad(u.unidad)).join(', '),
              asignados: supervisor
                ? [{ usuarioId: supervisor.usuarioId, rolCodigo: 'supervisor' }]
                : [],
            },
            actor: { userId: actor.id, role: actor.roleCode },
            traceparent: currentTraceparent(),
          }),
        );
      }
    });
    return this.detalle(id, actor);
  }

  private async cargar(id: string): Promise<TicketDetalle> {
    const t = await this.prisma.ticket.findUnique({ where: { id }, include: INCLUDE_DETALLE });
    if (!t) throw new NotFoundException('El ticket no existe');
    return t;
  }

  private aDetalle(t: TicketDetalle, actor: AuthUser) {
    const actua = puedeActuarEn(t, actor);
    return {
      ...resumen(t),
      tipoOt: t.tipoOt,
      numeroContrato: t.numeroContrato,
      as2Numero: t.as2Numero,
      clienteRuc: t.cliente?.identificacion ?? null,
      bloque: t.bloque?.nombre ?? null,
      representanteCampo: t.representanteCampo
        ? { id: t.representanteCampo.id, nombre: t.representanteCampo.nombre }
        : null,
      version: t.version,
      /** ¿Esta persona es de un rol que atiende el paso actual? */
      puedeActuar: actua,
      /** Pasos a los que puede pasar el ticket desde aquí (solo si el rol de la persona atiende el paso). */
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
            unidadId: p.unidadId,
            codigo: p.unidad?.codigo ?? null,
            placa: p.unidad?.vehiculo?.placa ?? null,
          })),
        conductores: t.personas
          .filter((p) => p.rol === 'conductor')
          .map((p) => ({
            usuarioId: p.usuarioId,
            nombre: p.usuario.nombre,
            unidadId: p.unidadId,
            codigo: p.unidad?.codigo ?? null,
            placa: p.unidad?.vehiculo?.placa ?? null,
          })),
        unidades: t.unidades.map((u) => ({
          unidadId: u.unidadId,
          codigo: u.unidad.codigo,
          nombre: u.unidad.nombre,
          placa: u.unidad.vehiculo?.placa ?? null,
          // tipo, marca y modelo del vehículo enlazado; sin vehículo, el nombre de la unidad
          descripcion: u.unidad.vehiculo ? descripcionVehiculo(u.unidad.vehiculo) : u.unidad.nombre,
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
