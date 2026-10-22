import { Injectable, NotFoundException } from '@nestjs/common';
import { aDia, diasHasta } from '../comun/fechas';
import { PrismaService } from '../prisma/prisma.service';

/** Consecutivo visible del desecho: DES-000001. */
export const codigoDesecho = (numero: number): string => `DES-${String(numero).padStart(6, '0')}`;

export interface FiltroDesechos {
  estado?: string;
  q?: string;
}

/** Lectura de desechos: catálogos para el formulario, bandeja y detalle con los días que quedan al límite de 12 meses (AM 142). */
@Injectable()
export class DesechosConsultaService {
  constructor(private readonly prisma: PrismaService) {}

  /** Catálogos del formulario de registro (los usa quien reporta, aunque no vea la bandeja). */
  async catalogos() {
    const [caracteristicas, contenedores, pozos] = await Promise.all([
      this.prisma.desechoCaracteristica.findMany({
        where: { activo: true },
        orderBy: { orden: 'asc' },
        select: { id: true, codigo: true, nombre: true },
      }),
      this.prisma.desechoContenedor.findMany({
        where: { activo: true },
        orderBy: { orden: 'asc' },
        select: { id: true, codigo: true, nombre: true, uso: true },
      }),
      this.prisma.catPozo.findMany({
        where: { habilitado: true },
        orderBy: { nombreCompleto: 'asc' },
        select: { id: true, codigo: true, nombreCompleto: true },
      }),
    ]);
    return { caracteristicas, contenedores, pozos };
  }

  async listar(filtro: FiltroDesechos = {}) {
    const q = filtro.q?.trim();
    const filas = await this.prisma.desecho.findMany({
      where: {
        ...(filtro.estado ? { estado: { codigo: filtro.estado } } : {}),
        ...(q
          ? {
              OR: [
                { descripcion: { contains: q, mode: 'insensitive' } },
                { ubicacion: { contains: q, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      orderBy: { numero: 'desc' },
      include: {
        estado: { select: { codigo: true, nombre: true } },
        contenedor: { select: { codigo: true, nombre: true } },
        pozo: { select: { nombreCompleto: true } },
        caracteristicas: { include: { caracteristica: { select: { nombre: true } } } },
        _count: { select: { items: true } },
      },
      take: 300,
    });
    return filas.map((d) => this.resumen(d));
  }

  async detalle(id: string) {
    const d = await this.prisma.desecho.findUnique({
      where: { id },
      include: {
        estado: { select: { codigo: true, nombre: true } },
        contenedor: { select: { codigo: true, nombre: true, uso: true } },
        pozo: { select: { codigo: true, nombreCompleto: true } },
        caracteristicas: {
          include: { caracteristica: { select: { codigo: true, nombre: true } } },
        },
        items: { orderBy: { orden: 'asc' } },
        historial: {
          orderBy: { createdAt: 'asc' },
          include: { estadoNuevo: { select: { codigo: true, nombre: true } } },
        },
        _count: { select: { items: true } },
      },
    });
    if (!d) throw new NotFoundException('El desecho no existe');
    const nombres = await this.nombres([d.createdBy, ...d.historial.map((h) => h.actorId)]);
    return {
      ...this.resumen(d),
      pozo: d.pozo ? { codigo: d.pozo.codigo, nombre: d.pozo.nombreCompleto } : null,
      generadoPor: nombres.get(d.createdBy) ?? null,
      items: d.items.map((i) => ({
        id: i.id,
        orden: i.orden,
        descripcion: i.descripcion,
        numeroLote: i.numeroLote,
        codigo: i.codigo,
        cantidadGalones: Number(i.cantidadGalones),
        bultos: i.bultos,
      })),
      totalGalones: d.items.reduce((t, i) => t + Number(i.cantidadGalones), 0),
      historial: d.historial.map((h) => ({
        estado: h.estadoNuevo,
        actor: nombres.get(h.actorId) ?? null,
        at: h.createdAt,
      })),
    };
  }

  private resumen(d: {
    id: string;
    numero: number;
    clasificacion: string;
    descripcion: string;
    registradoAt: Date;
    limiteAlmacenamientoHasta: Date;
    estado: { codigo: string; nombre: string };
    contenedor: { codigo: string; nombre: string };
    pozo: { nombreCompleto: string } | null;
    caracteristicas: Array<{ caracteristica: { nombre: string } }>;
    _count: { items: number };
    ubicacion: string | null;
  }) {
    const limite = aDia(d.limiteAlmacenamientoHasta);
    const dias = diasHasta(limite);
    const abierto = d.estado.codigo !== 'dispuesto';
    return {
      id: d.id,
      numero: d.numero,
      codigo: codigoDesecho(d.numero),
      clasificacion: d.clasificacion,
      cretib: d.caracteristicas.map((c) => c.caracteristica.nombre),
      contenedor: d.contenedor,
      descripcion: d.descripcion,
      ubicacion: d.pozo?.nombreCompleto ?? d.ubicacion,
      estado: d.estado,
      items: d._count.items,
      registradoAt: d.registradoAt,
      limiteAlmacenamientoHasta: limite,
      /** Días que quedan al límite de 12 meses (negativo si ya pasó); nulo si ya fue dispuesto. */
      diasParaLimite: abierto ? dias : null,
      vencido: abierto && dias < 0,
    };
  }

  /** Nombre de cada cuenta (las columnas de personas no tienen relación de Prisma: ver schema.prisma). */
  private async nombres(ids: string[]): Promise<Map<string, string>> {
    const filas = await this.prisma.idUsuario.findMany({
      where: { id: { in: [...new Set(ids)] } },
      select: { id: true, nombre: true },
    });
    return new Map(filas.map((f) => [f.id, f.nombre]));
  }
}
