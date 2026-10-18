import { Injectable, NotFoundException } from '@nestjs/common';
import { PreventivosService } from '@dyn/flota';
import { PrismaService } from '../prisma/prisma.service';

export type ClaseMantenimiento = 'preventivo' | 'correctivo';

/** Un mantenimiento ejecutado a una unidad, preventivo (lo registra y guarda Flota) o correctivo (sale de la orden devuelta a operación). */
export interface RegistroDeHistorial {
  clase: ClaseMantenimiento;
  /** `AAAA-MM-DD`. */
  fecha: string;
  unidadId: string;
  ejecutadoPor: 'interno' | 'tercero';
  responsable: { id: string; nombre: string } | null;
  observaciones: string | null;
  /** Solo preventivo. */
  preventivo: {
    id: string;
    tipoServicio: string | null;
    /** Horómetro o kilometraje al hacerlo. */
    valor: number | null;
    proveedor: { id: string; nombre: string } | null;
    checklistArchivo: { id: string; nombre: string } | null;
  } | null;
  /** Solo correctivo. */
  correctivo: {
    ordenId: string;
    ordenCodigo: string;
    estadoFinal: 'disponible' | 'con_restricciones' | null;
    subordenes: Array<{
      codigo: string;
      tipo: string;
      horasTrabajo: number | null;
      repuestos: number;
    }>;
  } | null;
}

const dia = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Historial de mantenimientos de una unidad (MAN-003): une, sin copiar nada, los **preventivos** que Flota registra (contrato 4.3) y
 * los **correctivos**, que son las órdenes ya devueltas a operación. Es la fuente del cronograma y del informe de cada servicio.
 * Los preventivos anulados en Flota no se muestran.
 */
@Injectable()
export class HistorialService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly preventivos: PreventivosService,
  ) {}

  async deUnidad(unidadId: string, clase?: ClaseMantenimiento): Promise<RegistroDeHistorial[]> {
    const unidad = await this.prisma.flotaUnidad.findUnique({
      where: { id: unidadId },
      select: { id: true },
    });
    if (!unidad) throw new NotFoundException('La unidad no existe');
    const [pm, cm] = await Promise.all([
      clase === 'correctivo' ? [] : this.deLosPreventivos(unidadId),
      clase === 'preventivo' ? [] : this.deLosCorrectivos(unidadId),
    ]);
    return [...pm, ...cm].sort((a, b) => b.fecha.localeCompare(a.fecha));
  }

  private async deLosPreventivos(unidadId: string): Promise<RegistroDeHistorial[]> {
    const filas = await this.preventivos.listar(unidadId);
    return filas
      .filter((f) => !f.anulado)
      .map((f) => ({
        clase: 'preventivo' as const,
        fecha: f.fecha,
        unidadId,
        ejecutadoPor: f.ejecutadoPor === 'tercero' ? ('tercero' as const) : ('interno' as const),
        responsable: f.responsable,
        observaciones: f.observaciones,
        preventivo: {
          id: f.id,
          tipoServicio: f.tipoServicio,
          valor: f.valor,
          proveedor: f.proveedor,
          checklistArchivo: f.checklistArchivo,
        },
        correctivo: null,
      }));
  }

  private async deLosCorrectivos(unidadId: string): Promise<RegistroDeHistorial[]> {
    const ordenes = await this.prisma.orden.findMany({
      where: { retornadaAt: { not: null }, reporte: { unidadId } },
      include: {
        reporte: { select: { codigo: true } },
        retornador: { select: { id: true, nombre: true } },
        subordenes: {
          include: { tipo: true, repuestos: { select: { id: true } } },
          orderBy: { tipo: { orden: 'asc' } },
        },
      },
      orderBy: { retornadaAt: 'desc' },
      take: 500,
    });
    return ordenes.map((o) => ({
      clase: 'correctivo' as const,
      fecha: dia(o.retornadaAt as Date),
      unidadId,
      ejecutadoPor: 'interno' as const,
      responsable: o.retornador,
      observaciones: o.observacionesFinales,
      preventivo: null,
      correctivo: {
        ordenId: o.id,
        ordenCodigo: o.reporte.codigo,
        estadoFinal:
          o.estadoFinal === 'con_restricciones'
            ? 'con_restricciones'
            : o.estadoFinal
              ? 'disponible'
              : null,
        subordenes: o.subordenes.map((s) => ({
          codigo: `${o.reporte.codigo}-${s.tipo.sufijo}`,
          tipo: s.tipo.nombre,
          horasTrabajo: s.horasTrabajo === null ? null : Number(s.horasTrabajo),
          repuestos: s.repuestos.length,
        })),
      },
    }));
  }
}
