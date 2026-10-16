import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Permission } from '@dyn/authz';
import type { AuthUser } from '@dyn/common';
import { uuidv7 } from '@dyn/utils';
import type { CampoResponse, CreateCampoDto, UpdateCampoDto } from '../dto/catalogos.dto';
import { toCampo } from '../dto/mappers';
import { PrismaService } from '../prisma/prisma.service';
import { CatalogoEventos, exigirInactivar } from './catalogo-eventos.service';

const RELACIONES = { zona: true } as const;

@Injectable()
export class CamposService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventos: CatalogoEventos,
  ) {}

  async findAll(): Promise<CampoResponse[]> {
    return (
      await this.prisma.campo.findMany({ orderBy: { nombre: 'asc' }, include: RELACIONES })
    ).map(toCampo);
  }

  async findOne(id: string): Promise<CampoResponse> {
    const row = await this.prisma.campo.findUnique({ where: { id }, include: RELACIONES });
    if (!row) throw new NotFoundException(`Campo ${id} no existe`);
    return toCampo(row);
  }

  async create(dto: CreateCampoDto, actor: AuthUser): Promise<CampoResponse> {
    await this.assertReferencias(dto);
    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.campo.create({
        data: {
          id: uuidv7(),
          nombre: dto.nombre,
          zonaId: dto.zonaId ?? null,
          ...(dto.habilitado !== undefined ? { habilitado: dto.habilitado } : {}),
          createdBy: actor.id,
          updatedBy: actor.id,
        },
        include: RELACIONES,
      });
      await this.eventos.publicar(tx, 'campo', created.id, 'creado', actor);
      return created;
    });
    return toCampo(row);
  }

  async update(id: string, dto: UpdateCampoDto, actor: AuthUser): Promise<CampoResponse> {
    const current = await this.prisma.campo.findUnique({ where: { id } });
    if (!current) throw new NotFoundException(`Campo ${id} no existe`);
    exigirInactivar(actor, Permission.UBICACION_INACTIVAR, current.habilitado, dto.habilitado);
    await this.assertReferencias(dto);

    const row = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.campo.update({
        where: { id },
        data: {
          ...(dto.nombre !== undefined ? { nombre: dto.nombre } : {}),
          ...(dto.zonaId !== undefined ? { zonaId: dto.zonaId } : {}),
          ...(dto.habilitado !== undefined ? { habilitado: dto.habilitado } : {}),
          updatedBy: actor.id,
        },
        include: RELACIONES,
      });
      const inactivado = dto.habilitado === false && current.habilitado;
      await this.eventos.publicar(
        tx,
        'campo',
        id,
        inactivado ? 'inactivado' : 'actualizado',
        actor,
      );
      return updated;
    });
    return toCampo(row);
  }

  async inactivar(id: string, actor: AuthUser): Promise<void> {
    const current = await this.prisma.campo.findUnique({ where: { id } });
    if (!current) throw new NotFoundException(`Campo ${id} no existe`);
    if (!current.habilitado) return;
    await this.prisma.$transaction(async (tx) => {
      await tx.campo.update({ where: { id }, data: { habilitado: false, updatedBy: actor.id } });
      await this.eventos.publicar(tx, 'campo', id, 'inactivado', actor);
    });
  }

  /** La zona debe existir en su catálogo. */
  private async assertReferencias(dto: { zonaId?: string | null }) {
    if (dto.zonaId) {
      const z = await this.prisma.zona.findUnique({
        where: { id: dto.zonaId },
        select: { id: true },
      });
      if (!z) throw new BadRequestException('La zona indicada no existe');
    }
  }
}
