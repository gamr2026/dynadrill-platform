import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Permission } from '@dyn/authz';
import type { AuthUser } from '@dyn/common';
import { uuidv7 } from '@dyn/utils';
import { PrismaService } from '../prisma/prisma.service';
import { CatalogoEventos, exigirInactivar } from './catalogo-eventos.service';

export interface UnidadMedidaEntrada {
  nombre: string;
  simbolo: string;
  habilitado?: boolean;
}

export interface UnidadMedidaResponse {
  id: string;
  nombre: string;
  simbolo: string;
  habilitado: boolean;
}

const vista = (u: UnidadMedidaResponse): UnidadMedidaResponse => ({
  id: u.id,
  nombre: u.nombre,
  simbolo: u.simbolo,
  habilitado: u.habilitado,
});

/**
 * Unidades de medida compartidas (IN9). Hoy las usa Inventario; las listas de precios y AS2 las traen como texto y se enlazan cuando Asinfo
 * confirme la equivalencia. No se borran (otros módulos las referencian con FK): se inhabilitan.
 */
@Injectable()
export class UnidadesMedidaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventos: CatalogoEventos,
  ) {}

  async findAll(): Promise<UnidadMedidaResponse[]> {
    return (await this.prisma.unidadMedida.findMany({ orderBy: { nombre: 'asc' } })).map(vista);
  }

  async findOne(id: string): Promise<UnidadMedidaResponse> {
    const u = await this.prisma.unidadMedida.findUnique({ where: { id } });
    if (!u) throw new NotFoundException(`Unidad de medida ${id} no existe`);
    return vista(u);
  }

  async create(dto: UnidadMedidaEntrada, actor: AuthUser): Promise<UnidadMedidaResponse> {
    await this.exigirNombreLibre(dto.nombre);
    const u = await this.prisma.$transaction(async (tx) => {
      const creada = await tx.unidadMedida.create({
        data: {
          id: uuidv7(),
          nombre: dto.nombre.trim(),
          simbolo: dto.simbolo.trim(),
          ...(dto.habilitado !== undefined ? { habilitado: dto.habilitado } : {}),
          createdBy: actor.id,
          updatedBy: actor.id,
        },
      });
      await this.eventos.publicar(tx, 'unidad_medida', creada.id, 'creado', actor);
      return creada;
    });
    return vista(u);
  }

  async update(
    id: string,
    dto: Partial<UnidadMedidaEntrada>,
    actor: AuthUser,
  ): Promise<UnidadMedidaResponse> {
    const actual = await this.prisma.unidadMedida.findUnique({ where: { id } });
    if (!actual) throw new NotFoundException(`Unidad de medida ${id} no existe`);
    exigirInactivar(actor, Permission.UNIDADES_MEDIDA_INACTIVAR, actual.habilitado, dto.habilitado);
    if (dto.nombre !== undefined) await this.exigirNombreLibre(dto.nombre, id);
    const u = await this.prisma.$transaction(async (tx) => {
      const nueva = await tx.unidadMedida.update({
        where: { id },
        data: {
          ...(dto.nombre !== undefined ? { nombre: dto.nombre.trim() } : {}),
          ...(dto.simbolo !== undefined ? { simbolo: dto.simbolo.trim() } : {}),
          ...(dto.habilitado !== undefined ? { habilitado: dto.habilitado } : {}),
          updatedBy: actor.id,
        },
      });
      const inactivada = dto.habilitado === false && actual.habilitado;
      await this.eventos.publicar(
        tx,
        'unidad_medida',
        id,
        inactivada ? 'inactivado' : 'actualizado',
        actor,
      );
      return nueva;
    });
    return vista(u);
  }

  async inactivar(id: string, actor: AuthUser): Promise<void> {
    const actual = await this.prisma.unidadMedida.findUnique({ where: { id } });
    if (!actual) throw new NotFoundException(`Unidad de medida ${id} no existe`);
    if (!actual.habilitado) return;
    await this.prisma.$transaction(async (tx) => {
      await tx.unidadMedida.update({
        where: { id },
        data: { habilitado: false, updatedBy: actor.id },
      });
      await this.eventos.publicar(tx, 'unidad_medida', id, 'inactivado', actor);
    });
  }

  /** Sin diferencias de mayúsculas ni espacios que creen duplicados («Litro» y «litro »). */
  private async exigirNombreLibre(nombre: string, exceptoId?: string): Promise<void> {
    const existe = await this.prisma.unidadMedida.findFirst({
      where: {
        nombre: { equals: nombre.trim(), mode: 'insensitive' },
        ...(exceptoId ? { id: { not: exceptoId } } : {}),
      },
      select: { id: true },
    });
    if (existe) {
      throw new ConflictException(`Ya existe una unidad de medida llamada "${nombre.trim()}"`);
    }
  }
}
