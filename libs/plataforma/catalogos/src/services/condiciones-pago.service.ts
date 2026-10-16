import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Permission } from '@dyn/authz';
import type { AuthUser } from '@dyn/common';
import { uuidv7 } from '@dyn/utils';
import type {
  CatalogoAs2Response,
  CreateCatalogoAs2Dto,
  UpdateCatalogoAs2Dto,
} from '../dto/catalogos.dto';
import { toCatalogoAs2 } from '../dto/mappers';
import { PrismaService } from '../prisma/prisma.service';
import { CatalogoEventos, exigirInactivar } from './catalogo-eventos.service';

/** Condiciones de pago. El pedido guarda su id y la copia del nombre. */
@Injectable()
export class CondicionesPagoService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventos: CatalogoEventos,
  ) {}

  async findAll(): Promise<CatalogoAs2Response[]> {
    return (await this.prisma.condicionPago.findMany({ orderBy: { nombre: 'asc' } })).map(
      toCatalogoAs2,
    );
  }

  async findOne(id: string): Promise<CatalogoAs2Response> {
    const row = await this.prisma.condicionPago.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(`Condición de pago ${id} no existe`);
    return toCatalogoAs2(row);
  }

  async create(dto: CreateCatalogoAs2Dto, actor: AuthUser): Promise<CatalogoAs2Response> {
    await this.assertNombreLibre(dto.nombre);
    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.condicionPago.create({
        data: {
          id: uuidv7(),
          nombre: dto.nombre.trim(),
          as2Id: dto.as2Id ?? null,
          ...(dto.habilitado !== undefined ? { habilitado: dto.habilitado } : {}),
          createdBy: actor.id,
          updatedBy: actor.id,
        },
      });
      await this.eventos.publicar(tx, 'condicion_pago', created.id, 'creado', actor);
      return created;
    });
    return toCatalogoAs2(row);
  }

  async update(
    id: string,
    dto: UpdateCatalogoAs2Dto,
    actor: AuthUser,
  ): Promise<CatalogoAs2Response> {
    const current = await this.prisma.condicionPago.findUnique({ where: { id } });
    if (!current) throw new NotFoundException(`Condición de pago ${id} no existe`);
    exigirInactivar(actor, Permission.UBICACION_INACTIVAR, current.habilitado, dto.habilitado);
    if (dto.nombre !== undefined) await this.assertNombreLibre(dto.nombre, id);
    const row = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.condicionPago.update({
        where: { id },
        data: {
          ...(dto.nombre !== undefined ? { nombre: dto.nombre.trim() } : {}),
          ...(dto.as2Id !== undefined ? { as2Id: dto.as2Id } : {}),
          ...(dto.habilitado !== undefined ? { habilitado: dto.habilitado } : {}),
          updatedBy: actor.id,
        },
      });
      const inactivado = dto.habilitado === false && current.habilitado;
      await this.eventos.publicar(
        tx,
        'condicion_pago',
        id,
        inactivado ? 'inactivado' : 'actualizado',
        actor,
      );
      return updated;
    });
    return toCatalogoAs2(row);
  }

  async inactivar(id: string, actor: AuthUser): Promise<void> {
    const current = await this.prisma.condicionPago.findUnique({ where: { id } });
    if (!current) throw new NotFoundException(`Condición de pago ${id} no existe`);
    if (!current.habilitado) return;
    await this.prisma.$transaction(async (tx) => {
      await tx.condicionPago.update({
        where: { id },
        data: { habilitado: false, updatedBy: actor.id },
      });
      await this.eventos.publicar(tx, 'condicion_pago', id, 'inactivado', actor);
    });
  }

  /** Sin mayúsculas ni espacios que creen duplicados ("90 dias" y "90 DIAS"). */
  private async assertNombreLibre(nombre: string, exceptoId?: string) {
    const existe = await this.prisma.condicionPago.findFirst({
      where: {
        nombre: { equals: nombre.trim(), mode: 'insensitive' },
        ...(exceptoId ? { id: { not: exceptoId } } : {}),
      },
      select: { id: true },
    });
    if (existe)
      throw new ConflictException(`Ya existe una condición de pago llamada "${nombre.trim()}"`);
  }
}
