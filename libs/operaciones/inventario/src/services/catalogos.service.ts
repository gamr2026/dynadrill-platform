import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { uuidv7 } from '@dyn/utils';
import type {
  ActualizarCategoriaDto,
  ActualizarSubcategoriaDto,
  CategoriaDto,
  ListarMotivosDto,
  SubcategoriaDto,
  UnidadStockDto,
} from '../dto/inventario.dto';
import { Prisma } from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';

/** Una clave única repetida se informa con un mensaje claro (409), no como un error de base de datos. */
async function sinDuplicar<T>(accion: () => Promise<T>, mensaje: string): Promise<T> {
  try {
    return await accion();
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      throw new ConflictException({ message: mensaje, code: 'NOMBRE_DUPLICADO' });
    }
    throw e;
  }
}

/** Catálogos propios del módulo: categorías y subcategorías, unidades de stock y motivos de movimiento; y las bodegas (de `catalogos`). */
@Injectable()
export class CatalogosService {
  constructor(private readonly prisma: PrismaService) {}

  categorias() {
    return this.prisma.categoriaArticulo.findMany({
      orderBy: { nombre: 'asc' },
      select: {
        id: true,
        nombre: true,
        esQuimica: true,
        llevaPartes: true,
        activo: true,
        subcategorias: {
          orderBy: { nombre: 'asc' },
          select: { id: true, nombre: true, activo: true },
        },
      },
    });
  }

  crearCategoria(dto: CategoriaDto, actorId: string) {
    return sinDuplicar(
      () =>
        this.prisma.categoriaArticulo.create({
          data: {
            id: uuidv7(),
            nombre: dto.nombre.trim(),
            esQuimica: dto.esQuimica ?? false,
            llevaPartes: dto.llevaPartes ?? false,
            createdBy: actorId,
            updatedBy: actorId,
          },
          select: { id: true, nombre: true, esQuimica: true, llevaPartes: true, activo: true },
        }),
      'Ya existe una categoría con ese nombre',
    );
  }

  async actualizarCategoria(id: string, dto: ActualizarCategoriaDto, actorId: string) {
    if (
      !(await this.prisma.categoriaArticulo.findUnique({ where: { id }, select: { id: true } }))
    ) {
      throw new NotFoundException('La categoría no existe');
    }
    return sinDuplicar(
      () =>
        this.prisma.categoriaArticulo.update({
          where: { id },
          data: {
            ...(dto.nombre !== undefined ? { nombre: dto.nombre.trim() } : {}),
            ...(dto.esQuimica !== undefined ? { esQuimica: dto.esQuimica } : {}),
            ...(dto.llevaPartes !== undefined ? { llevaPartes: dto.llevaPartes } : {}),
            ...(dto.activo !== undefined ? { activo: dto.activo } : {}),
            updatedBy: actorId,
          },
          select: { id: true, nombre: true, esQuimica: true, llevaPartes: true, activo: true },
        }),
      'Ya existe una categoría con ese nombre',
    );
  }

  async crearSubcategoria(categoriaId: string, dto: SubcategoriaDto, actorId: string) {
    if (
      !(await this.prisma.categoriaArticulo.findUnique({
        where: { id: categoriaId },
        select: { id: true },
      }))
    ) {
      throw new NotFoundException('La categoría no existe');
    }
    return sinDuplicar(
      () =>
        this.prisma.subcategoriaArticulo.create({
          data: {
            id: uuidv7(),
            categoriaId,
            nombre: dto.nombre.trim(),
            createdBy: actorId,
            updatedBy: actorId,
          },
          select: { id: true, categoriaId: true, nombre: true, activo: true },
        }),
      'Esa categoría ya tiene una subcategoría con ese nombre',
    );
  }

  async actualizarSubcategoria(id: string, dto: ActualizarSubcategoriaDto, actorId: string) {
    if (
      !(await this.prisma.subcategoriaArticulo.findUnique({ where: { id }, select: { id: true } }))
    ) {
      throw new NotFoundException('La subcategoría no existe');
    }
    return sinDuplicar(
      () =>
        this.prisma.subcategoriaArticulo.update({
          where: { id },
          data: {
            ...(dto.nombre !== undefined ? { nombre: dto.nombre.trim() } : {}),
            ...(dto.activo !== undefined ? { activo: dto.activo } : {}),
            updatedBy: actorId,
          },
          select: { id: true, categoriaId: true, nombre: true, activo: true },
        }),
      'Esa categoría ya tiene una subcategoría con ese nombre',
    );
  }

  unidades() {
    return this.prisma.unidadStock.findMany({
      orderBy: { nombre: 'asc' },
      select: { id: true, nombre: true, simbolo: true, activo: true },
    });
  }

  crearUnidad(dto: UnidadStockDto, actorId: string) {
    return sinDuplicar(
      () =>
        this.prisma.unidadStock.create({
          data: {
            id: uuidv7(),
            nombre: dto.nombre.trim(),
            simbolo: dto.simbolo.trim(),
            createdBy: actorId,
            updatedBy: actorId,
          },
          select: { id: true, nombre: true, simbolo: true, activo: true },
        }),
      'Ya existe una unidad con ese nombre',
    );
  }

  motivos(f: ListarMotivosDto) {
    return this.prisma.motivoMovimiento.findMany({
      where: {
        activo: true,
        ...(f.manual !== undefined ? { manual: f.manual } : {}),
        ...(f.tipo ? { tipo: f.tipo } : {}),
      },
      orderBy: [{ tipo: 'asc' }, { nombre: 'asc' }],
      select: { id: true, nombre: true, tipo: true, origen: true, manual: true },
    });
  }

  /** Bodegas habilitadas (el catálogo es de la plataforma; aquí solo se leen). */
  bodegas() {
    return this.prisma.catBodega.findMany({
      where: { habilitado: true },
      orderBy: { nombre: 'asc' },
      select: { id: true, nombre: true },
    });
  }
}
