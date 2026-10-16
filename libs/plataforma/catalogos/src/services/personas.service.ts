import { Injectable, NotFoundException } from '@nestjs/common';
import { Permission } from '@dyn/authz';
import type { AuthUser } from '@dyn/common';
import { uuidv7 } from '@dyn/utils';
import type {
  CreatePersonaDto,
  PersonaResponse,
  PersonasQueryDto,
  UpdatePersonaDto,
} from '../dto/catalogos.dto';
import { toPersona } from '../dto/mappers';
import { PrismaService } from '../prisma/prisma.service';
import { CatalogoEventos, exigirInactivar } from './catalogo-eventos.service';

@Injectable()
export class PersonasService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventos: CatalogoEventos,
  ) {}

  /** Filtro opcional por `tipo`: alimenta cada select del formulario de Pedido (Company Man, Quito, etc.). */
  async findAll(filtro: PersonasQueryDto = {}): Promise<PersonaResponse[]> {
    const rows = await this.prisma.personaContacto.findMany({
      where: filtro.tipo ? { tipo: filtro.tipo } : undefined,
      orderBy: [{ tipo: 'asc' }, { nombre: 'asc' }],
    });
    return rows.map(toPersona);
  }

  async findOne(id: string): Promise<PersonaResponse> {
    const row = await this.prisma.personaContacto.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(`Persona ${id} no existe`);
    return toPersona(row);
  }

  async create(dto: CreatePersonaDto, actor: AuthUser): Promise<PersonaResponse> {
    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.personaContacto.create({
        data: { id: uuidv7(), ...dto, createdBy: actor.id, updatedBy: actor.id },
      });
      await this.eventos.publicar(tx, 'persona_contacto', created.id, 'creado', actor);
      return created;
    });
    return toPersona(row);
  }

  async update(id: string, dto: UpdatePersonaDto, actor: AuthUser): Promise<PersonaResponse> {
    const current = await this.prisma.personaContacto.findUnique({ where: { id } });
    if (!current) throw new NotFoundException(`Persona ${id} no existe`);
    exigirInactivar(actor, Permission.PERSONAS_INACTIVAR, current.activo, dto.activo);

    const row = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.personaContacto.update({
        where: { id },
        data: { ...dto, updatedBy: actor.id },
      });
      const inactivado = dto.activo === false && current.activo;
      await this.eventos.publicar(
        tx,
        'persona_contacto',
        id,
        inactivado ? 'inactivado' : 'actualizado',
        actor,
      );
      return updated;
    });
    return toPersona(row);
  }

  async inactivar(id: string, actor: AuthUser): Promise<void> {
    const current = await this.prisma.personaContacto.findUnique({ where: { id } });
    if (!current) throw new NotFoundException(`Persona ${id} no existe`);
    if (!current.activo) return;
    await this.prisma.$transaction(async (tx) => {
      await tx.personaContacto.update({
        where: { id },
        data: { activo: false, updatedBy: actor.id },
      });
      await this.eventos.publicar(tx, 'persona_contacto', id, 'inactivado', actor);
    });
  }
}
