import { Injectable, NotFoundException } from '@nestjs/common';
import { aDia, hoyEcuador } from '../comun/fechas';
import {
  ClasificacionAspecto,
  CondicionOperacionAspecto,
  EstadoAspecto,
  EstadoControlAspecto,
  TipoImpactoAspecto,
  TipoResponsabilidadAspecto,
} from '../generated/client';
import type { Prisma } from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';

/** Consecutivo visible del aspecto: ASP-000001. */
export const codigoAspecto = (numero: number): string => `ASP-${String(numero).padStart(6, '0')}`;

/** Nivel de riesgo ambiental: probabilidad × consecuencia (cada una de 1 a 5). Se calcula, no se guarda. */
export const nivelRiesgoAspecto = (probabilidad: number, consecuencia: number): number =>
  probabilidad * consecuencia;

export interface FiltroAspectos {
  clasificacion?: ClasificacionAspecto;
  estadoControl?: EstadoControlAspecto;
  procesoId?: string;
  /** Por defecto solo los vigentes. */
  estado?: EstadoAspecto;
  q?: string;
}

const CON_CATALOGOS = {
  etapa: { select: { id: true, nombre: true } },
  factor: { select: { id: true, nombre: true } },
} satisfies Prisma.AspectoAmbientalInclude;

type Fila = Prisma.AspectoAmbientalGetPayload<{ include: typeof CON_CATALOGOS }>;

/** Lectura de aspectos ambientales: catálogos, matriz con su nivel de riesgo y detalle con control y seguimiento. */
@Injectable()
export class AspectosAmbientalesConsultaService {
  constructor(private readonly prisma: PrismaService) {}

  async catalogos() {
    const [etapas, factores, frecuencias, procesos] = await Promise.all([
      this.prisma.aspectoEtapaCicloVida.findMany({
        where: { activo: true },
        orderBy: { orden: 'asc' },
        select: { id: true, codigo: true, nombre: true },
      }),
      this.prisma.aspectoFactorAmbiental.findMany({
        where: { activo: true },
        orderBy: { orden: 'asc' },
        select: { id: true, codigo: true, nombre: true },
      }),
      this.prisma.frecuenciaSeguimiento.findMany({
        where: { activo: true },
        orderBy: { orden: 'asc' },
        select: { id: true, codigo: true, nombre: true },
      }),
      this.prisma.ipercProceso.findMany({
        where: { activo: true },
        orderBy: { orden: 'asc' },
        select: { id: true, codigo: true, nombre: true },
      }),
    ]);
    return {
      etapas,
      factores,
      frecuencias,
      procesos,
      // conjuntos fijos del formato (enums de la base)
      clasificaciones: Object.values(ClasificacionAspecto),
      condicionesOperacion: Object.values(CondicionOperacionAspecto),
      tiposResponsabilidad: Object.values(TipoResponsabilidadAspecto),
      tiposImpacto: Object.values(TipoImpactoAspecto),
      estadosControl: Object.values(EstadoControlAspecto),
    };
  }

