import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Permission } from '@dyn/authz';
import type { AuthUser } from '@dyn/common';
import { uuidv7 } from '@dyn/utils';
import {
  CreateChoferDto,
  CreateTipoVehiculoDto,
  CreateTransportistaDto,
  CreateVehiculoDto,
  UpdateChoferDto,
  UpdateTipoVehiculoDto,
  UpdateTransportistaDto,
  UpdateVehiculoDto,
} from '../dto/transporte.dto';
import type { Chofer, TipoVehiculo, Transportista, Vehiculo } from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';
import { CatalogoEventos, exigirInactivar } from './catalogo-eventos.service';

const aTransportista = (t: Transportista) => ({
  id: t.id,
  codigo: t.codigo,
  nombreFiscal: t.nombreFiscal,
  tipoIdentificacion: t.tipoIdentificacion,
  identificacion: t.identificacion,
  habilitado: t.habilitado,
});
const aTipoVehiculo = (t: TipoVehiculo) => ({
  id: t.id,
  nombre: t.nombre,
  habilitado: t.habilitado,
});
const aVehiculo = (
  v: Vehiculo & { tipoVehiculo: TipoVehiculo | null; transportista: Transportista | null },
) => ({
  id: v.id,
  placa: v.placa,
  marca: v.marca,
  modelo: v.modelo,
  anio: v.anio,
  tipoVehiculo: v.tipoVehiculo ? { id: v.tipoVehiculo.id, nombre: v.tipoVehiculo.nombre } : null,
  transportista: v.transportista
    ? { id: v.transportista.id, nombreFiscal: v.transportista.nombreFiscal }
    : null,
  habilitado: v.habilitado,
});
const aChofer = (c: Chofer) => ({
  id: c.id,
  transportistaId: c.transportistaId,
  licencia: c.licencia,
  nombre: c.nombre,
  habilitado: c.habilitado,
});

/** Placa en mayúsculas y sin espacios ni guiones (el cuerpo llega sin transformar: se normaliza aquí). */
const normalizarPlaca = (p: string) => p.toUpperCase().replace(/[\s-]/g, '');

const REL_VEHICULO = { tipoVehiculo: true, transportista: true } as const;

/**
 * Catálogos del transporte de la guía de remisión: transportista, tipo de vehículo, vehículo y chofer. Como en AS2,
 * son cuatro catálogos distintos: el chofer pertenece a un transportista y el vehículo a un responsable.
 */
