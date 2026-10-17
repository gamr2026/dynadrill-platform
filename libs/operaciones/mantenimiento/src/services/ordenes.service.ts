import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AuthUser } from '@dyn/common';
import { EventBus } from '@dyn/messaging';
import { uuidv7 } from '@dyn/utils';
import { ESTADO } from '../catalog/sembrar-catalogos';
import type { Prisma } from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';
import { estadoDeOrden } from './estado-orden';

/** Rol de las cuentas a las que se asigna una sub-orden mecánica o instrumental. */
export const ROL_OPERADOR_MANTENIMIENTO = 'operador_mantenimiento';

/** Qué decide el Jefe de Mantenimiento para cada tipo de trabajo al clasificar un reporte. */
export interface AsignacionEntrada {
  tipo: string;
  /** Mecánico o instrumental: la cuenta del operador de mantenimiento (puede quedar sin asignar). */
  usuarioId?: string | null;
  /** Operativo: `true` (por defecto, como en la demo) lo deja derivado a Pumping; `false` lo deja pendiente. */
  derivar?: boolean;
  /** Operativo derivado: nota para el Supervisor de Pumping. */
  notaDerivacion?: string | null;
}

const INCLUIR_ORDEN = {
  reporte: {
    include: {
      unidad: true,
      pumpingReporteUnidad: { include: { ticket: { select: { id: true, ticketNumero: true } } } },
    },
  },
  subordenes: {
    include: { tipo: true, estado: true, asignada: { select: { id: true, nombre: true } } },
    orderBy: { tipo: { orden: 'asc' } },
  },
} satisfies Prisma.OrdenInclude;

type OrdenConDatos = Prisma.OrdenGetPayload<{ include: typeof INCLUIR_ORDEN }>;

/**
 * Órdenes de mantenimiento correctivo y sus sub-órdenes. En esta etapa (M1): clasificar un reporte (generar la orden con sus
 * sub-órdenes) y reclasificarla. La ejecución, la revisión y el retorno a operación son de M2.
 */
