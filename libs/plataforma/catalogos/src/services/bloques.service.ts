import { Injectable, NotFoundException } from '@nestjs/common';
import { Permission } from '@dyn/authz';
import type { AuthUser } from '@dyn/common';
import { uuidv7 } from '@dyn/utils';
import type { BloqueResponse, CreateBloqueDto, UpdateBloqueDto } from '../dto/catalogos.dto';
import { toBloque } from '../dto/mappers';
import { PrismaService } from '../prisma/prisma.service';
import { CatalogoEventos, exigirInactivar } from './catalogo-eventos.service';

@Injectable()
export class BloquesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventos: CatalogoEventos,
  ) {}

  async findAll(): Promise<BloqueResponse[]> {
    return (await this.prisma.bloque.findMany({ orderBy: { nombre: 'asc' } })).map(toBloque);
  }

  async findOne(id: string): Promise<BloqueResponse> {
    const row = await this.prisma.bloque.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(`Bloque ${id} no existe`);
    return toBloque(row);
  }

  async create(dto: CreateBloqueDto, actor: AuthUser): Promise<BloqueResponse> {
    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.bloque.create({
        data: { id: uuidv7(), ...dto, createdBy: actor.id, updatedBy: actor.id },
      });
      await this.eventos.publicar(tx, 'bloque', created.id, 'creado', actor);
      return created;
    });
    return toBloque(row);
  }

  async update(id: string, dto: UpdateBloqueDto, actor: AuthUser): Promise<BloqueResponse> {
    const current = await this.prisma.bloque.findUnique({ where: { id } });
    if (!current) throw new NotFoundException(`Bloque ${id} no existe`);
    exigirInactivar(actor, Permission.UBICACION_INACTIVAR, current.habilitado, dto.habilitado);

    const row = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.bloque.update({
        where: { id },
        data: { ...dto, updatedBy: actor.id },
      });
      const inactivado = dto.habilitado === false && current.habilitado;
      await this.eventos.publicar(
        tx,
        'bloque',
        id,
        inactivado ? 'inactivado' : 'actualizado',
        actor,
      );
      return updated;
    });
    return toBloque(row);
  }

  /** "Borrar" inactiva: las filas no se eliminan (otros módulos las referencian). Idempotente. */
  async inactivar(id: string, actor: AuthUser): Promise<void> {
    const current = await this.prisma.bloque.findUnique({ where: { id } });
    if (!current) throw new NotFoundException(`Bloque ${id} no existe`);
    if (!current.habilitado) return;
    await this.prisma.$transaction(async (tx) => {
      await tx.bloque.update({ where: { id }, data: { habilitado: false, updatedBy: actor.id } });
      await this.eventos.publicar(tx, 'bloque', id, 'inactivado', actor);
    });
  }
}