  async listar(f: FiltroAspectos = {}) {
    const q = f.q?.trim();
    const filas = await this.prisma.aspectoAmbiental.findMany({
      where: {
        estado: f.estado ?? EstadoAspecto.vigente,
        ...(f.clasificacion ? { clasificacion: f.clasificacion } : {}),
        ...(f.estadoControl ? { estadoControl: f.estadoControl } : {}),
        ...(f.procesoId ? { procesoId: f.procesoId } : {}),
        ...(q
          ? {
              OR: [
                { actividad: { contains: q, mode: 'insensitive' } },
                { aspecto: { contains: q, mode: 'insensitive' } },
                { impacto: { contains: q, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      orderBy: [{ numero: 'desc' }],
      take: 500,
      include: CON_CATALOGOS,
    });
    const procesos = await this.procesos(filas.map((a) => a.procesoId));
    const items = filas.map((a) => this.resumen(a, procesos));
    const contar = (c: ClasificacionAspecto) => items.filter((i) => i.clasificacion === c).length;
    return {
      items,
      kpi: {
        total: items.length,
        bajo: contar(ClasificacionAspecto.bajo),
        moderado: contar(ClasificacionAspecto.moderado),
        alto: contar(ClasificacionAspecto.alto),
        controlVencido: items.filter((i) => i.controlVencido).length,
      },
    };
  }

  async detalle(id: string) {
    const a = await this.prisma.aspectoAmbiental.findUnique({
      where: { id },
      include: {
        ...CON_CATALOGOS,
        seguimientoFrecuencia: { select: { id: true, nombre: true } },
        seguimientos: { orderBy: [{ fecha: 'desc' }, { createdAt: 'desc' }] },
      },
    });
    if (!a) throw new NotFoundException('El aspecto ambiental no existe');
    const procesos = await this.procesos([a.procesoId]);
    const personas = await this.nombres([
      a.createdBy,
      a.responsableId,
      a.seguimientoResponsableId,
      a.bajaPor,
      ...a.seguimientos.map((s) => s.createdBy),
    ]);
    const nombre = (id: string | null) => (id ? { id, nombre: personas.get(id) ?? null } : null);
    return {
      ...this.resumen(a, procesos),
      produccionDelAspecto: a.produccionDelAspecto,
      riesgoGestion: a.riesgoGestion,
      condicionOperacion: a.condicionOperacion,
      tipoResponsabilidad: a.tipoResponsabilidad,
      tipoImpacto: a.tipoImpacto,
      fechaValoracion: a.fechaValoracion ? aDia(a.fechaValoracion) : null,
      control: {
        ncar: a.ncar,
        planAccionExistente: a.planAccionExistente,
        planTratamiento: a.planTratamiento,
        responsable: nombre(a.responsableId),
        presupuesto: a.presupuesto === null ? null : Number(a.presupuesto),
        plazo: a.plazo ? aDia(a.plazo) : null,
        estadoControl: a.estadoControl,
      },
      seguimiento: {
        indicador: a.seguimientoIndicador,
        responsable: nombre(a.seguimientoResponsableId),
        frecuencia: a.seguimientoFrecuencia,
        registros: a.seguimientos.map((s) => ({
          id: s.id,
          fecha: aDia(s.fecha),
          eficaz: s.eficaz,
          observacion: s.observacion,
          registradoPor: personas.get(s.createdBy) ?? null,
          registradoAt: s.createdAt,
        })),
        ultimaEficacia: a.seguimientos[0]?.eficaz ?? null,
      },
      baja: a.bajaAt
        ? { at: a.bajaAt, por: personas.get(a.bajaPor ?? '') ?? null, motivo: a.bajaMotivo }
        : null,
      creadoPor: personas.get(a.createdBy) ?? null,
      createdAt: a.createdAt,
    };
  }

  private resumen(a: Fila, procesos: Map<string, string>) {
    const plazo = a.plazo ? aDia(a.plazo) : null;
    return {
      id: a.id,
      numero: a.numero,
      codigo: codigoAspecto(a.numero),
      estado: a.estado,
      fecha: aDia(a.fecha),
      etapa: a.etapa,
      proceso: { id: a.procesoId, nombre: procesos.get(a.procesoId) ?? null },
      actividad: a.actividad,
      aspecto: a.aspecto,
      impacto: a.impacto,
      factor: a.factor,
      probabilidad: a.probabilidad,
      consecuencia: a.consecuencia,
      nivelRiesgo: nivelRiesgoAspecto(a.probabilidad, a.consecuencia),
      clasificacion: a.clasificacion,
      estadoControl: a.estadoControl,
      plazo,
      // el control está vencido si sigue sin implementarse pasado su plazo (base del aviso del subdominio 4)
      controlVencido:
        a.estado === EstadoAspecto.vigente &&
        a.estadoControl !== EstadoControlAspecto.implementado &&
        plazo !== null &&
        plazo < hoyEcuador(),
    };
  }

  private async procesos(ids: string[]): Promise<Map<string, string>> {
    const filas = await this.prisma.ipercProceso.findMany({
      where: { id: { in: [...new Set(ids)] } },
      select: { id: true, nombre: true },
    });
    return new Map(filas.map((p) => [p.id, p.nombre]));
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
