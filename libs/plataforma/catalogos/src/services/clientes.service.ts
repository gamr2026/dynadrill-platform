import { Injectable, NotFoundException } from '@nestjs/common';
import { Permission } from '@dyn/authz';
import type { AuthUser } from '@dyn/common';
import { uuidv7 } from '@dyn/utils';
import type { ClienteResponse, CreateClienteDto, UpdateClienteDto } from '../dto/catalogos.dto';
import { toCliente } from '../dto/mappers';
import { PrismaService } from '../prisma/prisma.service';
import { CatalogoEventos, exigirInactivar } from './catalogo-eventos.service';

@Injectable()
export class ClientesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventos: CatalogoEventos,
  ) {}

  async findAll(): Promise<ClienteResponse[]> {
    return (await this.prisma.cliente.findMany({ orderBy: { nombreComercial: 'asc' } })).map(
      toCliente,
    );
  }

  async findOne(id: string): Promise<ClienteResponse> {
    const row = await this.prisma.cliente.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(`Cliente ${id} no existe`);
    return toCliente(row);
  }

  async create(dto: CreateClienteDto, actor: AuthUser): Promise<ClienteResponse> {
    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.cliente.create({
        data: { id: uuidv7(), ...dto, createdBy: actor.id, updatedBy: actor.id },
      });
      await this.eventos.publicar(tx, 'cliente', created.id, 'creado', actor);
      return created;
    });
    return toCliente(row);
  }

  async update(id: string, dto: UpdateClienteDto, actor: AuthUser): Promise<ClienteResponse> {
    const current = await this.prisma.cliente.findUnique({ where: { id } });
    if (!current) throw new NotFoundException(`Cliente ${id} no existe`);
    exigirInactivar(actor, Permission.CLIENTES_INACTIVAR, current.activo, dto.activo);

    const row = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.cliente.update({
        where: { id },
        data: { ...dto, updatedBy: actor.id },
      });
      const inactivado = dto.activo === false && current.activo;
      await this.eventos.publicar(
        tx,
        'cliente',
        id,
        inactivado ? 'inactivado' : 'actualizado',
        actor,
      );
      return updated;
    });
    return toCliente(row);
  }

  async inactivar(id: string, actor: AuthUser): Promise<void> {
    const current = await this.prisma.cliente.findUnique({ where: { id } });
    if (!current) throw new NotFoundException(`Cliente ${id} no existe`);
    if (!current.activo) return;
    await this.prisma.$transaction(async (tx) => {
      await tx.cliente.update({ where: { id }, data: { activo: false, updatedBy: actor.id } });
      await this.eventos.publicar(tx, 'cliente', id, 'inactivado', actor);
    });
  }
}
