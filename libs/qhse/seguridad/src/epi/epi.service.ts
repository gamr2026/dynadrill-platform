import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { currentTraceparent, type AuthUser } from '@dyn/common';
import { EventBus, type EventEnvelope } from '@dyn/messaging';
import { uuidv7 } from '@dyn/utils';
import type { Prisma } from '../generated/client';
import { EstadoEpi } from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';

/** Lo que se registra por cada elemento entregado. El elemento sale del catálogo `epi_elemento` (nunca texto suelto). */
export interface RenglonEntrada {
  elementoId: string;
  cantidad: number;
  talla?: string | null;
  codigo?: string | null;
  recibioCapacitacion: boolean;
  observaciones?: string | null;
  /** AAAA-MM-DD; si no viene, hoy. */
  entregadoEl?: string | null;
}

export interface CrearEntregaEntrada {
  trabajadorId: string;
  ticketId?: string | null;
  lugar?: string | null;
  renglones?: RenglonEntrada[];
}

export interface FiltroEntregas {
  estado?: EstadoEpi;
  ticketId?: string;
  trabajadorId?: string;
  q?: string;
}

type Tx = Prisma.TransactionClient;

/** Estados en los que aún se pueden editar los renglones. */
const EDITABLES: EstadoEpi[] = [EstadoEpi.solicitado, EstadoEpi.aprobado];

const enActor = (a: AuthUser) => ({ userId: a.id, role: a.roleCode });
const codigoDe = (numero: number) => `EPI-${String(numero).padStart(6, '0')}`;
const texto = (s: string | null | undefined) => {
  const t = s?.trim();
  return t ? t : null;
};

const INCLUDE_LISTA = {
  trabajador: { include: { perfil: true } },
  ticket: true,
  _count: { select: { items: true } },
} satisfies Prisma.EpiEntregaInclude;

const INCLUDE_DETALLE = {
  trabajador: { include: { perfil: true, rol: true } },
  ticket: true,
  items: { include: { elemento: true }, orderBy: { elemento: { orden: 'asc' } } },
  firmaTrabajador: true,
  firmaTh: true,
  aprobador: true,
  rechazador: true,
  despachador: true,
  historial: { include: { actor: true }, orderBy: { createdAt: 'asc' } },
} satisfies Prisma.EpiEntregaInclude;

type EntregaLista = Prisma.EpiEntregaGetPayload<{ include: typeof INCLUDE_LISTA }>;
type EntregaDetalle = Prisma.EpiEntregaGetPayload<{ include: typeof INCLUDE_DETALLE }>;

/**
 * Entrega de EPI y ropa de trabajo (DYN-SGI-RE-032). Ciclo: solicitado → aprobado → despachado (o rechazado). QHSE abre una solicitud
 * por cada operador cuando Pumping asigna el servicio; despachar publica `qhse.epi.despachada`, que cumple el requisito del
 * ticket (contrato 3 de documentacion/modulos/02-CONTRATOS-ENTRE-MODULOS.md), y revertir publica `qhse.epi.revertida`.
 */
