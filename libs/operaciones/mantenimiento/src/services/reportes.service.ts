import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { AuthUser } from '@dyn/common';
import { EventBus } from '@dyn/messaging';
import { uuidv7 } from '@dyn/utils';
import { CONTADOR_REPORTE } from '../catalog/sembrar-catalogos';
import type { Prisma } from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';

/** Dónde está un reporte en la clasificación (MAN-001-A). Se deriva: no se guarda. */
export type EstadoReporte = 'por_clasificar' | 'descartado' | 'clasificado';

const INCLUIR = {
  unidad: true,
  descartador: { select: { id: true, nombre: true } },
  orden: { select: { id: true } },
  pumpingReporteUnidad: { include: { ticket: { select: { id: true, ticketNumero: true } } } },
} satisfies Prisma.ReporteRecibidoInclude;

type ReporteConDatos = Prisma.ReporteRecibidoGetPayload<{ include: typeof INCLUIR }>;

const hay = (t: string | null | undefined) => !!t && t.trim().length > 0;

export function estadoDeReporte(r: Pick<ReporteConDatos, 'descartadoAt' | 'orden'>): EstadoReporte {
  if (r.descartadoAt) return 'descartado';
  return r.orden ? 'clasificado' : 'por_clasificar';
}

/**
 * Reportes de unidad recibidos (DYN-MNT-RE-012). Lo registra el Operador en su área (Pumping, FCR, inspección de vehículos o QHSE);
 * Mantenimiento solo lo recibe y el Jefe de Mantenimiento lo clasifica (MAN-001-A): lo descarta con motivo o genera una orden.
 * El contenido del reporte (novedades, combustible, ticket) vive en su origen y se lee con JOIN: no se copia.
 */
@Injectable()
export class ReportesService {
  private readonly logger = new Logger(ReportesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: EventBus,
  ) {}

  /** Siguiente número de reporte (`R0001`). El incremento bloquea la fila del contador hasta el fin de la transacción. */
  async siguienteCodigo(tx: Prisma.TransactionClient): Promise<string> {
    const c = await tx.contador.update({
      where: { clave: CONTADOR_REPORTE },
      data: { valor: { increment: 1 } },
    });
    return `R${String(c.valor).padStart(4, '0')}`;
  }

  /**
   * Recibe el reporte de unidad de LLEGADA de Pumping (contrato 4.2). Solo entra a la bandeja si trae alguna novedad (lo que dicen
   * las columnas del reporte, no el aviso del evento). Idempotente: un reporte de Pumping se recibe una sola vez. Devuelve el id del
   * reporte recibido, o `null` si no corresponde recibirlo.
   */
  async recibirDePumping(
    tx: Prisma.TransactionClient,
    reporteUnidadId: string,
    actorId: string | null,
  ): Promise<string | null> {
    const origen = await tx.pumpingReporteUnidad.findUnique({ where: { id: reporteUnidadId } });
    if (!origen) {
      this.logger.warn(`Reporte de unidad ${reporteUnidadId} de Pumping no existe; se ignora`);
      return null;
    }
    if (!origen.llegadaFirmadaAt) {
      this.logger.warn(`Reporte de unidad ${reporteUnidadId}: la llegada aún no está firmada; se ignora`);
      return null;
    }
    const hayNovedades =
      hay(origen.novedadesMecanica) ||
      hay(origen.novedadesInstrumentacion) ||
      hay(origen.novedadesOperaciones);
    if (!hayNovedades) return null;

    const ya = await tx.reporteRecibido.findUnique({ where: { pumpingReporteUnidadId: reporteUnidadId } });
    if (ya) return ya.id;

    // La unidad de Flota que corresponde al vehículo del catálogo con que Pumping armó el reporte (D2)
    const unidad = await tx.flotaUnidad.findFirst({ where: { vehiculoId: origen.vehiculoId } });
    if (!unidad) {
      this.logger.warn(
        `Reporte de unidad ${reporteUnidadId}: el vehículo ${origen.vehiculoId} no tiene unidad en Flota; no se puede recibir`,
      );
      return null;
    }

    const id = uuidv7();
    const codigo = await this.siguienteCodigo(tx);
    await tx.reporteRecibido.create({
      data: {
        id,
        codigo,
        origen: 'pumping',
        unidadId: unidad.id,
        pumpingReporteUnidadId: reporteUnidadId,
        recibidoPor: actorId,
        createdBy: actorId,
        updatedBy: actorId,
      },
    });
    await this.bus.publish(
      tx,
      this.bus.create({
        type: 'operaciones.mantenimiento.reporte.recibido',
        subject: { type: 'mantenimiento_reporte', id },
        data: {
          reporteId: id,
          codigo,
          origen: 'pumping',
          unidadId: unidad.id,
          ticketId: origen.ticketId,
        },
      }),
    );
    return id;
  }

