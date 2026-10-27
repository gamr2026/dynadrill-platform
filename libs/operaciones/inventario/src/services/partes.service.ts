import { Injectable, NotFoundException } from '@nestjs/common';
import { uuidv7 } from '@dyn/utils';
import type { ParteDto } from '../dto/inventario.dto';
import { PrismaService } from '../prisma/prisma.service';

const CAMPOS = {
  id: true,
  articuloId: true,
  orden: true,
  item: true,
  codigo: true,
  descripcion: true,
  cantidadEsperada: true,
} as const;

/** Partes (lista de componentes) de una herramienta. El orden lo asigna el servidor, nunca el cliente. */
@Injectable()
export class PartesService {
  constructor(private readonly prisma: PrismaService) {}

  async listar(articuloId: string) {
    if (
      !(await this.prisma.articulo.findUnique({ where: { id: articuloId }, select: { id: true } }))
    ) {
      throw new NotFoundException('El artículo no existe');
    }
    return this.prisma.articuloParte.findMany({
      where: { articuloId },
      orderBy: { orden: 'asc' },
      select: CAMPOS,
    });
  }

  async crear(articuloId: string, dto: ParteDto, actorId: string) {
    return this.prisma.$transaction(async (tx) => {
      // se serializan las altas de un mismo artículo para que `orden` no se repita
      const bloqueado = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM inventario.articulo WHERE id = ${articuloId}::uuid FOR UPDATE`;
      if (!bloqueado.length) throw new NotFoundException('El artículo no existe');
      const ultima = await tx.articuloParte.findFirst({
        where: { articuloId },
        orderBy: { orden: 'desc' },
        select: { orden: true },
      });
      return tx.articuloParte.create({
        data: {
          id: uuidv7(),
          articuloId,
          orden: (ultima?.orden ?? 0) + 1,
          item: dto.item.trim(),
          codigo: dto.codigo?.trim() || null,
          descripcion: dto.descripcion.trim(),
          cantidadEsperada: dto.cantidadEsperada ?? 1,
          createdBy: actorId,
          updatedBy: actorId,
        },
        select: CAMPOS,
      });
    });
  }

  async actualizar(parteId: string, dto: ParteDto, actorId: string) {
    if (
      !(await this.prisma.articuloParte.findUnique({
        where: { id: parteId },
        select: { id: true },
      }))
    ) {
      throw new NotFoundException('La parte no existe');
    }
    return this.prisma.articuloParte.update({
      where: { id: parteId },
      data: {
        item: dto.item.trim(),
        codigo: dto.codigo?.trim() || null,
        descripcion: dto.descripcion.trim(),
        ...(dto.cantidadEsperada !== undefined ? { cantidadEsperada: dto.cantidadEsperada } : {}),
        updatedBy: actorId,
      },
      select: CAMPOS,
    });
  }

  async eliminar(parteId: string): Promise<void> {
    const r = await this.prisma.articuloParte.deleteMany({ where: { id: parteId } });
    if (!r.count) throw new NotFoundException('La parte no existe');
  }
}
