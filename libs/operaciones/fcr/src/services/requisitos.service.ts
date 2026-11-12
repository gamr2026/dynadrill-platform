import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { uuidv7 } from '@dyn/utils';
import { REQ } from '../catalog/sembrar-pasos';
import type { OrigenCumplimiento, Prisma } from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';

type Db = Prisma.TransactionClient | PrismaService;

export interface ClaveRequisito {
  ticketId: string;
  codigo: string;
  /** Operador (requisitos de ámbito `operador`). */
  usuarioId?: string | null;
}

export interface RequisitoPendiente {
  id: string;
  codigo: string;
  nombre: string;
  /** A quién o a qué corresponde (nombre del operador); `null` si es del ticket. */
  para: string | null;
  texto: string;
  /** Rol de cuenta al que le corresponde cumplirlo (catálogo); `null` si no hay uno único. */
  rolResponsable: string | null;
  vencido: boolean;
}

const textoDe = (nombre: string, para: string | null) => (para ? `${nombre} (${para})` : nombre);

/**
 * Requisitos de cada paso (catálogo en la base de datos). Al completar la asignación se crean las filas del ticket; cada una se cumple
 * desde FCR (`sistema`), por un evento de otro módulo (`evento`). El puente manual (`manual_temporal`) se retiró el 27/10/2026. Para salir de un paso no puede quedar ninguno pendiente.
 * Un requisito **exonerado** (una persona lo dispensó con motivo) no bloquea y no lo toca ningún recálculo ni evento tardío: `marcar` y `reabrir`
 * solo actúan sobre filas pendientes o cumplidas, y la base impide que pase de exonerado a cumplido. Solo se revierte desde `ExoneracionesService`.
 */
@Injectable()
export class RequisitosService {
  constructor(private readonly prisma: PrismaService) {}

  /** Crea (sin duplicar) las filas de los requisitos que aplican al tipo de OT del ticket y a su equipo asignado. */
  async generar(tx: Prisma.TransactionClient, ticketId: string): Promise<number> {
    const ticket = await tx.ticket.findUniqueOrThrow({
      where: { id: ticketId },
      select: { tipoOt: true },
    });
    // los de un solo tipo de OT (p. ej. la inspección de SERVICIOS) no se generan para los tickets del otro recorrido
    const definiciones = await tx.requisito.findMany({
      where: {
        activo: true,
        pasos: { some: {} },
        OR: [{ tipoOt: null }, { tipoOt: ticket.tipoOt }],
      },
    });
    const operadores = await tx.ticketPersona.findMany({
      where: { ticketId, rol: 'operador' },
      select: { usuarioId: true },
    });

    const data: Prisma.TicketRequisitoCreateManyInput[] = [];
    for (const r of definiciones) {
      // con plazo en el catálogo, vence tantas horas después de crearse (sin plazo: sin fecha de vencimiento)
      const venceAt =
        r.plazoHoras === null ? null : new Date(Date.now() + r.plazoHoras * 3_600_000);
      const base = { id: '', ticketId, requisitoCodigo: r.codigo, venceAt };
      if (r.ambito === 'ticket') data.push({ ...base, id: uuidv7() });
      if (r.ambito === 'operador')
        for (const o of operadores) data.push({ ...base, id: uuidv7(), usuarioId: o.usuarioId });
    }
    const r = await tx.ticketRequisito.createMany({ data, skipDuplicates: true });
    return r.count;
  }

  /**
   * Mantiene los requisitos que dependen de las herramientas del ticket. `herramientas_recibidas`: cumplido cuando el ticket tiene herramientas y
   * ninguna está sin recibir. Un ticket sin herramientas **no** lo cumple: no hay nada que se haya recibido (antes se daba por cumplido y el ticket
   * pasaba la preparación sin que Bodega ni el Supervisor intervinieran). Lo llama cada cambio de herramientas, dentro de su transacción.
   */
  async sincronizarDeHerramientas(
    tx: Prisma.TransactionClient,
    ticketId: string,
    actorId: string | null,
  ): Promise<void> {
    const total = await tx.ticketHerramienta.count({ where: { ticketId } });
    const sinRecibir = await tx.ticketHerramienta.count({ where: { ticketId, recibidaAt: null } });
    const clave = { ticketId, codigo: REQ.herramientasRecibidas };
    if (total > 0 && sinRecibir === 0) await this.marcar(tx, clave, 'sistema', actorId);
    else await this.reabrir(tx, clave);
    // el retorno: cumplido cuando el ticket tiene herramientas y cada una está devuelta o con su faltante
    const sinRetorno = await tx.ticketHerramienta.count({
      where: { ticketId, devueltaAt: null, faltanteAt: null },
    });
    const retorno = { ticketId, codigo: REQ.herramientasDevueltas };
    if (total > 0 && sinRetorno === 0) await this.marcar(tx, retorno, 'sistema', actorId);
    else await this.reabrir(tx, retorno);
    // agregar o quitar una herramienta también cambia lo que falta inspeccionar (solo existe en SERVICIOS)
    await this.sincronizarInspecciones(tx, ticketId, actorId);
  }

