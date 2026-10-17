import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { uuidv7 } from '@dyn/utils';
import { PrismaService } from '../prisma/prisma.service';

/** Proveedores externos de mantenimiento (catálogo propio de Flota). */
@Injectable()
export class ProveedoresService {
  constructor(private readonly prisma: PrismaService) {}

  listar(incluirInactivos = false) {
    return this.prisma.proveedorMantenimiento.findMany({
      where: incluirInactivos ? {} : { activo: true },
      select: { id: true, nombre: true, activo: true },
      orderBy: { nombre: 'asc' },
    });
  }

  async crear(nombre: string, actorId: string) {
    const limpio = nombre.trim();
    const existe = await this.prisma.proveedorMantenimiento.findUnique({ where: { nombre: limpio } });
    if (existe) {
      throw new ConflictException({
        message: 'Ya existe un proveedor con ese nombre',
        code: 'proveedor_duplicado',
      });
    }
    const p = await this.prisma.proveedorMantenimiento.create({
      data: { id: uuidv7(), nombre: limpio, createdBy: actorId, updatedBy: actorId },
    });
    return { id: p.id, nombre: p.nombre, activo: p.activo };
  }

  async actualizar(id: string, cambios: { nombre?: string; activo?: boolean }, actorId: string) {
    const actual = await this.prisma.proveedorMantenimiento.findUnique({ where: { id } });
    if (!actual) throw new NotFoundException('El proveedor no existe');
    if (cambios.nombre !== undefined && cambios.nombre.trim() !== actual.nombre) {
      const otro = await this.prisma.proveedorMantenimiento.findUnique({
        where: { nombre: cambios.nombre.trim() },
      });
      if (otro) {
        throw new ConflictException({
          message: 'Ya existe un proveedor con ese nombre',
          code: 'proveedor_duplicado',
        });
      }
    }
    const p = await this.prisma.proveedorMantenimiento.update({
      where: { id },
      data: {
        ...(cambios.nombre !== undefined ? { nombre: cambios.nombre.trim() } : {}),
        ...(cambios.activo !== undefined ? { activo: cambios.activo } : {}),
        updatedBy: actorId,
        updatedAt: new Date(),
      },
    });
    return { id: p.id, nombre: p.nombre, activo: p.activo };
  }
}
