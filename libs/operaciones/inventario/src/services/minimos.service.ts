import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { uuidv7 } from '@dyn/utils';
import type { Prisma } from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';
import { saldosPorBodega } from './kardex';

const MAXIMO = 99_999_999_999.999;

export interface FiltroMinimos {
  articuloId?: string;
  bodegaId?: string;
  /** Solo los que hoy están por debajo de su mínimo. */
  bajoMinimo?: boolean;
}

/** El resultado de comprobar un movimiento contra el mínimo de su artículo y bodega. */
export interface CruceDeMinimo {
  minimo: number;
  saldo: number;
}

/**
 * Mínimos de stock por artículo y bodega (IN4, decisión provisional). El saldo siempre sale del kardex; aquí solo se guarda el mínimo.
 * Una salida que deja el saldo por debajo del mínimo (viniendo de estar en él o por encima) publica el evento
 * `operaciones.inventario.stock.bajo_minimo` una sola vez; quedarse por debajo no lo repite, y volver a subir y cruzar otra vez, sí.
 */
@Injectable()
export class MinimosService {
  constructor(private readonly prisma: PrismaService) {}

  async listar(f: FiltroMinimos = {}) {
    const filas = await this.prisma.stockMinimo.findMany({
      where: {
        ...(f.articuloId ? { articuloId: f.articuloId } : {}),
        ...(f.bodegaId ? { bodegaId: f.bodegaId } : {}),
      },
      include: {
        articulo: { select: { codigo: true, nombre: true } },
        bodega: { select: { nombre: true } },
      },
      orderBy: [{ articulo: { codigo: 'asc' } }, { bodega: { nombre: 'asc' } }],
      take: 500,
    });
    const saldos = await this.saldos(filas.map((x) => [x.articuloId, x.bodegaId]));
    const vistas = filas.map((x) => {
      const saldo = saldos.get(`${x.articuloId}:${x.bodegaId}`) ?? 0;
      const minimo = Number(x.minimo);
      return {
        articuloId: x.articuloId,
        articuloCodigo: x.articulo.codigo,
        articulo: x.articulo.nombre,
        bodegaId: x.bodegaId,
        bodega: x.bodega.nombre,
        minimo,
        stock: saldo,
        bajoMinimo: saldo < minimo,
        faltante: Math.max(0, Math.round((minimo - saldo) * 1000) / 1000),
      };
    });
    return f.bajoMinimo ? vistas.filter((v) => v.bajoMinimo) : vistas;
  }

  /** Fija (o cambia) el mínimo de un artículo en una bodega. */
  async fijar(articuloId: string, bodegaId: string, minimo: number, actorId: string) {
    if (!Number.isFinite(minimo) || minimo <= 0) {
      throw new BadRequestException('El mínimo debe ser mayor que cero');
    }
    if (minimo > MAXIMO || Math.round(minimo * 1000) / 1000 !== minimo) {
      throw new BadRequestException('El mínimo admite hasta 3 decimales y no puede ser tan grande');
    }
    if (
      !(await this.prisma.articulo.findUnique({ where: { id: articuloId }, select: { id: true } }))
    ) {
      throw new NotFoundException('El artículo no existe');
    }
    const bodega = await this.prisma.catBodega.findUnique({ where: { id: bodegaId } });
    if (!bodega || !bodega.habilitado) {
      throw new BadRequestException('La bodega indicada no existe o no está habilitada');
    }
    await this.prisma.stockMinimo.upsert({
      where: { articuloId_bodegaId: { articuloId, bodegaId } },
      create: {
        id: uuidv7(),
        articuloId,
        bodegaId,
        minimo,
        createdBy: actorId,
        updatedBy: actorId,
      },
      update: { minimo, updatedBy: actorId },
    });
    return (await this.listar({ articuloId, bodegaId }))[0];
  }

  /** Quita el mínimo (el artículo deja de avisarse en esa bodega). El kardex no cambia. */
  async quitar(articuloId: string, bodegaId: string): Promise<void> {
    const r = await this.prisma.stockMinimo.deleteMany({ where: { articuloId, bodegaId } });
    if (r.count === 0) throw new NotFoundException('Ese artículo no tiene mínimo en esa bodega');
  }

  /** Los mínimos de un artículo por bodega (para mostrarlos junto a sus existencias). */
  async deArticulo(articuloId: string): Promise<Map<string, number>> {
    const filas = await this.prisma.stockMinimo.findMany({ where: { articuloId } });
    return new Map(filas.map((f) => [f.bodegaId, Number(f.minimo)]));
  }

  /**
   * ¿Este movimiento hizo que el artículo cruzara su mínimo hacia abajo en esa bodega? Solo las salidas pueden: el saldo anterior estaba
   * en el mínimo o por encima, y el nuevo quedó por debajo. Se llama dentro de la transacción del movimiento, con el artículo ya bloqueado.
   */
  async cruzo(
    tx: Pick<Prisma.TransactionClient, 'stockMinimo'>,
    m: {
      articuloId: string;
      bodegaId: string;
      tipo: 'entrada' | 'salida';
      cantidad: Prisma.Decimal;
      saldoResultante: Prisma.Decimal;
    },
  ): Promise<CruceDeMinimo | null> {
    if (m.tipo !== 'salida') return null;
    const fila = await tx.stockMinimo.findUnique({
      where: { articuloId_bodegaId: { articuloId: m.articuloId, bodegaId: m.bodegaId } },
    });
    if (!fila) return null;
    const previo = m.saldoResultante.plus(m.cantidad);
    if (previo.gte(fila.minimo) && m.saldoResultante.lt(fila.minimo)) {
      return { minimo: Number(fila.minimo), saldo: Number(m.saldoResultante) };
    }
    return null;
  }

  /** Saldo actual de cada par (artículo, bodega), del kardex. */
  private async saldos(pares: Array<[string, string]>): Promise<Map<string, number>> {
    const salida = new Map<string, number>();
    for (const articuloId of new Set(pares.map((p) => p[0]))) {
      for (const s of await saldosPorBodega(this.prisma, articuloId)) {
        salida.set(`${articuloId}:${s.bodegaId}`, s.saldo);
      }
    }
    return salida;
  }
}