@Injectable()
export class OrdenesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: EventBus,
  ) {}

  /** MAN-001-A, rama «Requiere mantenimiento»: genera la orden con una sub-orden por cada tipo elegido. */
  async clasificar(reporteId: string, asignaciones: AsignacionEntrada[], actor: AuthUser) {
    const ordenId = await this.prisma.$transaction(async (tx) => {
      const reporte = await tx.reporteRecibido.findUnique({
        where: { id: reporteId },
        include: { orden: true, pumpingReporteUnidad: { select: { ticketId: true } } },
      });
      if (!reporte) throw new NotFoundException('El reporte de unidad no existe');
      if (reporte.descartadoAt) {
        throw new ConflictException({
          message: 'El reporte fue descartado: no se puede clasificar',
          code: 'REPORTE_DESCARTADO',
        });
      }
      if (reporte.orden) {
        throw new ConflictException({
          message: 'El reporte ya tiene una orden de mantenimiento; use la reclasificación',
          code: 'REPORTE_CON_ORDEN',
        });
      }
      await this.validarAsignaciones(tx, asignaciones);

      const id = uuidv7();
      await tx.orden.create({
        data: { id, reporteId, createdBy: actor.id, updatedBy: actor.id },
      });
      const creadas = [];
      for (const a of asignaciones) {
        creadas.push(await this.crearSuborden(tx, id, a, actor));
      }
      await this.publicarCreada(tx, id, reporte, creadas, actor);
      return id;
    });
    return this.obtener(ordenId);
  }

  /**
   * Cambia la clasificación de una orden que aún no volvió a operación: las sub-órdenes cerradas se conservan (no se pierde trabajo
   * ya aprobado); las de tipos que ya no se eligen se quitan; las nuevas se crean; las que siguen se actualizan.
   */
  async reclasificar(ordenId: string, asignaciones: AsignacionEntrada[], actor: AuthUser) {
    await this.prisma.$transaction(async (tx) => {
      const orden = await tx.orden.findUnique({
        where: { id: ordenId },
        include: {
          subordenes: { include: { tipo: true, estado: true } },
          reporte: { include: { pumpingReporteUnidad: { select: { ticketId: true } } } },
        },
      });
      if (!orden) throw new NotFoundException('La orden no existe');
      if (orden.retornadaAt) {
        throw new ConflictException({
          message: 'La unidad ya volvió a operación: la orden no se puede reclasificar',
          code: 'ORDEN_CERRADA',
        });
      }
      await this.validarAsignaciones(tx, asignaciones);

      const tipos = new Set(asignaciones.map((a) => a.tipo));
      const nuevas = [];
      for (const s of orden.subordenes) {
        const conserva = tipos.has(s.tipo.codigo) || s.estado.codigo === ESTADO.cerrado;
        if (!conserva) {
          await tx.suborden.delete({ where: { id: s.id } });
          continue;
        }
        const a = asignaciones.find((x) => x.tipo === s.tipo.codigo);
        if (!a || s.estado.codigo === ESTADO.cerrado) continue;
        await this.actualizarSuborden(tx, s.id, s.tipo.codigo, a, actor);
      }
      const existentes = new Set(orden.subordenes.map((s) => s.tipo.codigo));
      for (const a of asignaciones.filter((x) => !existentes.has(x.tipo))) {
        nuevas.push(await this.crearSuborden(tx, ordenId, a, actor));
      }
      await tx.orden.update({ where: { id: ordenId }, data: { updatedBy: actor.id } });
      for (const n of nuevas) await this.publicarSuborden(tx, ordenId, orden.reporte.unidadId, n);
    });
    return this.obtener(ordenId);
  }

  /** Catálogo de tipos de sub-orden, para armar la pantalla de clasificación. */
  async tipos() {
    const filas = await this.prisma.tipoSuborden.findMany({
      where: { activo: true },
      orderBy: { orden: 'asc' },
    });
    return filas.map((t) => ({
      codigo: t.codigo,
      nombre: t.nombre,
      sufijo: t.sufijo,
      asignable: t.asignable,
    }));
  }

  async listar(filtros: { estado?: string; unidadId?: string; asignadaA?: string; q?: string }) {
    const ordenes = await this.prisma.orden.findMany({
      where: {
        ...(filtros.unidadId ? { reporte: { unidadId: filtros.unidadId } } : {}),
        ...(filtros.asignadaA ? { subordenes: { some: { asignadaA: filtros.asignadaA } } } : {}),
        ...(filtros.q?.trim()
          ? { reporte: { codigo: { contains: filtros.q.trim(), mode: 'insensitive' } } }
          : {}),
      },
      include: INCLUIR_ORDEN,
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    const vistas = ordenes.map((o) => this.vista(o));
    return filtros.estado ? vistas.filter((v) => v.estado === filtros.estado) : vistas;
  }

  async obtener(id: string) {
    const o = await this.prisma.orden.findUnique({ where: { id }, include: INCLUIR_ORDEN });
    if (!o) throw new NotFoundException('La orden no existe');
    return this.vista(o);
  }

  /**
   * Todas las sub-órdenes de una unidad (no solo las que originó un ticket): alimenta la tarjeta «Mantenimientos» del ticket de
   * Pumping, visible siempre y sin bloquear nada.
   */
  async subordenesDeUnidad(unidadId: string) {
    const filas = await this.prisma.suborden.findMany({
      where: { orden: { reporte: { unidadId } } },
      include: {
        tipo: true,
        estado: true,
        asignada: { select: { id: true, nombre: true } },
        orden: { include: { reporte: { select: { id: true, codigo: true, unidadId: true } } } },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return filas.map((s) => ({
      id: s.id,
      codigo: `${s.orden.reporte.codigo}-${s.tipo.sufijo}`,
      ordenId: s.ordenId,
      reporteId: s.orden.reporte.id,
      tipo: { codigo: s.tipo.codigo, nombre: s.tipo.nombre },
      estado: { codigo: s.estado.codigo, nombre: s.estado.nombre },
      asignada: s.asignada,
      creadaAt: s.createdAt,
    }));
  }

  // ── piezas internas ─────────────────────────────────────────────────────────────────────────────

  /** Tipos válidos y sin repetir; el operador asignado debe ser una cuenta activa con rol de operador de mantenimiento. */
  private async validarAsignaciones(
    tx: Prisma.TransactionClient,
    asignaciones: AsignacionEntrada[],
  ) {
    if (!asignaciones?.length) {
      throw new BadRequestException({
        message: 'Elija al menos un tipo de mantenimiento',
        code: 'SIN_SUBORDENES',
      });
    }
    const codigos = asignaciones.map((a) => a.tipo);
    if (new Set(codigos).size !== codigos.length) {
      throw new BadRequestException({
        message: 'Hay un tipo de mantenimiento repetido',
        code: 'TIPO_REPETIDO',
      });
    }
    const tipos = await tx.tipoSuborden.findMany({
      where: { codigo: { in: codigos }, activo: true },
    });
    for (const a of asignaciones) {
      const tipo = tipos.find((t) => t.codigo === a.tipo);
      if (!tipo) {
        throw new BadRequestException({
          message: `El tipo «${a.tipo}» no existe`,
          code: 'TIPO_INVALIDO',
        });
      }
      if (!tipo.asignable && a.usuarioId) {
        throw new BadRequestException({
          message: `El mantenimiento ${tipo.nombre.toLowerCase()} no se asigna a un mecánico: se deriva a Pumping`,
          code: 'TIPO_NO_ASIGNABLE',
        });
      }
      if (a.usuarioId) {
        const u = await tx.idUsuario.findUnique({
          where: { id: a.usuarioId },
          include: { rol: true },
        });
        if (!u || !u.activo || u.rol.codigo !== ROL_OPERADOR_MANTENIMIENTO) {
          throw new BadRequestException({
            message: 'Solo se asigna a un operador de mantenimiento con la cuenta activa',
            code: 'OPERADOR_INVALIDO',
          });
        }
      }
      if (tipo.asignable && a.derivar) {
        throw new BadRequestException({
          message: 'Solo el mantenimiento operativo se deriva a Pumping',
          code: 'DERIVACION_INVALIDA',
        });
      }
    }
  }

  /** Estado y datos con que nace la sub-orden: el operativo se deriva (o queda pendiente); los demás, con operador si lo hay. */
  private async datosIniciales(
    tx: Prisma.TransactionClient,
    a: AsignacionEntrada,
    actor: AuthUser,
  ) {
    const tipo = await tx.tipoSuborden.findUniqueOrThrow({ where: { codigo: a.tipo } });
    if (!tipo.asignable) {
      const derivar = a.derivar ?? true;
      const nota = a.notaDerivacion?.trim() || null;
      return {
        estadoCodigo: derivar ? ESTADO.derivadoAPumping : ESTADO.pendiente,
        notaDerivacion: derivar ? nota : null,
      };
    }
    return a.usuarioId
      ? { estadoCodigo: ESTADO.pendiente, asignadaA: a.usuarioId, asignadaPor: actor.id }
      : { estadoCodigo: ESTADO.pendiente };
  }

  private async crearSuborden(
    tx: Prisma.TransactionClient,
    ordenId: string,
    a: AsignacionEntrada,
    actor: AuthUser,
  ) {
    const id = uuidv7();
    const { estadoCodigo, ...datos } = await this.datosIniciales(tx, a, actor);
    const [tipo, estado] = await Promise.all([
      tx.tipoSuborden.findUniqueOrThrow({ where: { codigo: a.tipo } }),
      tx.estadoSuborden.findUniqueOrThrow({ where: { codigo: estadoCodigo } }),
    ]);
    await tx.suborden.create({
      data: {
        id,
        ordenId,
        tipoId: tipo.id,
        estadoId: estado.id,
        createdBy: actor.id,
        updatedBy: actor.id,
        ...datos,
      },
    });
    return {
      id,
      tipo: a.tipo,
      estadoCodigo,
      asignadaA: 'asignadaA' in datos ? (datos.asignadaA ?? null) : null,
    };
  }

  /** Reclasificación de una sub-orden existente: solo cambia la asignación o la derivación (nunca el trabajo ya hecho). */
  private async actualizarSuborden(
    tx: Prisma.TransactionClient,
    id: string,
    tipo: string,
    a: AsignacionEntrada,
    actor: AuthUser,
  ) {
    const t = await tx.tipoSuborden.findUniqueOrThrow({ where: { codigo: tipo } });
    if (!t.asignable) {
      const derivar = a.derivar ?? true;
      const estado = await tx.estadoSuborden.findUniqueOrThrow({
        where: { codigo: derivar ? ESTADO.derivadoAPumping : ESTADO.pendiente },
      });
      await tx.suborden.update({
        where: { id },
        data: {
          estadoId: estado.id,
          ...(derivar && a.notaDerivacion?.trim()
            ? { notaDerivacion: a.notaDerivacion.trim() }
            : {}),
          updatedBy: actor.id,
        },
      });
    } else if (a.usuarioId) {
      await tx.suborden.update({
        where: { id },
        data: { asignadaA: a.usuarioId, asignadaPor: actor.id, updatedBy: actor.id },
      });
    }
  }

  private async publicarCreada(
    tx: Prisma.TransactionClient,
    ordenId: string,
    reporte: {
      id: string;
      codigo: string;
      unidadId: string;
      pumpingReporteUnidad: { ticketId: string } | null;
    },
    creadas: Array<{ id: string; tipo: string; estadoCodigo: string; asignadaA: string | null }>,
    actor: AuthUser,
  ) {
    await this.bus.publish(
      tx,
      this.bus.create({
        type: 'operaciones.mantenimiento.orden.creada',
        subject: { type: 'mantenimiento_orden', id: ordenId },
        actor: { userId: actor.id, role: actor.roleCode },
        data: {
          ordenId,
          reporteId: reporte.id,
          codigo: reporte.codigo,
          unidadId: reporte.unidadId,
          ticketId: reporte.pumpingReporteUnidad?.ticketId ?? null,
        },
      }),
    );
    for (const s of creadas) await this.publicarSuborden(tx, ordenId, reporte.unidadId, s);
  }

  /** Avisa de la sub-orden: al operador al que se asignó, o al Supervisor de Pumping si quedó derivada (la plantilla es de M4). */
  private async publicarSuborden(
    tx: Prisma.TransactionClient,
    ordenId: string,
    unidadId: string,
    s: { id: string; tipo: string; estadoCodigo: string; asignadaA: string | null },
  ) {
    const asignada = !!s.asignadaA;
    const derivada = s.estadoCodigo === ESTADO.derivadoAPumping;
    if (!asignada && !derivada) return;
    await this.bus.publish(
      tx,
      this.bus.create({
        type: derivada
          ? 'operaciones.mantenimiento.suborden.derivada_a_pumping'
          : 'operaciones.mantenimiento.suborden.asignada',
        subject: { type: 'mantenimiento_suborden', id: s.id },
        data: {
          subordenId: s.id,
          ordenId,
          unidadId,
          tipo: s.tipo,
          ...(asignada
            ? { asignados: [{ usuarioId: s.asignadaA, rolCodigo: ROL_OPERADOR_MANTENIMIENTO }] }
            : {}),
        },
      }),
    );
  }

  /** Cómo se ve una orden en la API: código (el del reporte), estado derivado, sub-órdenes con su código y la unidad. */
  private vista(o: OrdenConDatos) {
    const r = o.reporte;
    const p = r.pumpingReporteUnidad;
    return {
      id: o.id,
      codigo: r.codigo,
      estado: estadoDeOrden(
        !!o.retornadaAt,
        o.subordenes.map((s) => ({ estadoCodigo: s.estado.codigo, resuelta: s.estado.resuelta })),
      ),
      reporte: { id: r.id, codigo: r.codigo, origen: r.origen },
      unidad: {
        id: r.unidad.id,
        codigo: r.unidad.codigo,
        nombre: r.unidad.nombre,
        tipo: r.unidad.tipo,
      },
      ticket: p ? { id: p.ticket.id, numero: p.ticket.ticketNumero } : null,
      creadaAt: o.createdAt,
      retorno: o.retornadaAt
        ? {
            at: o.retornadaAt,
            por: o.retornadaPor,
            estadoFinal: o.estadoFinal,
            observaciones: o.observacionesFinales,
          }
        : null,
      subordenes: o.subordenes.map((s) => ({
        id: s.id,
        codigo: `${r.codigo}-${s.tipo.sufijo}`,
        tipo: { codigo: s.tipo.codigo, nombre: s.tipo.nombre },
        estado: { codigo: s.estado.codigo, nombre: s.estado.nombre },
        asignada: s.asignada,
        notaDerivacion: s.notaDerivacion,
        notaCorreccion: s.notaCorreccion,
      })),
    };
  }
}
