import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { uuidv7 } from '@dyn/utils';
import type { OrigenCumplimiento, Prisma } from '../generated/client';
import type { AuthUser } from '@dyn/common';
import { REQ } from '../catalog/sembrar-traslado-salida';
import { PrismaService } from '../prisma/prisma.service';
import { JornadasService } from './jornadas.service';
import { plazoDeRequisito } from './requisitos-plazo';
import { etiquetaDeUnidad, UNIDAD_CON_PLACA } from './unidad-etiqueta';

type Db = Prisma.TransactionClient | PrismaService;

export interface ClaveRequisito {
  ticketId: string;
  codigo: string;
  /** Unidad de Flota (requisitos de ámbito `unidad`). */
  unidadId?: string | null;
  /** Operador (requisitos de ámbito `operador`). */
  usuarioId?: string | null;
  /** Día (AAAA-MM-DD) de la jornada (requisitos de ámbito `jornada`); vacío en los demás. */
  fecha?: string | null;
}

export interface RequisitoPendiente {
  id: string;
  codigo: string;
  nombre: string;
  /** A quién o a qué corresponde (placa de la unidad o nombre del operador); `null` si es del ticket. */
  para: string | null;
  texto: string;
}

const textoDe = (nombre: string, para: string | null) => (para ? `${nombre} (${para})` : nombre);

/**
 * Requisitos de cada paso (catálogo en la base de datos). Al completar la asignación se crean las filas del ticket; cada una se cumple
 * desde Pumping (`sistema`), por un evento de otro módulo (`evento`). El puente manual (`manual_temporal`) se retiró el 27/10/2026. Para salir de un paso no puede quedar ninguno pendiente.
 */
