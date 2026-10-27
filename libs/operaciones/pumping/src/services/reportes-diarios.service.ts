import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { currentTraceparent, type AuthUser } from '@dyn/common';
import { EventBus } from '@dyn/messaging';
import { firmaDeUnaLinea, uuidv7 } from '@dyn/utils';
import type { Prisma } from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';
import { puedeActuar, puedeActuarEn } from './tickets.service';

const PASO = 'ejecucion_operativa';
const HORA = /^([01]\d|2[0-3]):[0-5]\d$/;
const FECHA = /^\d{4}-\d{2}-\d{2}$/;

export interface TablaEntrada {
  titulo?: string | null;
  columnas: string[];
  filas: string[][];
}

export interface ActividadEntrada {
  horaInicio: string;
  horaFin: string;
  detalle: string;
  tablas?: TablaEntrada[];
}

export interface ReporteDiarioEntrada {
  actividades: ActividadEntrada[];
  /** Contacto de campo del cliente que firmó ese día; sin indicarlo se conserva el del día o el del ticket. */
  representanteId?: string | null;
  tiempoProductivo?: number | null;
  tiempoNoProductivo?: number | null;
  observaciones?: string | null;
}

const INCLUIR = {
  representante: { select: { id: true, nombre: true } },
  adjuntos: {
    orderBy: { createdAt: 'asc' },
    include: { autor: { select: { id: true, nombre: true } } },
  },
  actividades: {
    orderBy: { orden: 'asc' },
    include: {
      autor: { select: { id: true, nombre: true } },
      tablas: {
        orderBy: { orden: 'asc' },
        include: {
          columnas: { orderBy: { orden: 'asc' } },
          filas: { orderBy: { orden: 'asc' }, include: { celdas: true } },
        },
      },
    },
  },
} satisfies Prisma.ReporteDiarioInclude;

type ReporteConDatos = Prisma.ReporteDiarioGetPayload<{ include: typeof INCLUIR }>;

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

/**
 * Reporte Diario de Actividades (DYN-SGI-RE-047, el «Reporte Job») de un ticket de Pumping: uno por día, con sus actividades y las
 * tablas de cada actividad. Se guarda como borrador (volver a guardar reemplaza el día y, si estaba completado, lo reabre) y se
 * completa; al completarlo se publica `operaciones.pumping.reporte_diario_completado` para que Comercial lo reciba como documento
 * operativo (contrato 4.4). Si Facturación corrigió ese día (`corregido_at`, por evento de Comercial) ya no se edita ni se reenvía.
 */