@Injectable()
export class TransporteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventos: CatalogoEventos,
  ) {}

  // ------------------------------------------------------------------------------------------- transportistas

  async transportistas() {
    return (await this.prisma.transportista.findMany({ orderBy: { nombreFiscal: 'asc' } })).map(
      aTransportista,
    );
  }

  async transportista(id: string) {
    const t = await this.prisma.transportista.findUnique({ where: { id } });
    if (!t) throw new NotFoundException(`Transportista ${id} no existe`);
    return aTransportista(t);
  }

  async crearTransportista(dto: CreateTransportistaDto, actor: AuthUser) {
    await this.unico(
      this.prisma.transportista.findUnique({
        where: { identificacion: dto.identificacion.trim() },
      }),
      'Ya existe un transportista con esa identificación',
    );
    if (dto.codigo) {
      await this.unico(
        this.prisma.transportista.findUnique({ where: { codigo: dto.codigo.trim() } }),
        'Ya existe un transportista con ese código',
      );
    }
    const t = await this.prisma.$transaction(async (tx) => {
      const c = await tx.transportista.create({
        data: {
          id: uuidv7(),
          nombreFiscal: dto.nombreFiscal.trim(),
          tipoIdentificacion: dto.tipoIdentificacion,
          identificacion: dto.identificacion.trim(),
          codigo: dto.codigo?.trim() || null,
          ...(dto.habilitado !== undefined ? { habilitado: dto.habilitado } : {}),
          createdBy: actor.id,
          updatedBy: actor.id,
        },
      });
      await this.eventos.publicar(tx, 'transportista', c.id, 'creado', actor);
      return c;
    });
    return aTransportista(t);
  }

  async actualizarTransportista(id: string, dto: UpdateTransportistaDto, actor: AuthUser) {
    const actual = await this.prisma.transportista.findUnique({ where: { id } });
    if (!actual) throw new NotFoundException(`Transportista ${id} no existe`);
    exigirInactivar(actor, Permission.TRANSPORTE_INACTIVAR, actual.habilitado, dto.habilitado);
    if (dto.identificacion && dto.identificacion.trim() !== actual.identificacion) {
      await this.unico(
        this.prisma.transportista.findUnique({
          where: { identificacion: dto.identificacion.trim() },
        }),
        'Ya existe un transportista con esa identificación',
      );
    }
    const t = await this.prisma.$transaction(async (tx) => {
      const u = await tx.transportista.update({
        where: { id },
        data: {
          ...(dto.nombreFiscal !== undefined ? { nombreFiscal: dto.nombreFiscal.trim() } : {}),
          ...(dto.tipoIdentificacion !== undefined
            ? { tipoIdentificacion: dto.tipoIdentificacion }
            : {}),
          ...(dto.identificacion !== undefined
            ? { identificacion: dto.identificacion.trim() }
            : {}),
          ...(dto.codigo !== undefined ? { codigo: dto.codigo.trim() || null } : {}),
          ...(dto.habilitado !== undefined ? { habilitado: dto.habilitado } : {}),
          updatedBy: actor.id,
        },
      });
      await this.eventos.publicar(
        tx,
        'transportista',
        id,
        dto.habilitado === false && actual.habilitado ? 'inactivado' : 'actualizado',
        actor,
      );
      return u;
    });
    return aTransportista(t);
  }

  async inactivarTransportista(id: string, actor: AuthUser) {
    await this.inactivar('transportista', id, actor);
  }

  // ---------------------------------------------------------------------------------------------- tipos de vehículo

  async tiposVehiculo() {
    return (await this.prisma.tipoVehiculo.findMany({ orderBy: { nombre: 'asc' } })).map(
      aTipoVehiculo,
    );
  }

  async crearTipoVehiculo(dto: CreateTipoVehiculoDto, actor: AuthUser) {
    await this.nombreLibre('tipoVehiculo', dto.nombre);
    const t = await this.prisma.$transaction(async (tx) => {
      const c = await tx.tipoVehiculo.create({
        data: {
          id: uuidv7(),
          nombre: dto.nombre.trim(),
          ...(dto.habilitado !== undefined ? { habilitado: dto.habilitado } : {}),
          createdBy: actor.id,
          updatedBy: actor.id,
        },
      });
      await this.eventos.publicar(tx, 'tipo_vehiculo', c.id, 'creado', actor);
      return c;
    });
    return aTipoVehiculo(t);
  }

  async actualizarTipoVehiculo(id: string, dto: UpdateTipoVehiculoDto, actor: AuthUser) {
    const actual = await this.prisma.tipoVehiculo.findUnique({ where: { id } });
    if (!actual) throw new NotFoundException(`Tipo de vehículo ${id} no existe`);
    exigirInactivar(actor, Permission.TRANSPORTE_INACTIVAR, actual.habilitado, dto.habilitado);
    if (dto.nombre) await this.nombreLibre('tipoVehiculo', dto.nombre, id);
    const t = await this.prisma.$transaction(async (tx) => {
      const u = await tx.tipoVehiculo.update({
        where: { id },
        data: {
          ...(dto.nombre !== undefined ? { nombre: dto.nombre.trim() } : {}),
          ...(dto.habilitado !== undefined ? { habilitado: dto.habilitado } : {}),
          updatedBy: actor.id,
        },
      });
      await this.eventos.publicar(
        tx,
        'tipo_vehiculo',
        id,
        dto.habilitado === false && actual.habilitado ? 'inactivado' : 'actualizado',
        actor,
      );
      return u;
    });
    return aTipoVehiculo(t);
  }

  // ----------------------------------------------------------------------------------------------------- vehículos

  async vehiculos(transportistaId?: string) {
    const v = await this.prisma.vehiculo.findMany({
      where: transportistaId ? { transportistaId } : {},
      orderBy: { placa: 'asc' },
      include: REL_VEHICULO,
    });
    return v.map(aVehiculo);
  }

  async vehiculo(id: string) {
    const v = await this.prisma.vehiculo.findUnique({ where: { id }, include: REL_VEHICULO });
    if (!v) throw new NotFoundException(`Vehículo ${id} no existe`);
    return aVehiculo(v);
  }

  async crearVehiculo(dto: CreateVehiculoDto, actor: AuthUser) {
    const placa = normalizarPlaca(dto.placa);
    await this.unico(
      this.prisma.vehiculo.findUnique({ where: { placa } }),
      `Ya existe un vehículo con la placa ${placa}`,
    );
    await this.referenciasVehiculo(dto);
    const v = await this.prisma.$transaction(async (tx) => {
      const c = await tx.vehiculo.create({
        data: {
          id: uuidv7(),
          placa,
          marca: dto.marca?.trim() || null,
          modelo: dto.modelo?.trim() || null,
          anio: dto.anio ?? null,
          tipoVehiculoId: dto.tipoVehiculoId ?? null,
          transportistaId: dto.transportistaId ?? null,
          ...(dto.habilitado !== undefined ? { habilitado: dto.habilitado } : {}),
          createdBy: actor.id,
          updatedBy: actor.id,
        },
        include: REL_VEHICULO,
      });
      await this.eventos.publicar(tx, 'vehiculo', c.id, 'creado', actor);
      return c;
    });
    return aVehiculo(v);
  }

  async actualizarVehiculo(id: string, dto: UpdateVehiculoDto, actor: AuthUser) {
    const actual = await this.prisma.vehiculo.findUnique({ where: { id } });
    if (!actual) throw new NotFoundException(`Vehículo ${id} no existe`);
    exigirInactivar(actor, Permission.TRANSPORTE_INACTIVAR, actual.habilitado, dto.habilitado);
    const placaNueva = dto.placa ? normalizarPlaca(dto.placa) : undefined;
    if (placaNueva && placaNueva !== actual.placa) {
      await this.unico(
        this.prisma.vehiculo.findUnique({ where: { placa: placaNueva } }),
        `Ya existe un vehículo con la placa ${placaNueva}`,
      );
    }
    await this.referenciasVehiculo(dto);
    const v = await this.prisma.$transaction(async (tx) => {
      const u = await tx.vehiculo.update({
        where: { id },
        data: {
          ...(placaNueva !== undefined ? { placa: placaNueva } : {}),
          ...(dto.marca !== undefined ? { marca: dto.marca.trim() || null } : {}),
          ...(dto.modelo !== undefined ? { modelo: dto.modelo.trim() || null } : {}),
          ...(dto.anio !== undefined ? { anio: dto.anio } : {}),
          ...(dto.tipoVehiculoId !== undefined ? { tipoVehiculoId: dto.tipoVehiculoId } : {}),
          ...(dto.transportistaId !== undefined ? { transportistaId: dto.transportistaId } : {}),
          ...(dto.habilitado !== undefined ? { habilitado: dto.habilitado } : {}),
          updatedBy: actor.id,
        },
        include: REL_VEHICULO,
      });
      await this.eventos.publicar(
        tx,
        'vehiculo',
        id,
        dto.habilitado === false && actual.habilitado ? 'inactivado' : 'actualizado',
        actor,
      );
      return u;
    });
    return aVehiculo(v);
  }

  // ------------------------------------------------------------------------------------------------------ choferes

  async choferes(transportistaId?: string) {
    return (
      await this.prisma.chofer.findMany({
        where: transportistaId ? { transportistaId } : {},
        orderBy: { nombre: 'asc' },
      })
    ).map(aChofer);
  }

  async chofer(id: string) {
    const c = await this.prisma.chofer.findUnique({ where: { id } });
    if (!c) throw new NotFoundException(`Chofer ${id} no existe`);
    return aChofer(c);
  }

  async crearChofer(dto: CreateChoferDto, actor: AuthUser) {
    await this.existeTransportista(dto.transportistaId);
    await this.unico(
      this.prisma.chofer.findUnique({
        where: {
          transportistaId_licencia: {
            transportistaId: dto.transportistaId,
            licencia: dto.licencia.trim(),
          },
        },
      }),
      'Ya existe un chofer con esa licencia para ese transportista',
    );
    const c = await this.prisma.$transaction(async (tx) => {
      const n = await tx.chofer.create({
        data: {
          id: uuidv7(),
          transportistaId: dto.transportistaId,
          licencia: dto.licencia.trim(),
          nombre: dto.nombre.trim(),
          ...(dto.habilitado !== undefined ? { habilitado: dto.habilitado } : {}),
          createdBy: actor.id,
          updatedBy: actor.id,
        },
      });
      await this.eventos.publicar(tx, 'chofer', n.id, 'creado', actor);
      return n;
    });
    return aChofer(c);
  }

  async actualizarChofer(id: string, dto: UpdateChoferDto, actor: AuthUser) {
    const actual = await this.prisma.chofer.findUnique({ where: { id } });
    if (!actual) throw new NotFoundException(`Chofer ${id} no existe`);
    exigirInactivar(actor, Permission.TRANSPORTE_INACTIVAR, actual.habilitado, dto.habilitado);
    if (dto.transportistaId) await this.existeTransportista(dto.transportistaId);
    const c = await this.prisma.$transaction(async (tx) => {
      const u = await tx.chofer.update({
        where: { id },
        data: {
          ...(dto.transportistaId !== undefined ? { transportistaId: dto.transportistaId } : {}),
          ...(dto.licencia !== undefined ? { licencia: dto.licencia.trim() } : {}),
          ...(dto.nombre !== undefined ? { nombre: dto.nombre.trim() } : {}),
          ...(dto.habilitado !== undefined ? { habilitado: dto.habilitado } : {}),
          updatedBy: actor.id,
        },
      });
      await this.eventos.publicar(
        tx,
        'chofer',
        id,
        dto.habilitado === false && actual.habilitado ? 'inactivado' : 'actualizado',
        actor,
      );
      return u;
    });
    return aChofer(c);
  }

  /** Inactiva (no se borra: las guías ya emitidas lo referencian). */
  async inactivar(
    tipo: 'transportista' | 'tipoVehiculo' | 'vehiculo' | 'chofer',
    id: string,
    actor: AuthUser,
  ) {
    const modelo = this.prisma[tipo] as unknown as {
      findUnique: (a: { where: { id: string } }) => Promise<{ habilitado: boolean } | null>;
      update: (a: { where: { id: string }; data: Record<string, unknown> }) => Promise<unknown>;
    };
    const actual = await modelo.findUnique({ where: { id } });
    if (!actual) throw new NotFoundException('El registro no existe');
    if (!actual.habilitado) return;
    const evento = {
      transportista: 'transportista',
      tipoVehiculo: 'tipo_vehiculo',
      vehiculo: 'vehiculo',
      chofer: 'chofer',
    } as const;
    await this.prisma.$transaction(async (tx) => {
      const m = tx[tipo] as unknown as {
        update: (a: { where: { id: string }; data: Record<string, unknown> }) => Promise<unknown>;
      };
      await m.update({ where: { id }, data: { habilitado: false, updatedBy: actor.id } });
      await this.eventos.publicar(tx, evento[tipo], id, 'inactivado', actor);
    });
  }

  // -------------------------------------------------------------------------------------------------------- reglas

  private async unico(busqueda: Promise<unknown>, mensaje: string) {
    if (await busqueda) throw new ConflictException(mensaje);
  }

  private async nombreLibre(modelo: 'tipoVehiculo', nombre: string, exceptoId?: string) {
    const existe = await this.prisma[modelo].findFirst({
      where: {
        nombre: { equals: nombre.trim(), mode: 'insensitive' },
        ...(exceptoId ? { id: { not: exceptoId } } : {}),
      },
      select: { id: true },
    });
    if (existe)
      throw new ConflictException(`Ya existe un tipo de vehículo llamado "${nombre.trim()}"`);
  }

  private async existeTransportista(id: string) {
    const t = await this.prisma.transportista.findUnique({ where: { id }, select: { id: true } });
    if (!t) throw new BadRequestException('El transportista indicado no existe');
  }

  private async referenciasVehiculo(dto: {
    tipoVehiculoId?: string | null;
    transportistaId?: string | null;
  }) {
    if (dto.tipoVehiculoId) {
      const t = await this.prisma.tipoVehiculo.findUnique({
        where: { id: dto.tipoVehiculoId },
        select: { id: true },
      });
      if (!t) throw new BadRequestException('El tipo de vehículo indicado no existe');
    }
    if (dto.transportistaId) await this.existeTransportista(dto.transportistaId);
  }
}