@Injectable()
export class RequisitosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jornadas: JornadasService,
  ) {}

  /** Crea (sin duplicar) las filas de todos los requisitos del proceso para el equipo asignado al ticket. */
  async generar(tx: Prisma.TransactionClient, ticketId: string): Promise<number> {
    const definiciones = await tx.requisito.findMany({
      where: { activo: true, pasos: { some: {} } },
    });
    const unidades = await tx.ticketUnidad.findMany({
      where: { ticketId },
      select: { unidadId: true },
    });
    const operadores = await tx.ticketPersona.findMany({
      where: { ticketId, rol: 'operador' },
      select: { usuarioId: true },
    });

    const data: Prisma.TicketRequisitoCreateManyInput[] = [];
    for (const r of definiciones) {
      const base = { id: '', ticketId, requisitoCodigo: r.codigo };
      if (r.ambito === 'ticket') data.push({ ...base, id: uuidv7() });
      if (r.ambito === 'unidad')
        for (const u of unidades) data.push({ ...base, id: uuidv7(), unidadId: u.unidadId });
      if (r.ambito === 'operador')
        for (const o of operadores) data.push({ ...base, id: uuidv7(), usuarioId: o.usuarioId });
    }
    // la SWA nace libre: no hay ninguna activa hasta que QHSE avise lo contrario (si el aviso llegó antes, esa fila se respeta)
    const ahora = new Date();
    for (const d of data) {
      if (d.requisitoCodigo === REQ.swaSinActivar) {
        d.estado = 'cumplido';
        d.cumplidoAt = ahora;
        d.origen = 'sistema';
      }
    }
    const r = await tx.ticketRequisito.createMany({ data, skipDuplicates: true });
    return r.count;
  }

  /**
   * Deja un requisito DEL TICKET en el estado indicado, creando la fila si todavía no existe. Lo usan los avisos de QHSE (SWA y PTW),
   * que pueden llegar antes de que la asignación genere los requisitos: no se pueden perder.
   */
  async fijar(
    db: Db,
    ticketId: string,
    codigo: string,
    estado: 'cumplido' | 'pendiente',
    origen: OrigenCumplimiento,
    actorId?: string | null,
  ): Promise<void> {
    const datos =
      estado === 'cumplido'
        ? { estado, cumplidoAt: new Date(), cumplidoPor: actorId ?? null, origen, motivo: null }
        : { estado, cumplidoAt: null, cumplidoPor: null, origen: null, motivo: null };
    const clave = {
      ticketId,
      requisitoCodigo: codigo,
      unidadId: null,
      usuarioId: null,
      fecha: null,
    };
    // un requisito exonerado no lo cambia un aviso tardío: lo dispensó una persona
    const r = await db.ticketRequisito.updateMany({
      where: { ...clave, estado: { not: 'exonerado' } },
      data: datos,
    });
    if (
      r.count === 0 &&
      !(await db.ticketRequisito.findFirst({ where: clave, select: { id: true } }))
    ) {
      await db.ticketRequisito.create({
        data: { id: uuidv7(), ticketId, requisitoCodigo: codigo, ...datos },
      });
    }
  }

  /** Marca como cumplido el requisito (si existe y estaba pendiente). Devuelve cuántas filas cambió. */
  async marcar(
    db: Db,
    k: ClaveRequisito,
    origen: OrigenCumplimiento,
    actorId?: string | null,
    motivo?: string | null,
  ): Promise<number> {
    const r = await db.ticketRequisito.updateMany({
      where: {
        ticketId: k.ticketId,
        requisitoCodigo: k.codigo,
        unidadId: k.unidadId ?? null,
        usuarioId: k.usuarioId ?? null,
        fecha: k.fecha ? new Date(`${k.fecha}T00:00:00Z`) : null,
        estado: 'pendiente',
      },
      data: {
        estado: 'cumplido',
        cumplidoAt: new Date(),
        cumplidoPor: actorId ?? null,
        origen,
        motivo: motivo ?? null,
      },
    });
    return r.count;
  }

  /** Vuelve a pendiente un requisito cumplido (p. ej. el checklist de ingreso quedó incompleto otra vez). Un exonerado no se reabre. */
  async reabrir(db: Db, k: ClaveRequisito): Promise<number> {
    const r = await db.ticketRequisito.updateMany({
      where: {
        ticketId: k.ticketId,
        requisitoCodigo: k.codigo,
        unidadId: k.unidadId ?? null,
        usuarioId: k.usuarioId ?? null,
        fecha: k.fecha ? new Date(`${k.fecha}T00:00:00Z`) : null,
        estado: 'cumplido',
      },
      data: {
        estado: 'pendiente',
        cumplidoAt: null,
        cumplidoPor: null,
        origen: null,
        motivo: null,
      },
    });
    return r.count;
  }

  /** Requisitos que faltan para SALIR del paso. `excepto`: códigos que no se cuentan (p. ej. el que se está cumpliendo). */
  async pendientes(
    db: Db,
    ticketId: string,
    pasoCodigo: string,
    excepto: string[] = [],
  ): Promise<RequisitoPendiente[]> {
    const filas = await db.ticketRequisito.findMany({
      where: {
        ticketId,
        estado: 'pendiente',
        requisito: { pasos: { some: { pasoCodigo } } },
        ...(excepto.length ? { requisitoCodigo: { notIn: excepto } } : {}),
      },
      include: { requisito: true, unidad: UNIDAD_CON_PLACA, usuario: true },
      orderBy: [{ requisitoCodigo: 'asc' }, { createdAt: 'asc' }],
    });
    return filas.map((f) => {
      const para = (f.unidad ? etiquetaDeUnidad(f.unidad) : null) ?? f.usuario?.nombre ?? null;
      return {
        id: f.id,
        codigo: f.requisitoCodigo,
        nombre: f.requisito.nombre,
        para,
        texto: textoDe(f.requisito.nombre, para),
      };
    });
  }

  /** Falla con un 409 que dice exactamente qué falta, si queda algo pendiente para salir del paso. */
  async exigirCumplidos(
    db: Db,
    ticketId: string,
    pasoCodigo: string,
    pasoNombre: string,
    excepto: string[] = [],
  ): Promise<void> {
    const faltan = await this.pendientes(db, ticketId, pasoCodigo, excepto);
    if (faltan.length) {
      throw new ConflictException({
        message: `No se puede continuar desde "${pasoNombre}". Falta: ${faltan.map((f) => f.texto).join('; ')}.`,
        code: 'REQUISITOS_PENDIENTES',
        pendientes: faltan,
      });
    }
  }

  /** Estado de todos los requisitos del ticket, agrupados por el paso del que son salida (para la pantalla). */
  async estado(ticketId: string) {
    const ahora = new Date();
    const filas = await this.prisma.ticketRequisito.findMany({
      // los requisitos por día (con fecha) los muestra la jornada, no la lista de requisitos de salida de cada paso
      where: { ticketId, fecha: null },
      include: {
        requisito: { include: { pasos: { include: { paso: true } } } },
        unidad: UNIDAD_CON_PLACA,
        usuario: true,
      },
      orderBy: [{ requisitoCodigo: 'asc' }, { createdAt: 'asc' }],
    });
    return filas
      .map((f) => ({
        id: f.id,
        codigo: f.requisitoCodigo,
        nombre: f.requisito.nombre,
        descripcion: f.requisito.descripcion,
        modulo: f.requisito.modulo,
        ambito: f.requisito.ambito,
        paso: f.requisito.pasos[0]?.pasoCodigo ?? null,
        pasoOrden: f.requisito.pasos[0]?.paso.orden ?? 0,
        para: (f.unidad ? etiquetaDeUnidad(f.unidad) : null) ?? f.usuario?.nombre ?? null,
        unidadId: f.unidadId,
        usuarioId: f.usuarioId,
        estado: f.estado,
        cumplidoAt: f.cumplidoAt,
        origen: f.origen,
        motivo: f.motivo,
        ...plazoDeRequisito(f, f.requisito.rolResponsable, ahora),
      }))
      .sort(
        (a, b) =>
          a.pasoOrden - b.pasoOrden ||
          a.nombre.localeCompare(b.nombre, 'es') ||
          (a.para ?? '').localeCompare(b.para ?? '', 'es'),
      );
  }

  /**
   * Exonera un requisito pendiente (con motivo): deja de bloquear y ninguna re-derivación automática ni aviso tardío lo vuelve a tocar. Uno ya
   * cumplido no se exonera. Si es de una jornada, se recalcula el día (puede abrirse al faltar solo lo exonerado).
   */
  async exonerar(ticketId: string, id: string, motivo: string, actor: AuthUser) {
    await this.prisma.$transaction(async (tx) => {
      const f = await this.deTicket(tx, ticketId, id);
      if (f.estado === 'cumplido') {
        throw new ConflictException('El requisito ya está cumplido: no se exonera');
      }
      if (f.estado === 'exonerado') throw new ConflictException('El requisito ya está exonerado');
      const r = await tx.ticketRequisito.updateMany({
        where: { id, ticketId, estado: 'pendiente' },
        data: {
          estado: 'exonerado',
          exoneradoAt: new Date(),
          exoneradoPor: actor.id,
          motivo: motivo.trim(),
        },
      });
      if (r.count === 0) throw new ConflictException('El requisito cambió: vuelva a consultarlo');
      if (f.fecha) await this.jornadas.sincronizar(tx, ticketId, actor.id);
    });
    return this.uno(ticketId, id);
  }

  /** Revierte una exoneración: el requisito vuelve a pendiente (y, si es de una jornada, se recalcula contra los datos del día). */
  async revertirExoneracion(
    ticketId: string,
    id: string,
    motivo: string | undefined,
    actor: AuthUser,
  ) {
    await this.prisma.$transaction(async (tx) => {
      const f = await this.deTicket(tx, ticketId, id);
      if (f.estado !== 'exonerado') throw new ConflictException('El requisito no está exonerado');
      // la fila ya no guarda quién la revierte: el disparador de historia lo toma de la transacción
      await tx.$queryRaw`SELECT set_config('pumping.actor_id', ${actor.id}, true), set_config('pumping.motivo', ${motivo?.trim() ?? ''}, true)`;
      const r = await tx.ticketRequisito.updateMany({
        where: { id, ticketId, estado: 'exonerado' },
        data: { estado: 'pendiente', exoneradoAt: null, exoneradoPor: null, motivo: null },
      });
      if (r.count === 0) throw new ConflictException('El requisito cambió: vuelva a consultarlo');
      if (f.fecha) await this.jornadas.sincronizar(tx, ticketId, actor.id);
    });
    return this.uno(ticketId, id);
  }

  /** Historia de un requisito del ticket, de la más antigua a la más reciente. */
  async historial(ticketId: string, id: string) {
    await this.deTicket(this.prisma, ticketId, id);
    const filas = await this.prisma.ticketRequisitoHistorial.findMany({
      where: { ticketRequisitoId: id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const ids = [...new Set(filas.map((h) => h.actorId).filter((x): x is string => x !== null))];
    const usuarios = ids.length
      ? await this.prisma.idUsuario.findMany({
          where: { id: { in: ids } },
          select: { id: true, nombre: true },
        })
      : [];
    const nombre = new Map(usuarios.map((u) => [u.id, u.nombre]));
    return filas.map((h) => ({
      id: h.id,
      estadoAnterior: h.estadoAnterior,
      estadoNuevo: h.estadoNuevo,
      vencido: h.vencido,
      origen: h.origen,
      actorId: h.actorId,
      actorNombre: h.actorId ? (nombre.get(h.actorId) ?? null) : null,
      motivo: h.motivo,
      createdAt: h.createdAt,
    }));
  }

  private async deTicket(db: Db, ticketId: string, id: string) {
    const f = await db.ticketRequisito.findFirst({
      where: { id, ticketId },
      select: { estado: true, fecha: true },
    });
    if (!f) throw new NotFoundException('El requisito no existe en este ticket');
    return f;
  }

  private async uno(ticketId: string, id: string) {
    const f = await this.prisma.ticketRequisito.findFirstOrThrow({
      where: { id, ticketId },
      include: { requisito: true },
    });
    return {
      id: f.id,
      codigo: f.requisitoCodigo,
      nombre: f.requisito.nombre,
      fecha: f.fecha ? f.fecha.toISOString().slice(0, 10) : null,
      estado: f.estado,
      cumplidoAt: f.cumplidoAt,
      motivo: f.motivo,
      ...plazoDeRequisito(f, f.requisito.rolResponsable),
    };
  }
}
