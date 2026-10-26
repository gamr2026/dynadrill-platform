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
import { firmaDeUnaLinea } from '../comun/firma';
import { PrismaService } from '../prisma/prisma.service';
import { EpiConsultaService } from './epi-consulta.service';
import { EpiRenglonesService } from './epi-renglones.service';
import { codigoDe, texto, type RenglonEntrada, type Tx } from './epi-tipos';

/** Estados en los que aún se pueden editar los renglones. */
const EDITABLES: EstadoEpi[] = [EstadoEpi.solicitado, EstadoEpi.aprobado];

const enActor = (a: AuthUser) => ({ userId: a.id, role: a.roleCode });

export interface CrearEntregaEntrada {
  trabajadorId: string;
  ticketId?: string | null;
  lugarBodegaId?: string | null;
  renglones?: RenglonEntrada[];
}

/**
 * Entrega de EPI y ropa de trabajo (DYN-SGI-RE-032). Ciclo: solicitado → aprobado → despachado (o rechazado). Se abre una solicitud
 * por cada operador cuando el equipo de Pumping la pide desde el ticket (solicitarParaTicket); despachar publica `qhse.epi.despachada`, que cumple el requisito del
 * ticket (contrato 3 de documentacion/modulos/02-CONTRATOS-ENTRE-MODULOS.md), y revertir publica `qhse.epi.revertida`.
 */