@Injectable()
export class EpiService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: EventBus,
  ) {}

  // ---------------------------------------------------------------------------------------------------------- lectura

  async elementos() {
    return this.prisma.epiElemento.findMany({
      where: { activo: true },
      orderBy: { orden: 'asc' },
      select: { id: true, nombre: true, requiereTalla: true },
    });
  }

  async listar(f: FiltroEntregas) {
    const q = f.q?.trim();
    const filas = await this.prisma.epiEntrega.findMany({
      where: {
        ...(f.estado ? { estado: f.estado } : {}),
        ...(f.ticketId ? { ticketId: f.ticketId } : {}),
        ...(f.trabajadorId ? { trabajadorId: f.trabajadorId } : {}),
        ...(q
          ? {
              OR: [
                { trabajador: { nombre: { contains: q, mode: 'insensitive' as const } } },
                { trabajador: { perfil: { cedula: { contains: q } } } },
                { lugar: { contains: q, mode: 'insensitive' as const } },
                { ticket: { pedidoCodigo: { contains: q, mode: 'insensitive' as const } } },
                ...(/^\d+$/.test(q)
                  ? [{ numero: Number(q) }, { ticket: { ticketNumero: Number(q) } }]
                  : []),
              ],
            }
          : {}),
      },
      include: INCLUDE_LISTA,
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    return filas.map((e) => this.resumen(e));
  }

  async detalle(id: string) {
    const e = await this.prisma.epiEntrega.findUnique({ where: { id }, include: INCLUDE_DETALLE });
    if (!e) throw new NotFoundException('La entrega de EPI no existe');
    return this.completo(e);
  }

  // ------------------------------------------------------------------------------------------------------ escritura

  /** Registro manual (también para entregas sin ticket, p. ej. de oficina). Nace `solicitado`. */
  async crear(entrada: CrearEntregaEntrada, actor: AuthUser) {
    const id = await this.prisma.$transaction(async (tx) => {
      await this.exigirTrabajador(tx, entrada.trabajadorId);
      const ticketId = entrada.ticketId ?? null;
      if (ticketId) {
        const t = await tx.ticketRef.findUnique({ where: { ticketId } });
        if (!t)
          throw new BadRequestException(
            'El ticket indicado no es conocido por QHSE (aún no se asignó el servicio)',
          );
        await this.exigirSinVigente(tx, ticketId, entrada.trabajadorId);
      }
      const renglones = entrada.renglones ?? [];
      await this.validarRenglones(tx, renglones);
      const nuevoId = uuidv7();
      await tx.epiEntrega.create({
        data: {
          id: nuevoId,
          trabajadorId: entrada.trabajadorId,
          ticketId,
          lugar: texto(entrada.lugar),
          createdBy: actor.id,
          updatedBy: actor.id,
        },
      });
      await this.guardarRenglones(tx, nuevoId, renglones);
      await this.registrarCambio(tx, nuevoId, null, EstadoEpi.solicitado, null, actor.id);
      await this.publicar(tx, 'qhse.epi.solicitada', nuevoId, enActor(actor));
      return nuevoId;
    });
    return this.detalle(id);
  }

  /** Reemplaza los renglones y el lugar mientras la entrega no se haya despachado. */
  async guardarContenido(
    id: string,
    entrada: { lugar?: string | null; renglones: RenglonEntrada[] },
    actor: AuthUser,
  ) {
    await this.prisma.$transaction(async (tx) => {
      const e = await this.entrega(tx, id);
      if (!EDITABLES.includes(e.estado)) {
        throw new ConflictException(
          `La entrega está ${e.estado}: ya no se pueden cambiar sus renglones`,
        );
      }
      await this.validarRenglones(tx, entrada.renglones);
      await tx.epiEntregaItem.deleteMany({ where: { entregaId: id } });
      await this.guardarRenglones(tx, id, entrada.renglones);
      await tx.epiEntrega.update({
        where: { id },
        data: {
          ...(entrada.lugar !== undefined ? { lugar: texto(entrada.lugar) } : {}),
          updatedBy: actor.id,
        },
      });
    });
    return this.detalle(id);
  }

  async aprobar(id: string, actor: AuthUser) {
    await this.cambiarEstado(id, actor, {
      desde: [EstadoEpi.solicitado],
      hacia: EstadoEpi.aprobado,
      evento: 'qhse.epi.aprobada',
      datos: () => ({ aprobadoPor: actor.id, aprobadoAt: new Date() }),
    });
    return this.detalle(id);
  }

  async rechazar(id: string, motivo: string, actor: AuthUser) {
    const m = texto(motivo);
    if (!m) throw new BadRequestException('Indique el motivo del rechazo');
    await this.cambiarEstado(id, actor, {
      desde: [EstadoEpi.solicitado, EstadoEpi.aprobado],
      hacia: EstadoEpi.rechazado,
      evento: 'qhse.epi.rechazada',
      motivo: m,
      datos: () => ({ rechazadoPor: actor.id, rechazadoAt: new Date(), motivoRechazo: m }),
    });
    return this.detalle(id);
  }

  /** Solo se despacha lo aprobado, con lugar, al menos un renglón y la declaración del trabajador. */
  async despachar(id: string, actor: AuthUser) {
    await this.cambiarEstado(id, actor, {
      desde: [EstadoEpi.aprobado],
      hacia: EstadoEpi.despachado,
      evento: 'qhse.epi.despachada',
      validar: async (tx) => {
        const e = await tx.epiEntrega.findUniqueOrThrow({
          where: { id },
          select: { lugar: true, firmaTrabajadorAt: true, _count: { select: { items: true } } },
        });
        if (e._count.items === 0)
          throw new BadRequestException(
            'Registre al menos un elemento entregado antes de despachar',
          );
        if (!e.lugar)
          throw new BadRequestException('Indique el lugar de la entrega antes de despachar');
        if (!e.firmaTrabajadorAt)
          throw new BadRequestException(
            'Falta la declaración del trabajador (firma) para despachar la entrega',
          );
      },
      datos: () => ({ despachadoPor: actor.id, despachadoAt: new Date() }),
    });
    return this.detalle(id);
  }

  /** Corrige un despacho hecho por error: vuelve a `aprobado` y reabre el requisito del ticket (`qhse.epi.revertida`). */
  async revertir(id: string, motivo: string, actor: AuthUser) {
    const m = texto(motivo);
    if (!m) throw new BadRequestException('Indique el motivo de la reversión');
    await this.cambiarEstado(id, actor, {
      desde: [EstadoEpi.despachado],
      hacia: EstadoEpi.aprobado,
      evento: 'qhse.epi.revertida',
      motivo: m,
      datos: () => ({ despachadoPor: null, despachadoAt: null }),
    });
    return this.detalle(id);
  }

  /** Declaración del trabajador ("Firmo y acepto ser responsable..."): firma de una línea, con la hora del servidor. */
  async firmarTrabajador(id: string, actor: AuthUser) {
    await this.firmar(id, actor, 'trabajador');
    return this.detalle(id);
  }

  /** "Recibe conforme Talento Humano": cierra el expediente. Solo tiene sentido después de despachar. */
  async firmarTalentoHumano(id: string, actor: AuthUser) {
    await this.firmar(id, actor, 'th');
    return this.detalle(id);
  }

  // ----------------------------------------------------------------------------------------------- uso desde consumidores

  /** Abre la solicitud de un operador asignado a un ticket. Devuelve `null` si ya tenía una vigente. Público para el consumidor. */
  async abrirParaOperador(
    tx: Tx,
    ticketId: string,
    trabajadorId: string,
    actor: { userId: string | null; role?: string },
    evento?: EventEnvelope,
  ): Promise<string | null> {
    const vigente = await tx.epiEntrega.findFirst({
      where: { ticketId, trabajadorId, estado: { not: EstadoEpi.rechazado } },
      select: { id: true },
    });
    if (vigente) return null;
    const id = uuidv7();
    await tx.epiEntrega.create({
      data: { id, trabajadorId, ticketId, createdBy: actor.userId, updatedBy: actor.userId },
    });
    await this.registrarCambio(tx, id, null, EstadoEpi.solicitado, null, actor.userId);
    await this.publicar(
      tx,
      'qhse.epi.solicitada',
      id,
      actor.userId ? { userId: actor.userId, role: actor.role ?? 'sistema' } : null,
      evento,
    );
    return id;
  }

  // ------------------------------------------------------------------------------------------------------ internos

  private async cambiarEstado(
    id: string,
    actor: AuthUser,
    c: {
      desde: EstadoEpi[];
      hacia: EstadoEpi;
      evento: string;
      motivo?: string;
      validar?: (tx: Tx) => Promise<void>;
      datos: () => Prisma.EpiEntregaUncheckedUpdateManyInput;
    },
  ) {
    await this.prisma.$transaction(async (tx) => {
      const e = await this.entrega(tx, id);
      if (!c.desde.includes(e.estado)) {
        throw new ConflictException(
          `La entrega está ${e.estado}; solo se puede pasar a ${c.hacia} desde: ${c.desde.join(' o ')}`,
        );
      }
      await c.validar?.(tx);
      // el estado se vuelve a exigir en el UPDATE: si otra persona la cambió mientras tanto, no se pisa
      const r = await tx.epiEntrega.updateMany({
        where: { id, estado: e.estado },
        data: { estado: c.hacia, updatedBy: actor.id, ...c.datos() },
      });
      if (r.count === 0)
        throw new ConflictException('La entrega cambió de estado; vuelva a intentarlo');
      await this.registrarCambio(tx, id, e.estado, c.hacia, c.motivo ?? null, actor.id);
      await this.publicar(tx, c.evento, id, enActor(actor), undefined, c.motivo);
    });
  }

  private async firmar(id: string, actor: AuthUser, quien: 'trabajador' | 'th') {
    await this.prisma.$transaction(async (tx) => {
      const e = await this.entrega(tx, id);
      if (e.estado === EstadoEpi.rechazado)
        throw new ConflictException('La entrega fue rechazada: no se puede firmar');
      if (quien === 'th' && e.estado !== EstadoEpi.despachado)
        throw new ConflictException('Talento Humano firma cuando la entrega ya fue despachada');
      if (quien === 'trabajador' && e.estado === EstadoEpi.despachado)
        throw new ConflictException('La entrega ya fue despachada');
      const ya = quien === 'trabajador' ? e.firmaTrabajadorAt : e.firmaThAt;
      if (ya) throw new ConflictException('Esta firma ya fue registrada');
      await tx.epiEntrega.update({
        where: { id },
        data:
          quien === 'trabajador'
            ? { firmaTrabajadorPor: actor.id, firmaTrabajadorAt: new Date(), updatedBy: actor.id }
            : { firmaThPor: actor.id, firmaThAt: new Date(), updatedBy: actor.id },
      });
    });
  }

  private async entrega(tx: Tx, id: string) {
    const e = await tx.epiEntrega.findUnique({ where: { id } });
    if (!e) throw new NotFoundException('La entrega de EPI no existe');
    return e;
  }

  private async exigirTrabajador(tx: Tx, trabajadorId: string) {
    const u = await tx.idUsuario.findUnique({ where: { id: trabajadorId } });
    if (!u || !u.activo)
      throw new BadRequestException('El trabajador indicado no existe o está inactivo');
  }

  private async exigirSinVigente(tx: Tx, ticketId: string, trabajadorId: string) {
    const vigente = await tx.epiEntrega.findFirst({
      where: { ticketId, trabajadorId, estado: { not: EstadoEpi.rechazado } },
      select: { numero: true },
    });
    if (vigente)
      throw new ConflictException(
        `El trabajador ya tiene la entrega ${codigoDe(vigente.numero)} para este ticket`,
      );
  }

  private async validarRenglones(tx: Tx, renglones: RenglonEntrada[]) {
    if (!renglones.length) return;
    const ids = [...new Set(renglones.map((r) => r.elementoId))];
    const elementos = await tx.epiElemento.findMany({ where: { id: { in: ids } } });
    for (const r of renglones) {
      const el = elementos.find((x) => x.id === r.elementoId);
      if (!el || !el.activo)
        throw new BadRequestException('Algún elemento indicado no existe en el catálogo de EPI');
      if (el.requiereTalla && !texto(r.talla))
        throw new BadRequestException(`Indique la talla de: ${el.nombre}`);
    }
  }

  private async guardarRenglones(tx: Tx, entregaId: string, renglones: RenglonEntrada[]) {
    if (!renglones.length) return;
    await tx.epiEntregaItem.createMany({
      data: renglones.map((r) => ({
        id: uuidv7(),
        entregaId,
        elementoId: r.elementoId,
        cantidad: r.cantidad,
        talla: texto(r.talla),
        codigo: texto(r.codigo),
        recibioCapacitacion: r.recibioCapacitacion,
        observaciones: texto(r.observaciones),
        ...(r.entregadoEl ? { entregadoEl: new Date(`${r.entregadoEl}T00:00:00.000Z`) } : {}),
      })),
    });
  }

  private async registrarCambio(
    tx: Tx,
    entregaId: string,
    anterior: EstadoEpi | null,
    nuevo: EstadoEpi,
    motivo: string | null,
    actorId: string | null,
  ) {
    await tx.epiEntregaHistorial.create({
      data: {
        id: uuidv7(),
        entregaId,
        estadoAnterior: anterior,
        estadoNuevo: nuevo,
        motivo,
        actorId,
      },
    });
  }

  /**
   * Publica el hecho en el outbox (misma transacción). Los eventos del contrato 3 (`despachada`, `revertida`) llevan `ticketId`
   * y `usuarioId` (el operador que recibió el EPI). Los demás llevan además lo que sirve a los avisos.
   */
  private async publicar(
    tx: Tx,
    tipo: string,
    entregaId: string,
    actor: { userId: string; role: string } | null,
    causa?: EventEnvelope,
    motivo?: string,
  ) {
    const e = await tx.epiEntrega.findUniqueOrThrow({
      where: { id: entregaId },
      include: { trabajador: true, ticket: true },
    });
    await this.bus.publish(
      tx,
      this.bus.create({
        type: tipo,
        subject: { type: 'epi_entrega', id: entregaId },
        data: {
          entregaId,
          numero: e.numero,
          codigo: codigoDe(e.numero),
          ticketId: e.ticketId,
          ticketNumero: e.ticket?.ticketNumero ?? null,
          pedidoCodigo: e.ticket?.pedidoCodigo ?? null,
          usuarioId: e.trabajadorId,
          // texto para avisos (no cambia: es el nombre de la persona al momento del hecho)
          trabajador: e.trabajador.nombre,
          ...(motivo ? { motivo } : {}),
        },
        ...(actor ? { actor } : {}),
        ...(causa ? { causationId: causa.id, correlationId: causa.correlationId } : {}),
        traceparent: currentTraceparent(),
      }),
    );
  }

  private resumen(e: EntregaLista) {
    return {
      id: e.id,
      numero: e.numero,
      codigo: codigoDe(e.numero),
      estado: e.estado,
      lugar: e.lugar,
      trabajador: {
        id: e.trabajador.id,
        nombre: e.trabajador.nombre,
        cedula: e.trabajador.perfil?.cedula ?? null,
        cargo: e.trabajador.perfil?.cargo ?? null,
      },
      ticket: e.ticket
        ? {
            id: e.ticket.ticketId,
            numero: e.ticket.ticketNumero,
            pedidoId: e.ticket.pedidoId,
            pedidoCodigo: e.ticket.pedidoCodigo,
          }
        : null,
      renglones: e._count.items,
      firmadaPorTrabajador: e.firmaTrabajadorAt !== null,
      firmadaPorTalentoHumano: e.firmaThAt !== null,
      createdAt: e.createdAt,
    };
  }

  private completo(e: EntregaDetalle) {
    const persona = (u: { id: string; nombre: string } | null, at: Date | null) =>
      u && at ? { usuarioId: u.id, nombre: u.nombre, at } : null;
    return {
      id: e.id,
      numero: e.numero,
      codigo: codigoDe(e.numero),
      estado: e.estado,
      lugar: e.lugar,
      trabajador: {
        id: e.trabajador.id,
        nombre: e.trabajador.nombre,
        cedula: e.trabajador.perfil?.cedula ?? null,
        cargo: e.trabajador.perfil?.cargo ?? e.trabajador.rol.nombre,
      },
      ticket: e.ticket
        ? {
            id: e.ticket.ticketId,
            numero: e.ticket.ticketNumero,
            pedidoId: e.ticket.pedidoId,
            pedidoCodigo: e.ticket.pedidoCodigo,
          }
        : null,
      renglones: e.items.map((i) => ({
        id: i.id,
        elementoId: i.elementoId,
        elemento: i.elemento.nombre,
        cantidad: i.cantidad,
        talla: i.talla,
        codigo: i.codigo,
        recibioCapacitacion: i.recibioCapacitacion,
        observaciones: i.observaciones,
        entregadoEl: i.entregadoEl.toISOString().slice(0, 10),
      })),
      firmaTrabajador: persona(e.firmaTrabajador, e.firmaTrabajadorAt),
      firmaTalentoHumano: persona(e.firmaTh, e.firmaThAt),
      aprobado: persona(e.aprobador, e.aprobadoAt),
      rechazado:
        e.rechazador && e.rechazadoAt
          ? { ...persona(e.rechazador, e.rechazadoAt), motivo: e.motivoRechazo }
          : null,
      despachado: persona(e.despachador, e.despachadoAt),
      historial: e.historial.map((h) => ({
        estadoAnterior: h.estadoAnterior,
        estadoNuevo: h.estadoNuevo,
        motivo: h.motivo,
        actor: h.actor?.nombre ?? null,
        at: h.createdAt,
      })),
      createdAt: e.createdAt,
      updatedAt: e.updatedAt,
    };
  }
}
