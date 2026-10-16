import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Permission } from '@dyn/authz';
import type { AuthUser } from '@dyn/common';
import { uuidv7 } from '@dyn/utils';
import type {
  CreatePozoDto,
  PozoResponse,
  PozosQueryDto,
  UpdatePozoDto,
} from '../dto/catalogos.dto';
import { toPozo } from '../dto/mappers';
import { PrismaService } from '../prisma/prisma.service';
import { CatalogoEventos, exigirInactivar } from './catalogo-eventos.service';

@Injectable()
export class PozosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventos: CatalogoEventos,
  ) {}

  /**
   * El pozo se lee siempre con su Campo y su Bloque anidados: elegir el pozo autocompleta campo y bloque sin
   * otra llamada. Filtros opcionales por `campoId` / `bloqueId` para las cascadas del frontend.
   */
  async findAll(filtro: PozosQueryDto = {}): Promise<PozoResponse[]> {
    const rows = await this.prisma.pozo.findMany({
      where: {
        ...(filtro.campoId ? { campoId: filtro.campoId } : {}),
        ...(filtro.bloqueId ? { bloqueId: filtro.bloqueId } : {}),
      },
      orderBy: { codigo: 'asc' },
      include: { campo: { include: { zona: true } }, bloque: true },
    });
    return rows.map(toPozo);
  }

  async findOne(id: string): Promise<PozoResponse> {
    const row = await this.prisma.pozo.findUnique({
      where: { id },
      include: { campo: { include: { zona: true } }, bloque: true },
    });
    if (!row) throw new NotFoundException(`Pozo ${id} no existe`);
    return toPozo(row);
  }

  async create(dto: CreatePozoDto, actor: AuthUser): Promise<PozoResponse> {
    await this.assertReferencias(dto.campoId, dto.bloqueId);
    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.pozo.create({
        data: { id: uuidv7(), ...dto, createdBy: actor.id, updatedBy: actor.id },
        include: { campo: { include: { zona: true } }, bloque: true },
      });
      await this.eventos.publicar(tx, 'pozo', created.id, 'creado', actor);
      return created;
    });
    return toPozo(row);
  }

  async update(id: string, dto: UpdatePozoDto, actor: AuthUser): Promise<PozoResponse> {
    const current = await this.prisma.pozo.findUnique({ where: { id } });
    if (!current) throw new NotFoundException(`Pozo ${id} no existe`);
    exigirInactivar(actor, Permission.UBICACION_INACTIVAR, current.habilitado, dto.habilitado);
    await this.assertReferencias(dto.campoId, dto.bloqueId);

    const row = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.pozo.update({
        where: { id },
        data: { ...dto, updatedBy: actor.id },
        include: { campo: { include: { zona: true } }, bloque: true },
      });
      const inactivado = dto.habilitado === false && current.habilitado;
      await this.eventos.publicar(tx, 'pozo', id, inactivado ? 'inactivado' : 'actualizado', actor);
      return updated;
    });
    return toPozo(row);
  }

  async inactivar(id: string, actor: AuthUser): Promise<void> {
    const current = await this.prisma.pozo.findUnique({ where: { id } });
    if (!current) throw new NotFoundException(`Pozo ${id} no existe`);
    if (!current.habilitado) return;
    await this.prisma.$transaction(async (tx) => {
      await tx.pozo.update({ where: { id }, data: { habilitado: false, updatedBy: actor.id } });
      await this.eventos.publicar(tx, 'pozo', id, 'inactivado', actor);
    });
  }

  /** Mensaje claro (400) en vez del error genérico de clave foránea cuando el campo o el bloque no existen. */
  private async assertReferencias(campoId?: string, bloqueId?: string): Promise<void> {
    if (
      campoId &&
      !(await this.prisma.campo.findUnique({ where: { id: campoId }, select: { id: true } }))
    ) {
      throw new BadRequestException('El campo indicado no existe');
    }
    if (
      bloqueId &&
      !(await this.prisma.bloque.findUnique({ where: { id: bloqueId }, select: { id: true } }))
    ) {
      throw new BadRequestException('El bloque indicado no existe');
    }
  }
}
