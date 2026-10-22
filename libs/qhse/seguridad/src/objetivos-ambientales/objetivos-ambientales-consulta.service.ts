import { Injectable, NotFoundException } from '@nestjs/common';
import { aDia } from '../comun/fechas';
import { EstadoObjetivoAmbiental } from '../generated/client';
import type { Prisma } from '../generated/client';
import { estadoDeVigencia } from '../legal/requisitos-legales-consulta.service';
import { PrismaService } from '../prisma/prisma.service';

/** Consecutivo visible del objetivo: OBJ-000001. */
export const codigoObjetivo = (numero: number): string => `OBJ-${String(numero).padStart(6, '0')}`;

export interface FiltroObjetivos {
  estado?: EstadoObjetivoAmbiental;
  q?: string;
}

type Fila = Prisma.ObjetivoAmbientalGetPayload<{
  include: { seguimientos: { select: { fecha: true; avancePorcentaje: true } } };
}>;

/** Lectura de objetivos ambientales: catálogos, bandeja con el estado del plazo y detalle con plan de acción y seguimiento. */
@Injectable()
export class ObjetivosAmbientalesConsultaService {
  constructor(private readonly prisma: PrismaService) {}

  async catalogos() {
    return {
      frecuencias: await this.prisma.frecuenciaSeguimiento.findMany({
        where: { activo: true },
        orderBy: { orden: 'asc' },
        select: { id: true, codigo: true, nombre: true },
      }),
    };
  }

  async listar(f: FiltroObjetivos = {}) {
    const q = f.q?.trim();
    const filas = await this.prisma.objetivoAmbiental.findMany({
      where: {
        ...(f.estado ? { estado: f.estado } : {}),
        ...(q
          ? {
              OR: [
                { titulo: { contains: q, mode: 'insensitive' } },
                { objetivo: { contains: q, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      orderBy: [{ numero: 'desc' }],
      take: 500,
      include: { seguimientos: { select: { fecha: true, avancePorcentaje: true } } },
    });
    const items = filas.map((o) => this.resumen(o));
    return {
      items,
      kpi: {
        total: items.length,
        enCurso: items.filter((i) => i.estado === EstadoObjetivoAmbiental.en_curso).length,
        vencidos: items.filter((i) => i.estadoPlazo === 'vencido').length,
        porVencer: items.filter((i) => i.estadoPlazo === 'por_vencer').length,
      },
    };
  }

  async detalle(id: string) {
    const o = await this.prisma.objetivoAmbiental.findUnique({
      where: { id },
      include: {
        seguimientos: { orderBy: [{ fecha: 'desc' }, { createdAt: 'desc' }] },
        acciones: {
          orderBy: { orden: 'asc' },
          include: { frecuencia: { select: { id: true, nombre: true } } },
        },
      },
    });
    if (!o) throw new NotFoundException('El objetivo ambiental no existe');
    const personas = await this.nombres([
      o.createdBy,
      o.cerradoPor,
      ...o.acciones.map((a) => a.responsableId),
      ...o.seguimientos.map((s) => s.createdBy),
    ]);
    return {
      ...this.resumen(o),
      objetivo: o.objetivo,
      meta: o.meta,
      indicador: o.indicador,
      beneficioEmpresarial: o.beneficioEmpresarial,
      resultado: o.resultado,
      evidencia: o.evidencia,
      cerradoAt: o.cerradoAt,
      cerradoPor: o.cerradoPor ? (personas.get(o.cerradoPor) ?? null) : null,
      creadoPor: personas.get(o.createdBy) ?? null,
      createdAt: o.createdAt,
      planAccion: o.acciones.map((a) => ({
        orden: a.orden,
        accionEspecifica: a.accionEspecifica,
        responsable: a.responsableId
          ? { id: a.responsableId, nombre: personas.get(a.responsableId) ?? null }
          : null,
        indicador: a.indicador,
        evidenciaEsperada: a.evidenciaEsperada,
        frecuencia: a.frecuencia,
      })),
      seguimientos: o.seguimientos.map((s) => ({
        id: s.id,
        fecha: aDia(s.fecha),
        avancePorcentaje: s.avancePorcentaje,
        observacion: s.observacion,
        registradoPor: personas.get(s.createdBy) ?? null,
        registradoAt: s.createdAt,
      })),
    };
  }

  private resumen(o: Fila) {
    const ultimo = [...o.seguimientos].sort((a, b) => b.fecha.getTime() - a.fecha.getTime())[0];
    const plazo = o.plazo ? aDia(o.plazo) : null;
    const vigencia = estadoDeVigencia(plazo);
    return {
      id: o.id,
      numero: o.numero,
      codigo: codigoObjetivo(o.numero),
      titulo: o.titulo,
      estado: o.estado,
      plazo,
      // el plazo solo corre mientras el objetivo está en curso
      estadoPlazo:
        o.estado !== EstadoObjetivoAmbiental.en_curso
          ? null
          : vigencia.estadoVigencia === 'sin_vencimiento'
            ? 'sin_plazo'
            : vigencia.estadoVigencia,
      diasParaVencer:
        o.estado === EstadoObjetivoAmbiental.en_curso ? vigencia.diasParaVencer : null,
      avanceActual: ultimo?.avancePorcentaje ?? null,
      ultimoSeguimiento: ultimo ? aDia(ultimo.fecha) : null,
    };
  }

  private async nombres(ids: Array<string | null>): Promise<Map<string, string>> {
    const unicos = [...new Set(ids.filter((x): x is string => !!x))];
    const filas = await this.prisma.idUsuario.findMany({
      where: { id: { in: unicos } },
      select: { id: true, nombre: true },
    });
    return new Map(filas.map((p) => [p.id, p.nombre]));
  }
}