@Injectable()
export class ReportesDiariosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: EventBus,
  ) {}

  /** Los días del ticket con su estado y el total de horas (todo derivado de las actividades). */
  async listar(ticketId: string) {
    await this.existeTicket(ticketId);
    const filas = await this.prisma.reporteDiario.findMany({
      where: { ticketId },
      orderBy: { fecha: 'asc' },
      include: { actividades: { select: { horaInicio: true, horaFin: true } } },
    });
    return filas.map((r) => ({
      fecha: aDia(r.fecha),
      estado: this.estado(r),
      actividades: r.actividades.length,
      totalHoras: this.total(r.actividades),
    }));
  }

  async obtener(ticketId: string, fecha: string) {
    this.exigirFecha(fecha);
    await this.existeTicket(ticketId);
    const r = await this.prisma.reporteDiario.findUnique({
      where: { ticketId_fecha: { ticketId, fecha: deDia(fecha) } },
      include: INCLUIR,
    });
    if (!r) throw new NotFoundException('Ese día todavía no tiene reporte');
    return this.vista(r);
  }

  /** Guarda el día como borrador: reemplaza sus actividades y tablas; si estaba completado lo reabre. */
  async guardar(ticketId: string, fecha: string, e: ReporteDiarioEntrada, actor: AuthUser) {
    this.exigirFecha(fecha);
    this.validar(e);
    await this.prisma.$transaction(async (tx) => {
      await this.exigirEquipo(tx, ticketId, actor);
      const previo = await tx.reporteDiario.findUnique({
        where: { ticketId_fecha: { ticketId, fecha: deDia(fecha) } },
      });
      if (previo?.corregidoAt) this.diaCorregido();
      const representanteId = await this.representante(tx, ticketId, e.representanteId, previo?.representanteId);
      const datos = {
        representanteId,
        tiempoProductivo: e.tiempoProductivo ?? null,
        tiempoNoProductivo: e.tiempoNoProductivo ?? null,
        observaciones: e.observaciones?.trim() || null,
        completadoAt: null,
        completadoPor: null,
        updatedBy: actor.id,
      };
      let id: string;
      if (previo) {
        id = previo.id;
        await tx.reporteDiario.update({ where: { id }, data: datos });
        await tx.reporteDiarioActividad.deleteMany({ where: { reporteId: id } });
      } else {
        id = uuidv7();
        await tx.reporteDiario.create({
          data: { id, ticketId, fecha: deDia(fecha), ...datos, createdBy: actor.id },
        });
      }
      await this.guardarActividades(tx, id, e.actividades, actor.id);
    });
    return this.obtener(ticketId, fecha);
  }

  /** Completa el día y lo envía a Comercial (evento). Exige al menos una actividad. */
  async completar(ticketId: string, fecha: string, actor: AuthUser) {
    this.exigirFecha(fecha);
    await this.prisma.$transaction(async (tx) => {
      const t = await this.exigirEquipo(tx, ticketId, actor);
      const r = await tx.reporteDiario.findUnique({
        where: { ticketId_fecha: { ticketId, fecha: deDia(fecha) } },
        include: INCLUIR,
      });
      if (!r) throw new NotFoundException('Ese día todavía no tiene reporte: guárdelo primero');
      if (r.corregidoAt) this.diaCorregido();
      if (r.actividades.length === 0) {
        throw new BadRequestException({
          message: 'Agregue al menos una actividad antes de completar el día',
          code: 'SIN_ACTIVIDADES',
        });
      }
      const ahora = new Date();
      await tx.reporteDiario.update({
        where: { id: r.id },
        data: { completadoAt: ahora, completadoPor: actor.id, updatedBy: actor.id },
      });
      const supervisor = await tx.ticketPersona.findFirst({
        where: { ticketId, rol: 'supervisor' },
        select: { usuarioId: true },
      });
      const esOperador = await tx.ticketPersona.findFirst({
        where: { ticketId, rol: 'operador', usuarioId: actor.id },
        select: { usuarioId: true },
      });
      await this.bus.publish(
        tx,
        this.bus.create({
          type: 'operaciones.pumping.reporte_diario_completado',
          subject: { type: 'pumping_ticket', id: ticketId },
          data: {
            ticketId,
            ticketNumero: t.ticketNumero,
            pedidoId: t.pedidoId,
            fecha,
            firmadoPor: actor.name,
            firmadoAt: ahora.toISOString(),
            supervisorId: supervisor?.usuarioId ?? null,
            operadorId: esOperador?.usuarioId ?? null,
            actividades: r.actividades.map((a) => ({
              fecha,
              horaInicio: aHora(a.horaInicio),
              horaFin: aHora(a.horaFin),
              duracionHoras: duracionHoras(aHora(a.horaInicio), aHora(a.horaFin)),
              detalle: a.detalle,
              autor: a.autor.nombre,
              tablas: a.tablas.map((tb) => ({
                titulo: tb.titulo,
                columnas: tb.columnas.map((c) => c.encabezado),
                filas: tb.filas.map((f) =>
                  tb.columnas.map((c) => f.celdas.find((x) => x.columnaId === c.id)?.valor ?? ''),
                ),
              })),
            })),
          },
          actor: { userId: actor.id, role: actor.roleCode },
          traceparent: currentTraceparent(),
        }),
      );
    });
    return this.obtener(ticketId, fecha);
  }

  /**
   * Adjunta un archivo al día (por ejemplo, la plantilla DYN-SGI-RE-047 llenada). El archivo ya está en `archivos`; los adjuntos son historia:
   * una corrección es otro archivo. El día debe existir y no estar corregido por Facturación.
   */
  async adjuntar(ticketId: string, fecha: string, archivoId: string, actor: AuthUser) {
    this.exigirFecha(fecha);
    await this.prisma.$transaction(async (tx) => {
      await this.exigirEquipo(tx, ticketId, actor);
      const r = await tx.reporteDiario.findUnique({
        where: { ticketId_fecha: { ticketId, fecha: deDia(fecha) } },
      });
      if (!r) throw new NotFoundException('Ese día todavía no tiene reporte: guárdelo primero');
      if (r.corregidoAt) this.diaCorregido();
      if (!(await tx.archivoRef.findUnique({ where: { id: archivoId } }))) {
        throw new BadRequestException('El archivo indicado no existe');
      }
      if (await tx.reporteDiarioAdjunto.findFirst({ where: { reporteId: r.id, archivoId } })) {
        throw new ConflictException('Ese archivo ya está adjunto a este día');
      }
      await tx.reporteDiarioAdjunto.create({
        data: { id: uuidv7(), reporteId: r.id, archivoId, createdBy: actor.id },
      });
    });
    return this.obtener(ticketId, fecha);
  }

  /**
   * Firma del día, que se registra en `plataforma/firmas` (contrato 4.14) por el evento `operaciones.pumping.reporte_diario.firmado`:
   * - `supervisor`: lo firma en el portal el Supervisor del ticket (o el Superadmin), «de una línea».
   * - `representante_cliente`: el Company Man firma en papel; quien lo registra (del equipo del ticket) sube el documento firmado, que Firmas
   *   guarda como firma manuscrita con la huella del archivo.
   * El día debe estar completado y no corregido por Facturación; firmar otra vez es otra firma (vale la más reciente).
   */
  async firmar(
    ticketId: string,
    fecha: string,
    rol: 'supervisor' | 'representante_cliente',
    archivoId: string | undefined,
    actor: AuthUser,
  ) {
    this.exigirFecha(fecha);
    await this.prisma.$transaction(async (tx) => {
      // se firma en cualquier paso (el día se completa en la ejecución y la firma puede llegar después): basta ser del equipo del ticket
      const t = await tx.ticket.findUnique({
        where: { id: ticketId },
        select: { pedidoId: true, ticketNumero: true, personas: { select: { usuarioId: true, rol: true } } },
      });
      if (!t) throw new NotFoundException('El ticket no existe');
      const delEquipo = t.personas.some((p) => p.usuarioId === actor.id);
      if (!delEquipo && !['superadmin', 'jefe_base'].includes(actor.roleCode)) {
        throw new ForbiddenException('Solo el equipo asignado a este ticket puede hacerlo');
      }
      const r = await tx.reporteDiario.findUnique({
        where: { ticketId_fecha: { ticketId, fecha: deDia(fecha) } },
      });
      if (!r) throw new NotFoundException('Ese día todavía no tiene reporte');
      if (r.corregidoAt) this.diaCorregido();
      if (!r.completadoAt) {
        throw new ConflictException({
          message: 'Complete el día antes de firmarlo',
          code: 'DIA_SIN_COMPLETAR',
        });
      }
      const ahora = new Date();
      let prueba: Record<string, unknown>;
      if (rol === 'supervisor') {
        const esSupervisor = t.personas.some((p) => p.rol === 'supervisor' && p.usuarioId === actor.id);
        if (!esSupervisor && actor.roleCode !== 'superadmin') {
          throw new ForbiddenException('Solo el Supervisor asignado a este ticket firma el reporte del día');
        }
        if (archivoId) throw new BadRequestException('La firma del Supervisor se hace en el portal: no lleva archivo');
        prueba = firmaDeUnaLinea(
          'pumping_reporte_diario',
          r.id,
          rol,
          actor.id,
          ahora,
          fecha,
          r.completadoAt.toISOString(),
        );
      } else {
        if (!archivoId) {
          throw new BadRequestException('Suba el documento firmado por el representante del cliente');
        }
        if (!(await tx.archivoRef.findUnique({ where: { id: archivoId } }))) {
          throw new BadRequestException('El archivo indicado no existe');
        }
        prueba = {
          documentoTipo: 'pumping_reporte_diario',
          documentoId: r.id,
          rolFirmante: rol,
          metodo: 'manuscrita',
          archivoId,
        };
      }
      await this.bus.publish(
        tx,
        this.bus.create({
          type: 'operaciones.pumping.reporte_diario.firmado',
          subject: { type: 'pumping_reporte_diario', id: r.id },
          data: { ...prueba, ticketId, ticketNumero: t.ticketNumero, pedidoId: t.pedidoId, fecha },
          actor: { userId: actor.id, role: actor.roleCode },
          traceparent: currentTraceparent(),
        }),
      );
    });
    return this.obtener(ticketId, fecha);
  }

  /**
   * Facturación corrigió un día en el pedido (evento de Comercial): ese día ya no se edita ni se reenvía desde el ticket. Si el día
   * no tenía reporte se deja un registro sin actividades que lo marca como corregido. Idempotente.
   */
  async marcarCorregido(
    tx: Prisma.TransactionClient,
    pedidoId: string,
    fecha: string,
    actorId?: string,
  ): Promise<void> {
    if (!FECHA.test(fecha)) return;
    const t = await tx.ticket.findUnique({ where: { pedidoId }, select: { id: true } });
    if (!t) return;
    const previo = await tx.reporteDiario.findUnique({
      where: { ticketId_fecha: { ticketId: t.id, fecha: deDia(fecha) } },
    });
    // quien corrigió es el actor del evento (si es un usuario conocido); si no, quien atendió el ticket por última vez
    const conocido = actorId
      ? await tx.idUsuario.findUnique({ where: { id: actorId }, select: { id: true } })
      : null;
    if (previo) {
      if (!previo.corregidoAt) {
        await tx.reporteDiario.update({
          where: { id: previo.id },
          data: { corregidoAt: new Date(), corregidoPor: conocido?.id ?? previo.updatedBy },
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
    await tx.reporteDiario.create({
      data: {
        id: uuidv7(),
        ticketId: t.id,
        fecha: deDia(fecha),
        corregidoAt: new Date(),
        corregidoPor: autor.actorId,
        createdBy: autor.actorId,
        updatedBy: autor.actorId,
      },
    });
  }

  // ── piezas internas ─────────────────────────────────────────────────────────────────────────────

  private estado(r: { completadoAt: Date | null; corregidoAt: Date | null }) {
    return r.corregidoAt ? 'corregido' : r.completadoAt ? 'completado' : 'borrador';
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

  private exigirFecha(fecha: string): void {
    const d = new Date(`${fecha}T00:00:00.000Z`);
    if (!FECHA.test(fecha) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== fecha) {
      throw new BadRequestException('La fecha del reporte no es válida');
    }
  }

  private async existeTicket(ticketId: string): Promise<void> {
    const t = await this.prisma.ticket.findUnique({
      where: { id: ticketId },
      select: { id: true },
    });
    if (!t) throw new NotFoundException('El ticket no existe');
  }

  /** El ticket está en Ejecución operativa y quien actúa es del rol del paso y del equipo asignado. */
  private async exigirEquipo(tx: Prisma.TransactionClient, ticketId: string, actor: AuthUser) {
    const t = await tx.ticket.findUnique({
      where: { id: ticketId },
      select: {
        id: true,
        pedidoId: true,
        ticketNumero: true,
        pasoCodigo: true,
        paso: { select: { nombre: true, roles: true } },
        personas: { select: { usuarioId: true } },
      },
    });
    if (!t) throw new NotFoundException('El ticket no existe');
    if (t.pasoCodigo !== PASO) {
      throw new ConflictException('El reporte diario se llena en la Ejecución operativa');
    }
    if (!puedeActuar(t.paso.roles, actor.roleCode)) {
      throw new ForbiddenException(`El paso "${t.paso.nombre}" lo atiende otro rol`);
    }
    if (!puedeActuarEn(t, actor)) {
      throw new ForbiddenException('Solo el equipo asignado a este ticket puede hacerlo');
    }
    return t;
  }

  private validar(e: ReporteDiarioEntrada): void {
    for (const a of e.actividades) {
      if (!HORA.test(a.horaInicio) || !HORA.test(a.horaFin)) {
        throw new BadRequestException('Las horas de cada actividad deben ser HH:mm');
      }
      if (a.horaInicio === a.horaFin) {
        throw new BadRequestException('Una actividad no puede empezar y terminar a la misma hora');
      }
      if (!a.detalle?.trim()) throw new BadRequestException('Cada actividad necesita su detalle');
      for (const t of a.tablas ?? []) {
        if (!t.columnas.length)
          throw new BadRequestException('Una tabla necesita al menos una columna');
        if (t.filas.some((f) => f.length !== t.columnas.length)) {
          throw new BadRequestException(
            'Cada fila de una tabla debe tener una celda por encabezado',
          );
        }
      }
    }
    for (const v of [e.tiempoProductivo, e.tiempoNoProductivo]) {
      if (v !== null && v !== undefined && (v < 0 || v > 24)) {
        throw new BadRequestException(
          'Los tiempos productivo y no productivo van entre 0 y 24 horas',
        );
      }
    }
  }

  private async guardarActividades(
    tx: Prisma.TransactionClient,
    reporteId: string,
    actividades: ActividadEntrada[],
    autorId: string,
  ) {
    for (const [orden, a] of actividades.entries()) {
      const actividadId = uuidv7();
      await tx.reporteDiarioActividad.create({
        data: {
          id: actividadId,
          reporteId,
          orden,
          horaInicio: deHora(a.horaInicio),
          horaFin: deHora(a.horaFin),
          detalle: a.detalle.trim(),
          autorId,
        },
      });
      for (const [ordenTabla, t] of (a.tablas ?? []).entries()) {
        const tablaId = uuidv7();
        await tx.reporteDiarioTabla.create({
          data: { id: tablaId, actividadId, orden: ordenTabla, titulo: t.titulo?.trim() || null },
        });
        const columnas = t.columnas.map((encabezado, i) => ({
          id: uuidv7(),
          orden: i,
          encabezado,
        }));
        await tx.reporteDiarioTablaColumna.createMany({
          data: columnas.map((c) => ({ ...c, tablaId })),
        });
        for (const [ordenFila, valores] of t.filas.entries()) {
          const filaId = uuidv7();
          await tx.reporteDiarioTablaFila.create({
            data: { id: filaId, tablaId, orden: ordenFila },
          });
          await tx.reporteDiarioTablaCelda.createMany({
            data: columnas.map((c, i) => ({ filaId, columnaId: c.id, valor: String(valores[i]) })),
          });
        }
      }
    }
  }

  /**
   * Company Man del día: el indicado (debe ser un representante de campo del catálogo) o, si no se indica, el del día o, al crearlo, el
   * del ticket (que viene del pedido).
   */
  private async representante(
    tx: Prisma.TransactionClient,
    ticketId: string,
    indicado: string | null | undefined,
    previo: string | null | undefined,
  ): Promise<string | null> {
    if (indicado) {
      const p = await tx.catPersonaContacto.findUnique({ where: { id: indicado } });
      if (!p || p.tipo !== 'representante_campo') {
        throw new BadRequestException('El representante debe ser un representante de campo del catálogo');
      }
      return indicado;
    }
    if (indicado === null) return null;
    if (previo !== undefined) return previo;
    const ticket = await tx.ticket.findUnique({ where: { id: ticketId }, select: { representanteCampoId: true } });
    return ticket?.representanteCampoId ?? null;
  }

  private vista(r: ReporteConDatos) {
    return {
      /** Id del reporte del día: es el `documentoId` de sus firmas en `GET /api/firmas?documentoTipo=pumping_reporte_diario`. */
      id: r.id,
      fecha: aDia(r.fecha),
      estado: this.estado(r),
      representante: r.representante,
      tiempoProductivo: r.tiempoProductivo === null ? null : Number(r.tiempoProductivo),
      tiempoNoProductivo: r.tiempoNoProductivo === null ? null : Number(r.tiempoNoProductivo),
      observaciones: r.observaciones,
      totalHoras: this.total(r.actividades),
      completadoAt: r.completadoAt,
      corregidoAt: r.corregidoAt,
      adjuntos: r.adjuntos.map((a) => ({ archivoId: a.archivoId, at: a.createdAt, por: a.autor })),
      actividades: r.actividades.map((a) => ({
        horaInicio: aHora(a.horaInicio),
        horaFin: aHora(a.horaFin),
        duracionHoras: duracionHoras(aHora(a.horaInicio), aHora(a.horaFin)),
        detalle: a.detalle,
        autor: a.autor,
        tablas: a.tablas.map((t) => ({
          titulo: t.titulo,
          columnas: t.columnas.map((c) => c.encabezado),
          filas: t.filas.map((f) =>
            t.columnas.map((c) => f.celdas.find((x) => x.columnaId === c.id)?.valor ?? ''),
          ),
        })),
      })),
    };
  }
}
