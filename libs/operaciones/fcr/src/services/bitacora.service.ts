import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { currentTraceparent, type AuthUser } from '@dyn/common';
import { EventBus } from '@dyn/messaging';
import { uuidv7 } from '@dyn/utils';
import { REQ } from '../catalog/sembrar-pasos';
import type { Prisma } from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';
import { RequisitosService } from './requisitos.service';
import { TicketsService, type TicketParaMover } from './tickets.service';

const PASO = 'ejecucion_operativa';
const HORA = /^([01]\d|2[0-3]):[0-5]\d$/;
const FECHA = /^\d{4}-\d{2}-\d{2}$/;

export interface ActividadEntrada {
  horaInicio: string;
  horaFin: string;
  detalle: string;
}

const aHora = (d: Date) => d.toISOString().slice(11, 16);
const deHora = (h: string) => new Date(`1970-01-01T${h}:00.000Z`);
const aDia = (d: Date) => d.toISOString().slice(0, 10);
const deDia = (f: string) => new Date(`${f}T00:00:00.000Z`);

/** Horas entre dos horas del día (si el fin es menor que el inicio, cruza la medianoche), con dos decimales. */
export function duracionHoras(inicio: string, fin: string): number {
  const [h1, m1] = inicio.split(':').map(Number);
  const [h2, m2] = fin.split(':').map(Number);
  let min = h2 * 60 + m2 - (h1 * 60 + m1);
  if (min < 0) min += 24 * 60;
  return Math.round((min / 60) * 100) / 100;
}

/** Valida que sea una fecha real (el 31 de febrero no) en formato yyyy-MM-dd. */
export function exigirFecha(fecha: string): void {
  const d = new Date(`${fecha}T00:00:00.000Z`);
  if (!FECHA.test(fecha) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== fecha) {
    throw new BadRequestException('La fecha no es válida');
  }
}

/** El día debe caer dentro de las fechas del servicio del pedido (si las trae). */
export function exigirDentroDelServicio(
  t: { fechaInicioServicio: Date | null; fechaFinServicio: Date | null },
  fecha: string,
): void {
  if (
    (t.fechaInicioServicio && fecha < aDia(t.fechaInicioServicio)) ||
    (t.fechaFinServicio && fecha > aDia(t.fechaFinServicio))
  ) {
    throw new BadRequestException({
      message: 'El día está fuera de las fechas del servicio del pedido',
      code: 'FUERA_DEL_SERVICIO',
    });
  }
}

const INCLUIR = {
  actividades: {
    orderBy: { orden: 'asc' },
    include: { autor: { select: { id: true, nombre: true } } },
  },
} satisfies Prisma.BitacoraDiaInclude;
type DiaConActividades = Prisma.BitacoraDiaGetPayload<{ include: typeof INCLUIR }>;

/**
 * Bitácora diaria de actividades (el «Reporte Job», DYN-SGI-RE-047). El Operador del equipo registra las actividades de cada día y
 * lo **envía a Facturación día por día**, sin aprobación del Supervisor; reenviar no duplica (Comercial reemplaza el documento de la
 * misma clave). Una sola fuente de verdad: esta bitácora. Reglas: el día va dentro de las fechas del servicio del pedido; el operador
 * corrige solo mientras el ticket esté en ejecución (antes de finalizarla), también un día ya enviado (se reenvía solo); Facturación
 * corrige hasta que el pedido sale al cliente y, desde entonces, el ticket no toca ese día.
 */
