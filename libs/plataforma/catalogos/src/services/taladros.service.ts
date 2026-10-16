import { Injectable, NotFoundException } from '@nestjs/common';
import { Permission } from '@dyn/authz';
import type { AuthUser } from '@dyn/common';
import { uuidv7 } from '@dyn/utils';
import type { CreateTaladroDto, TaladroResponse, UpdateTaladroDto } from '../dto/catalogos.dto';
import { toTaladro } from '../dto/mappers';
import { PrismaService } from '../prisma/prisma.service';
import { CatalogoEventos, exigirInactivar } from './catalogo-eventos.service';

@Injectable()
export class TaladrosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventos: CatalogoEventos,
  ) {}

  async findAll(): Promise<TaladroResponse[]> {
    return (await this.prisma.taladro.findMany({ orderBy: { nombre: 'asc' } })).map(toTaladro);
  }

  async findOne(id: string): Promise<TaladroResponse> {
    const row = await this.prisma.taladro.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(`Taladro ${id} no existe`);
    return toTaladro(row);
  }

  async create(dto: CreateTaladroDto, actor: AuthUser): Promise<TaladroResponse> {
    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.taladro.create({
        data: { id: uuidv7(), ...dto, createdBy: actor.id, updatedBy: actor.id },
      });
      await this.eventos.publicar(tx, 'taladro', created.id, 'creado', actor);
      return created;
    });
    return toTaladro(row);
  }

  async update(id: string, dto: UpdateTaladroDto, actor: AuthUser): Promise<TaladroResponse> {
    const current = await this.prisma.taladro.findUnique({ where: { id } });
    if (!current) throw new NotFoundException(`Taladro ${id} no existe`);
    exigirInactivar(actor, Permission.UBICACION_INACTIVAR, current.habilitado, dto.habilitado);

    const row = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.taladro.update({
        where: { id },
        data: { ...dto, updatedBy: actor.id },
      });
      const inactivado = dto.habilitado === false && current.habilitado;
      await this.eventos.publicar(
        tx,
        'taladro',
        id,
        inactivado ? 'inactivado' : 'actualizado',
        actor,
      );
      return updated;
    });
    return toTaladro(row);
  }

  async inactivar(id: string, actor: AuthUser): Promise<void> {
    const current = await this.prisma.taladro.findUnique({ where: { id } });
    if (!current) throw new NotFoundException(`Taladro ${id} no existe`);
    if (!current.habilitado) return;
    await this.prisma.$transaction(async (tx) => {
      await tx.taladro.update({ where: { id }, data: { habilitado: false, updatedBy: actor.id } });
      await this.eventos.publicar(tx, 'taladro', id, 'inactivado', actor);
    });
  }
}