  /**
   * Mantiene `inspecciones_enviadas`: cumplido cuando hay al menos una herramienta y cada una tiene una inspección vigente enviada o
   * aprobada. Lo llama cada cambio de inspecciones o de herramientas, dentro de su transacción.
   */
  async sincronizarInspecciones(
    tx: Prisma.TransactionClient,
    ticketId: string,
    actorId: string | null,
  ): Promise<void> {
    const total = await tx.ticketHerramienta.count({ where: { ticketId } });
    const listas = await tx.ticketHerramienta.count({
      where: {
        ticketId,
        inspecciones: { some: { estado: { in: ['enviada', 'aprobada'] } } },
      },
    });
    const clave = { ticketId, codigo: REQ.inspeccionesEnviadas };
    if (total > 0 && listas === total) await this.marcar(tx, clave, 'sistema', actorId);
    else await this.reabrir(tx, clave);
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

  /**
   * Vuelve a pendiente un requisito cumplido (p. ej. el checklist de ingreso quedó incompleto otra vez). Un exonerado no se reabre. Limpia la
   * marca de vencido. `venceAt`: nuevo vencimiento; sin indicar, el plazo del catálogo contado desde ahora (o ninguno).
   */
  async reabrir(db: Db, k: ClaveRequisito, venceAt?: Date | null): Promise<number> {
    const filas = await db.ticketRequisito.findMany({
      where: {
        ticketId: k.ticketId,
        requisitoCodigo: k.codigo,
        usuarioId: k.usuarioId ?? null,
        estado: 'cumplido',
      },
      select: { id: true, requisito: { select: { plazoHoras: true } } },
    });
    let n = 0;
    for (const f of filas) {
      const plazo = f.requisito.plazoHoras;
      const r = await db.ticketRequisito.updateMany({
        where: { id: f.id, estado: 'cumplido' },
        data: {
          estado: 'pendiente',
          cumplidoAt: null,
          cumplidoPor: null,
          origen: null,
          motivo: null,
          vencidoAt: null,
          venceAt:
            venceAt !== undefined
              ? venceAt
              : plazo === null
                ? null
                : new Date(Date.now() + plazo * 3_600_000),
        },
      });
      n += r.count;
    }
    return n;
  }

  /**
   * Fija el vencimiento de un requisito que sigue pendiente (la bitácora lo mueve según el primer día sin enviar). Si el nuevo vencimiento
   * es futuro, se limpia la marca de vencido. Un exonerado o cumplido no se toca.
   */
  async fijarVence(
    db: Db,
    k: ClaveRequisito,
    venceAt: Date | null,
    ahora: Date = new Date(),
  ): Promise<number> {
    const r = await db.ticketRequisito.updateMany({
      where: {
        ticketId: k.ticketId,
        requisitoCodigo: k.codigo,
        usuarioId: k.usuarioId ?? null,
        estado: 'pendiente',
        OR: [{ venceAt: null }, { venceAt: { not: venceAt } }],
      },
      data: {
        venceAt,
        ...(venceAt === null || venceAt.getTime() > ahora.getTime() ? { vencidoAt: null } : {}),
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
      include: { requisito: true, usuario: true },
      orderBy: [{ requisitoCodigo: 'asc' }, { createdAt: 'asc' }],
    });
    return filas.map((f) => {
      const para = f.usuario?.nombre ?? null;
      return {
        id: f.id,
        codigo: f.requisitoCodigo,
        nombre: f.requisito.nombre,
        para,
        texto: textoDe(f.requisito.nombre, para),
        rolResponsable: f.requisito.rolResponsable,
        vencido: f.vencidoAt !== null,
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
        usuario: true,
      },
      orderBy: [{ requisitoCodigo: 'asc' }, { createdAt: 'asc' }],
    });
    // quien exoneró: `exonerado_por` es una FK solo de la base de datos (sin relación en Prisma), el nombre se busca aparte
    const exoneradores = [
      ...new Set(filas.flatMap((f) => (f.exoneradoPor ? [f.exoneradoPor] : []))),
    ];
    const nombres = new Map(
      (exoneradores.length
        ? await this.prisma.idUsuario.findMany({
            where: { id: { in: exoneradores } },
            select: { id: true, nombre: true },
          })
        : []
      ).map((u) => [u.id, u.nombre]),
    );
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
        para: f.usuario?.nombre ?? null,
        usuarioId: f.usuarioId,
        estado: f.estado,
        cumplidoAt: f.cumplidoAt,
        origen: f.origen,
        motivo: f.motivo,
        venceAt: f.venceAt,
        vencidoAt: f.vencidoAt,
        /** Marcado vencido por la revisión periódica y todavía pendiente. */
        vencido: f.estado === 'pendiente' && f.vencidoAt !== null,
        rolResponsable: f.requisito.rolResponsable,
        exoneradoAt: f.exoneradoAt,
        exoneradoPor: f.exoneradoPor,
        exoneradoPorNombre: f.exoneradoPor ? (nombres.get(f.exoneradoPor) ?? null) : null,
      }))
      .sort(
        (a, b) =>
          a.pasoOrden - b.pasoOrden ||
          a.nombre.localeCompare(b.nombre, 'es') ||
          (a.para ?? '').localeCompare(b.para ?? '', 'es'),
      );
  }
}