@Injectable()
export class BitacoraService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: EventBus,
    private readonly tickets: TicketsService,
    private readonly requisitos: RequisitosService,
  ) {}

  /** Los días del ticket con su estado y total de horas, y el rango de fechas del servicio. */
  async listar(ticketId: string) {
    const t = await this.prisma.ticket.findUnique({
      where: { id: ticketId },
      select: { fechaInicioServicio: true, fechaFinServicio: true },
    });
    if (!t) throw new NotFoundException('El ticket no existe');
    const filas = await this.prisma.bitacoraDia.findMany({
      where: { ticketId },
      orderBy: { fecha: 'asc' },
      include: { actividades: { select: { horaInicio: true, horaFin: true } } },
    });
    return {
      servicio: {
        desde: t.fechaInicioServicio ? aDia(t.fechaInicioServicio) : null,
        hasta: t.fechaFinServicio ? aDia(t.fechaFinServicio) : null,
      },
      dias: filas.map((d) => ({
        fecha: aDia(d.fecha),
        estado: this.estado(d),
        actividades: d.actividades.length,
        totalHoras: this.total(d.actividades),
        enviadaAt: d.enviadaAt,
      })),
    };
  }

  async obtener(ticketId: string, fecha: string) {
    exigirFecha(fecha);
    const d = await this.prisma.bitacoraDia.findUnique({
      where: { ticketId_fecha: { ticketId, fecha: deDia(fecha) } },
      include: INCLUIR,
    });
    if (!d) throw new NotFoundException('Ese día todavía no tiene bitácora');
    return this.vista(d);
  }

  /**
   * Guarda las actividades del día (reemplaza las anteriores). Si el día ya se había enviado, se reenvía solo con lo nuevo (un día
   * enviado no puede quedar sin actividades). Un día que Facturación corrigió ya no se edita.
   */
  async guardar(ticketId: string, fecha: string, actividades: ActividadEntrada[], actor: AuthUser) {
    exigirFecha(fecha);
    this.validar(actividades);
    await this.prisma.$transaction(async (tx) => {
      const t = await this.exigirOperador(tx, ticketId, actor);
      exigirDentroDelServicio(t, fecha);
      const previo = await tx.bitacoraDia.findUnique({
        where: { ticketId_fecha: { ticketId, fecha: deDia(fecha) } },
      });
      if (previo?.corregidaAt) this.diaCorregido();
      if (previo?.enviadaAt && actividades.length === 0) {
        throw new ConflictException({
          message: 'Un día ya enviado a Facturación no puede quedar sin actividades',
          code: 'DIA_ENVIADO_SIN_ACTIVIDADES',
        });
      }
      let id: string;
      if (previo) {
        id = previo.id;
        await tx.bitacoraDia.update({ where: { id }, data: { updatedBy: actor.id } });
        await tx.bitacoraActividad.deleteMany({ where: { bitacoraDiaId: id } });
      } else {
        id = uuidv7();
        await tx.bitacoraDia.create({
          data: { id, ticketId, fecha: deDia(fecha), createdBy: actor.id, updatedBy: actor.id },
        });
      }
      if (actividades.length) {
        await tx.bitacoraActividad.createMany({
          data: actividades.map((a, orden) => ({
            id: uuidv7(),
            bitacoraDiaId: id,
            orden,
            horaInicio: deHora(a.horaInicio),
            horaFin: deHora(a.horaFin),
            detalle: a.detalle.trim(),
            autorId: actor.id,
          })),
        });
      }
      if (previo?.enviadaAt) await this.publicar(tx, t, id, actor);
    });
    return this.obtener(ticketId, fecha);
  }

  /** Envía el día a Facturación (evento). Exige al menos una actividad. Reenviar no duplica. */
  async enviar(ticketId: string, fecha: string, actor: AuthUser) {
    exigirFecha(fecha);
    await this.prisma.$transaction(async (tx) => {
      const t = await this.exigirOperador(tx, ticketId, actor);
      const d = await tx.bitacoraDia.findUnique({
        where: { ticketId_fecha: { ticketId, fecha: deDia(fecha) } },
        include: { actividades: { select: { id: true } } },
      });
      if (!d) throw new NotFoundException('Ese día todavía no tiene bitácora: guárdela primero');
      if (d.corregidaAt) this.diaCorregido();
      if (!d.actividades.length) {
        throw new BadRequestException({
          message: 'Agregue al menos una actividad antes de enviar el día',
          code: 'SIN_ACTIVIDADES',
        });
      }
      await tx.bitacoraDia.update({
        where: { id: d.id },
        data: { enviadaAt: new Date(), enviadaPor: actor.id, updatedBy: actor.id },
      });
      await this.publicar(tx, t, d.id, actor);
      await this.requisitos.marcar(
        tx,
        { ticketId, codigo: REQ.bitacoraEnviada },
        'sistema',
        actor.id,
      );
    });
    return this.obtener(ticketId, fecha);
  }

  /**
   * Facturación corrigió un día en el pedido (evento de Comercial): ese día ya no se edita ni se reenvía desde el ticket. Si el día no
   * existía se deja un registro sin actividades que lo marca como corregido. Idempotente.
   */
  async marcarCorregida(
    tx: Prisma.TransactionClient,
    pedidoId: string,
    fecha: string,
    actorId?: string,
  ): Promise<void> {
    if (!FECHA.test(fecha)) return;
    const t = await tx.ticket.findUnique({
      where: { pedidoId },
      select: { id: true, fechaInicioServicio: true, fechaFinServicio: true },
    });
    if (!t) return;
    const previo = await tx.bitacoraDia.findUnique({
      where: { ticketId_fecha: { ticketId: t.id, fecha: deDia(fecha) } },
    });
    // quien corrigió es el actor del evento (si es un usuario conocido); si no, quien atendió el ticket por última vez
    const conocido = actorId
      ? await tx.idUsuario.findUnique({ where: { id: actorId }, select: { id: true } })
      : null;
    if (previo) {
      if (!previo.corregidaAt) {
        await tx.bitacoraDia.update({
          where: { id: previo.id },
          data: { corregidaAt: new Date(), corregidaPor: conocido?.id ?? previo.updatedBy },
        });
      }
      return;
    }
    const autor = conocido
      ? { actorId: conocido.id }
      : await tx.ticketHistorial.findFirst({
          where: { ticketId: t.id, actorId: { not: null } },
          orderBy: { createdAt: 'desc' },
          select: { actorId: true },
        });
    if (!autor?.actorId) return;
    // un día fuera de las fechas del servicio no se registra (la base no lo admite): no hay nada que bloquear
    if (
      (t.fechaInicioServicio && fecha < aDia(t.fechaInicioServicio)) ||
      (t.fechaFinServicio && fecha > aDia(t.fechaFinServicio))
    )
      return;
    await tx.bitacoraDia.create({
      data: {
        id: uuidv7(),
        ticketId: t.id,
        fecha: deDia(fecha),
        corregidaAt: new Date(),
        corregidaPor: autor.actorId,
        createdBy: autor.actorId,
        updatedBy: autor.actorId,
      },
    });
  }

  // ── piezas internas ─────────────────────────────────────────────────────────────────────────

  private estado(d: { enviadaAt: Date | null; corregidaAt: Date | null }) {
    return d.corregidaAt ? 'corregido' : d.enviadaAt ? 'enviado' : 'borrador';
  }

  private total(a: Array<{ horaInicio: Date; horaFin: Date }>): number {
    const t = a.reduce((s, x) => s + duracionHoras(aHora(x.horaInicio), aHora(x.horaFin)), 0);
    return Math.round(t * 100) / 100;
  }

  private diaCorregido(): never {
    throw new ConflictException({
      message: 'Facturación corrigió este día: ya no se puede editar ni reenviar desde el ticket',
      code: 'DIA_CORREGIDO',
    });
  }

  /** El ticket está en Ejecución operativa y quien actúa es del rol del paso y del equipo asignado. */
  private async exigirOperador(tx: Prisma.TransactionClient, ticketId: string, actor: AuthUser) {
    const t = await this.tickets.cargarEnTx(tx, ticketId);
    if (t.pasoCodigo !== PASO) {
      throw new ConflictException('La bitácora se llena en la Ejecución operativa');
    }
    this.tickets.exigirActuar(t, actor);
    return t;
  }

  private validar(actividades: ActividadEntrada[]): void {
    for (const a of actividades) {
      if (!HORA.test(a.horaInicio) || !HORA.test(a.horaFin)) {
        throw new BadRequestException('Las horas de cada actividad deben ser HH:mm');
      }
      if (a.horaInicio === a.horaFin) {
        throw new BadRequestException('Una actividad no puede empezar y terminar a la misma hora');
      }
      if (!a.detalle?.trim()) throw new BadRequestException('Cada actividad necesita su detalle');
    }
  }

  /** Publica el día para Comercial (Reporte Job). Misma forma que `operaciones.pumping.reporte_diario_completado`. */
  private async publicar(
    tx: Prisma.TransactionClient,
    t: TicketParaMover,
    diaId: string,
    actor: AuthUser,
  ): Promise<void> {
    const d = await tx.bitacoraDia.findUniqueOrThrow({ where: { id: diaId }, include: INCLUIR });
    const fecha = aDia(d.fecha);
    const supervisor = t.personas.find((p) => p.rol === 'supervisor');
    const operador = t.personas.find((p) => p.rol === 'operador' && p.usuarioId === actor.id);
    await this.bus.publish(
      tx,
      this.bus.create({
        type: 'operaciones.fcr.bitacora_enviada',
        subject: { type: 'fcr_ticket', id: t.id },
        data: {
          ticketId: t.id,
          ticketNumero: t.ticketNumero,
          pedidoId: t.pedidoId,
          fecha,
          firmadoPor: actor.name,
          firmadoAt: (d.enviadaAt ?? new Date()).toISOString(),
          supervisorId: supervisor?.usuarioId ?? null,
          operadorId: operador?.usuarioId ?? null,
          actividades: d.actividades.map((a) => ({
            fecha,
            horaInicio: aHora(a.horaInicio),
            horaFin: aHora(a.horaFin),
            duracionHoras: duracionHoras(aHora(a.horaInicio), aHora(a.horaFin)),
            detalle: a.detalle,
            autor: a.autor.nombre,
            tablas: [],
          })),
        },
        actor: { userId: actor.id, role: actor.roleCode },
        traceparent: currentTraceparent(),
      }),
    );
  }

  private vista(d: DiaConActividades) {
    return {
      fecha: aDia(d.fecha),
      estado: this.estado(d),
      totalHoras: this.total(d.actividades),
      enviadaAt: d.enviadaAt,
      corregidaAt: d.corregidaAt,
      actividades: d.actividades.map((a) => ({
        horaInicio: aHora(a.horaInicio),
        horaFin: aHora(a.horaFin),
        duracionHoras: duracionHoras(aHora(a.horaInicio), aHora(a.horaFin)),
        detalle: a.detalle,
        autor: a.autor,
      })),
    };
  }
}