  async listar(filtros: { estado?: EstadoReporte; unidadId?: string; q?: string }) {
    const where: Prisma.ReporteRecibidoWhereInput = {
      ...(filtros.unidadId ? { unidadId: filtros.unidadId } : {}),
      ...(filtros.q?.trim()
        ? {
            OR: [
              { codigo: { contains: filtros.q.trim(), mode: 'insensitive' } },
              { unidad: { codigo: { contains: filtros.q.trim(), mode: 'insensitive' } } },
            ],
          }
        : {}),
      ...(filtros.estado === 'descartado'
        ? { descartadoAt: { not: null } }
        : filtros.estado === 'clasificado'
          ? { descartadoAt: null, orden: { isNot: null } }
          : filtros.estado === 'por_clasificar'
            ? { descartadoAt: null, orden: { is: null } }
            : {}),
    };
    const filas = await this.prisma.reporteRecibido.findMany({
      where,
      include: INCLUIR,
      orderBy: { recibidoAt: 'desc' },
      take: 500,
    });
    return filas.map((r) => this.vista(r));
  }

  async obtener(id: string) {
    const r = await this.prisma.reporteRecibido.findUnique({ where: { id }, include: INCLUIR });
    if (!r) throw new NotFoundException('El reporte de unidad no existe');
    return this.vista(r);
  }

  /** MAN-001-A, rama «No requiere mantenimiento»: descarta el reporte sin generar orden. El motivo es obligatorio. */
  async descartar(id: string, motivo: string, actor: AuthUser) {
    const texto = motivo?.trim();
    if (!texto) {
      throw new BadRequestException({
        message: 'Indique el motivo por el que el reporte no requiere mantenimiento',
        code: 'MOTIVO_OBLIGATORIO',
      });
    }
    await this.prisma.$transaction(async (tx) => {
      const r = await tx.reporteRecibido.findUnique({ where: { id }, include: { orden: true } });
      if (!r) throw new NotFoundException('El reporte de unidad no existe');
      if (r.descartadoAt) {
        throw new ConflictException({ message: 'El reporte ya fue descartado', code: 'REPORTE_YA_DESCARTADO' });
      }
      if (r.orden) {
        throw new ConflictException({
          message: 'El reporte ya tiene una orden de mantenimiento: no se puede descartar',
          code: 'REPORTE_CON_ORDEN',
        });
      }
      await tx.reporteRecibido.update({
        where: { id },
        data: { descartadoAt: new Date(), descartadoPor: actor.id, motivoDescarte: texto, updatedBy: actor.id },
      });
      await this.bus.publish(
        tx,
        this.bus.create({
          type: 'operaciones.mantenimiento.reporte.descartado',
          subject: { type: 'mantenimiento_reporte', id },
          actor: { userId: actor.id, role: actor.roleCode },
          data: { reporteId: id, codigo: r.codigo, unidadId: r.unidadId },
        }),
      );
    });
    return this.obtener(id);
  }

  /** Cómo se ve un reporte en la API: estado derivado, unidad, ticket y novedades leídas de su origen. */
  private vista(r: ReporteConDatos) {
    const p = r.pumpingReporteUnidad;
    return {
      id: r.id,
      codigo: r.codigo,
      origen: r.origen,
      estado: estadoDeReporte(r),
      recibidoAt: r.recibidoAt,
      unidad: {
        id: r.unidad.id,
        codigo: r.unidad.codigo,
        nombre: r.unidad.nombre,
        tipo: r.unidad.tipo,
        categoriaPeso: r.unidad.categoriaPeso,
      },
      ticket: p ? { id: p.ticket.id, numero: p.ticket.ticketNumero } : null,
      novedades: p
        ? {
            mecanica: p.novedadesMecanica,
            instrumentacion: p.novedadesInstrumentacion,
            operaciones: p.novedadesOperaciones,
            origen: p.origen,
            destino: p.destino,
            fechaLlegada: p.llegadaFecha,
            operacionInterrumpida: p.operacionInterrumpida,
            detalleInterrupcion: p.detalleInterrupcion,
            unidadLista: p.unidadLista,
          }
        : { qhse: r.novedadQhse },
      descarte: r.descartadoAt
        ? { at: r.descartadoAt, por: r.descartador, motivo: r.motivoDescarte }
        : null,
      ordenId: r.orden?.id ?? null,
    };
  }
}
