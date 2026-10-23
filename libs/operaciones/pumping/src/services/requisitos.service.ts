import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { uuidv7 } from '@dyn/utils';
import type { OrigenCumplimiento, Prisma } from '../generated/client';
import { REQ } from '../catalog/sembrar-traslado-salida';
import { PrismaService } from '../prisma/prisma.service';
import { etiquetaDeUnidad, UNIDAD_CON_PLACA } from './unidad-etiqueta';

type Db = Prisma.TransactionClient | PrismaService;

export interface ClaveRequisito {
  ticketId: string;
  codigo: string;
  /** Unidad de Flota (requisitos de ámbito `unidad`). */
  unidadId?: string | null;
  /** Operador (requisitos de ámbito `operador`). */
  usuarioId?: string | null;
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
 * desde Pumping (`sistema`), por un evento de otro módulo (`evento`) o, mientras ese módulo no exista, con el puente temporal
 * (`manual_temporal`, con motivo). Para salir de un paso no puede quedar ninguno pendiente.
 */
@Injectable()
export class RequisitosService {
  constructor(private readonly prisma: PrismaService) {}

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
    const r = await db.ticketRequisito.updateMany({
      where: { ticketId, requisitoCodigo: codigo, unidadId: null, usuarioId: null },
      data: datos,
    });
    if (r.count === 0) {
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

  /** Vuelve a pendiente un requisito cumplido (p. ej. el checklist de ingreso quedó incompleto otra vez). */
  async reabrir(db: Db, k: ClaveRequisito): Promise<number> {
    const r = await db.ticketRequisito.updateMany({
      where: {
        ticketId: k.ticketId,
        requisitoCodigo: k.codigo,
        unidadId: k.unidadId ?? null,
        usuarioId: k.usuarioId ?? null,
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
    const filas = await this.prisma.ticketRequisito.findMany({
      where: { ticketId },
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
      }))
      .sort(
        (a, b) =>
          a.pasoOrden - b.pasoOrden ||
          a.nombre.localeCompare(b.nombre, 'es') ||
          (a.para ?? '').localeCompare(b.para ?? '', 'es'),
      );
  }

  /**
   * PUENTE TEMPORAL: confirma a mano un requisito cuyo dato pertenece a un módulo que todavía no existe en el portal nuevo (QHSE,
   * Mantenimiento). Exige motivo y queda registrado como `manual_temporal`. Los requisitos de Pumping no se confirman así.
   */
  async cumplirManual(requisitoId: string, motivo: string, actorId: string): Promise<void> {
    const texto = motivo?.trim();
    if (!texto) throw new BadRequestException('El motivo es obligatorio');
    await this.prisma.$transaction(async (tx) => {
      const f = await tx.ticketRequisito.findUnique({
        where: { id: requisitoId },
        include: { requisito: true },
      });
      if (!f) throw new NotFoundException('El requisito no existe');
      if (f.requisito.modulo === 'pumping') {
        throw new BadRequestException(
          'Este requisito lo cumple Pumping al registrar su información: no se confirma a mano',
        );
      }
      if (f.estado === 'cumplido') throw new ConflictException('El requisito ya está cumplido');
      await tx.ticketRequisito.update({
        where: { id: requisitoId },
        data: {
          estado: 'cumplido',
          cumplidoAt: new Date(),
          cumplidoPor: actorId,
          origen: 'manual_temporal',
          motivo: texto,
        },
      });
    });
  }
}