@Injectable()
export class EpiService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: EventBus,
    private readonly consulta: EpiConsultaService,
    private readonly renglones: EpiRenglonesService,
  ) {}

  // ------------------------------------------------------------------------------------------------------ escritura

  /** Registro manual (también para entregas sin ticket, p. ej. de oficina). Nace `solicitado`. */
  async crear(entrada: CrearEntregaEntrada, actor: AuthUser) {
    const id = await this.prisma.$transaction((tx) => this.crearEn(tx, entrada, actor));
    return this.consulta.detalle(id);
  }

  /**
   * Solicitud de EPI de un operador asignado a un ticket, hecha por el equipo operativo (Pumping): el operador debe estar asignado al
   * ticket y la solicitud lleva al menos un elemento. QHSE la aprueba, la rechaza o la despacha. Avisa a QHSE (una solicitud por revisar).
   */
  async solicitarParaTicket(
    ticketId: string,
    entrada: { trabajadorId: string; lugarBodegaId?: string | null; renglones: RenglonEntrada[] },
    actor: AuthUser,
  ) {
    const id = await this.prisma.$transaction(async (tx) => {
      const ticket = await tx.ticketRef.findUnique({ where: { ticketId } });
      if (!ticket)
        throw new NotFoundException('QHSE no conoce ese ticket (aún no se creó o no se asignó)');
      const asignado = await tx.ticketOperador.count({
        where: { ticketId, usuarioId: entrada.trabajadorId },
      });
      if (!asignado)
        throw new BadRequestException('El trabajador no es un operador asignado a este ticket');
      if (entrada.renglones.length === 0)
        throw new BadRequestException(
          'Indique al menos un elemento de protección para la solicitud',
        );
      const nuevoId = await this.crearEn(tx, { ...entrada, ticketId }, actor);
      const trabajador = await tx.idUsuario.findUniqueOrThrow({
        where: { id: entrada.trabajadorId },
        select: { nombre: true },
      });
      await this.bus.publish(
        tx,
        this.bus.create({
          type: 'qhse.epi.solicitudes_abiertas',
          subject: { type: 'pumping_ticket', id: ticketId },
          data: {
            ticketId,
            ticketNumero: ticket.ticketNumero,
            pedidoCodigo: ticket.pedidoCodigo,
            cliente: ticket.cliente,
            campo: ticket.campo,
            pozo: ticket.pozo,
            cantidad: 1,
            trabajadores: trabajador.nombre,
          },
          actor: enActor(actor),
          traceparent: currentTraceparent(),
        }),
      );
      return nuevoId;
    });
    return this.consulta.detalle(id);
  }

  private async crearEn(tx: Tx, entrada: CrearEntregaEntrada, actor: AuthUser): Promise<string> {
    {
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
      await this.renglones.validar(tx, renglones);
      await this.exigirLugar(tx, entrada.lugarBodegaId);
      const nuevoId = uuidv7();
      await tx.epiEntrega.create({
        data: {
          id: nuevoId,
          trabajadorId: entrada.trabajadorId,
          ticketId,
          lugarBodegaId: entrada.lugarBodegaId ?? null,
          createdBy: actor.id,
          updatedBy: actor.id,
        },
      });
      await this.renglones.reemplazar(tx, nuevoId, renglones, actor.id);
      await this.registrarCambio(tx, nuevoId, null, EstadoEpi.solicitado, null, actor.id);
      await this.publicar(tx, 'qhse.epi.solicitada', nuevoId, enActor(actor));
      return nuevoId;
    }
  }

  /** Reemplaza los renglones y el lugar mientras la entrega no se haya despachado. */
  async guardarContenido(
    id: string,
    entrada: { lugarBodegaId?: string | null; renglones: RenglonEntrada[] },
    actor: AuthUser,
  ) {
    await this.prisma.$transaction(async (tx) => {
      const e = await this.entrega(tx, id);
      if (!EDITABLES.includes(e.estado)) {
        throw new ConflictException(
          `La entrega está ${e.estado}: ya no se pueden cambiar sus renglones`,
        );
      }
      await this.renglones.validar(tx, entrada.renglones);
      await this.exigirLugar(tx, entrada.lugarBodegaId);
      await tx.epiEntregaItem.deleteMany({ where: { entregaId: id } });
      await this.renglones.reemplazar(tx, id, entrada.renglones, actor.id);
      await tx.epiEntrega.update({
        where: { id },
        data: {
          ...(entrada.lugarBodegaId !== undefined ? { lugarBodegaId: entrada.lugarBodegaId } : {}),
          updatedBy: actor.id,
        },
      });
    });
    return this.consulta.detalle(id);
  }

  async aprobar(id: string, actor: AuthUser) {
    await this.cambiarEstado(id, actor, {
      desde: [EstadoEpi.solicitado],
      hacia: EstadoEpi.aprobado,
      evento: 'qhse.epi.aprobada',
      datos: () => ({ aprobadoPor: actor.id, aprobadoAt: new Date() }),
    });
    return this.consulta.detalle(id);
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
    return this.consulta.detalle(id);
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
          select: {
            lugarBodegaId: true,
            firmaTrabajadorAt: true,
            _count: { select: { items: true } },
          },
        });
        if (e._count.items === 0)
          throw new BadRequestException(
            'Registre al menos un elemento entregado antes de despachar',
          );
        if (!e.lugarBodegaId)
          throw new BadRequestException('Indique el lugar de la entrega antes de despachar');
        if (!e.firmaTrabajadorAt)
          throw new BadRequestException(
            'Falta la declaración del trabajador (firma) para despachar la entrega',
          );
      },
      datos: () => ({ despachadoPor: actor.id, despachadoAt: new Date() }),
    });
    return this.consulta.detalle(id);
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
    return this.consulta.detalle(id);
  }

  /** Declaración del trabajador ("Firmo y acepto ser responsable..."): firma de una línea, con la hora del servidor. */
  async firmarTrabajador(id: string, actor: AuthUser) {
    await this.firmar(id, actor, 'trabajador');
    return this.consulta.detalle(id);
  }

  /** "Recibe conforme Talento Humano": cierra el expediente. Solo tiene sentido después de despachar. */
  async firmarTalentoHumano(id: string, actor: AuthUser) {
    await this.firmar(id, actor, 'th');
    return this.consulta.detalle(id);
  }

  // ----------------------------------------------------------------------------------------------- uso desde consumidores

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
      const firmadaAt = new Date();
      await tx.epiEntrega.update({
        where: { id },
        data:
          quien === 'trabajador'
            ? { firmaTrabajadorPor: actor.id, firmaTrabajadorAt: firmadaAt, updatedBy: actor.id }
            : { firmaThPor: actor.id, firmaThAt: firmadaAt, updatedBy: actor.id },
      });
      // evidencia (contrato 4.14): Firmas la registra; aquí la firma sigue guardada porque de ella depende el despacho
      await this.publicar(
        tx,
        'qhse.epi.firmado',
        id,
        enActor(actor),
        undefined,
        undefined,
        firmaDeUnaLinea(
          'qhse_entrega_epi',
          id,
          quien === 'trabajador' ? 'trabajador' : 'talento_humano',
          actor.id,
          firmadaAt,
        ),
      );
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

  private async exigirLugar(tx: Tx, lugarBodegaId: string | null | undefined) {
    if (!lugarBodegaId) return;
    const b = await tx.catBodega.findUnique({ where: { id: lugarBodegaId } });
    if (!b || !b.habilitado)
      throw new BadRequestException('La base o bodega indicada no existe o está deshabilitada');
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
    extra: Record<string, unknown> = {},
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
          ...extra,
        },
        ...(actor ? { actor } : {}),
        ...(causa ? { causationId: causa.id, correlationId: causa.correlationId } : {}),
        traceparent: currentTraceparent(),
      }),
    );
  }
}
