import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Permission } from '@dyn/authz';
import type { AuthUser } from '@dyn/common';
import { uuidv7 } from '@dyn/utils';
import type {
  CatalogoSimpleResponse,
  CreateCatalogoSimpleDto,
  UpdateCatalogoSimpleDto,
} from '../dto/catalogos.dto';
import { toCatalogoSimple } from '../dto/mappers';
import { PrismaService } from '../prisma/prisma.service';
import { CatalogoEventos, exigirInactivar } from './catalogo-eventos.service';

/** Zonas comerciales (ZONA ESTE, ZONA OESTE...). Cada campo pertenece a una. */
@Injectable()
export class ZonasService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventos: CatalogoEventos,
  ) {}

  async findAll(): Promise<CatalogoSimpleResponse[]> {
    return (await this.prisma.zona.findMany({ orderBy: { nombre: 'asc' } })).map(toCatalogoSimple);
  }

  async findOne(id: string): Promise<CatalogoSimpleResponse> {
    const row = await this.prisma.zona.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(`Zona ${id} no existe`);
    return toCatalogoSimple(row);
  }

  async create(dto: CreateCatalogoSimpleDto, actor: AuthUser): Promise<CatalogoSimpleResponse> {
    await this.assertNombreLibre(dto.nombre);
    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.zona.create({
        data: {
          id: uuidv7(),
          nombre: dto.nombre.trim(),
          ...(dto.habilitado !== undefined ? { habilitado: dto.habilitado } : {}),
          createdBy: actor.id,
          updatedBy: actor.id,
        },
      });
      await this.eventos.publicar(tx, 'zona', created.id, 'creado', actor);
      return created;
    });
    return toCatalogoSimple(row);
  }

  async update(
    id: string,
    dto: UpdateCatalogoSimpleDto,
    actor: AuthUser,
  ): Promise<CatalogoSimpleResponse> {
    const current = await this.prisma.zona.findUnique({ where: { id } });
    if (!current) throw new NotFoundException(`Zona ${id} no existe`);
    exigirInactivar(actor, Permission.UBICACION_INACTIVAR, current.habilitado, dto.habilitado);
    if (dto.nombre !== undefined) await this.assertNombreLibre(dto.nombre, id);
    const row = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.zona.update({
        where: { id },
        data: {
          ...(dto.nombre !== undefined ? { nombre: dto.nombre.trim() } : {}),
          ...(dto.habilitado !== undefined ? { habilitado: dto.habilitado } : {}),
          updatedBy: actor.id,
        },
      });
      const inactivado = dto.habilitado === false && current.habilitado;
      await this.eventos.publicar(tx, 'zona', id, inactivado ? 'inactivado' : 'actualizado', actor);
      return updated;
    });
    return toCatalogoSimple(row);
  }

  async inactivar(id: string, actor: AuthUser): Promise<void> {
    const current = await this.prisma.zona.findUnique({ where: { id } });
    if (!current) throw new NotFoundException(`Zona ${id} no existe`);
    if (!current.habilitado) return;
    await this.prisma.$transaction(async (tx) => {
      await tx.zona.update({ where: { id }, data: { habilitado: false, updatedBy: actor.id } });
      await this.eventos.publicar(tx, 'zona', id, 'inactivado', actor);
    });
  }

  /** Sin mayúsculas ni espacios que creen duplicados ("ZONA ESTE" y "Zona Este"). */
  private async assertNombreLibre(nombre: string, exceptoId?: string) {
    const existe = await this.prisma.zona.findFirst({
      where: {
        nombre: { equals: nombre.trim(), mode: 'insensitive' },
        ...(exceptoId ? { id: { not: exceptoId } } : {}),
      },
      select: { id: true },
    });
    if (existe) throw new ConflictException(`Ya existe una zona llamada "${nombre.trim()}"`);
  }
}
