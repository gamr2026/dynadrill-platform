import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Permission } from '@dyn/authz';
import { currentTraceparent, type AuthUser } from '@dyn/common';
import { EventBus } from '@dyn/messaging';
import { uuidv7 } from '@dyn/utils';
import { toUserResponse } from '../dto/mappers';
import type { CreateUserDto, UpdateUserDto, UserResponse } from '../dto/user.dto';
import { Prisma } from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';
import { PasswordService } from './password.service';

/** Campos de RRHH: los mismos en el alta y en la edición. */
const RRHH_KEYS = [
  'cedula',
  'tipoIdentificacion',
  'nacionalidad',
  'apellidos',
  'nombres',
  'cargo',
  'departamento',
  'area',
  'tipoContrato',
  'sucursal',
  'tipoDiscapacidad',
  'cargasActivas',
  'categoria',
  'centroCosto',
  'empleadoActivo',
] as const;
type PerfilInput = Pick<
  UpdateUserDto,
  (typeof RRHH_KEYS)[number] | 'causaSalidaEmpleado' | 'fechaIngreso' | 'fechaSalida'
>;
type PerfilColumns = Omit<Prisma.UsuarioPerfilUncheckedCreateWithoutUsuarioInput, 'id'>;
type Cambio = 'creado' | 'actualizado' | 'desactivado';

const toDate = (v: string | null | undefined) => (v ? new Date(v) : null);

/** Campos de RRHH del DTO → columnas de `usuario_perfil`. Solo incluye los que vinieron. */
function perfilData(dto: PerfilInput): PerfilColumns {
  const data: PerfilColumns = {};
  for (const key of RRHH_KEYS)
    if (dto[key] !== undefined) (data as Record<string, unknown>)[key] = dto[key];
  if (dto.causaSalidaEmpleado !== undefined) data.causaSalida = dto.causaSalidaEmpleado;
  if (dto.fechaIngreso !== undefined) data.fechaIngreso = toDate(dto.fechaIngreso);
  if (dto.fechaSalida !== undefined) data.fechaSalida = toDate(dto.fechaSalida);
  return data;
}

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly bus: EventBus,
  ) {}

  async findAll(): Promise<UserResponse[]> {
    const users = await this.prisma.usuario.findMany({
      include: { perfil: true },
      orderBy: [{ nombre: 'asc' }, { id: 'asc' }],
    });
    return users.map(toUserResponse);
  }

  async findOne(id: string): Promise<UserResponse> {
    const user = await this.prisma.usuario.findUnique({
      where: { id },
      include: { perfil: true },
    });
    if (!user) throw new NotFoundException(`Usuario ${id} no existe`);
    return toUserResponse(user);
  }

  async create(dto: CreateUserDto, actor: AuthUser): Promise<UserResponse> {
    const email = dto.email.trim().toLowerCase();
    await this.assertRolExists(dto.roleId);
    await this.assertUnique(email, dto.username);

    const id = uuidv7();
    const passwordHash = await this.passwords.hash(dto.password);
    const rrhh = perfilData(dto);

    const created = await this.prisma.$transaction(async (tx) => {
      const user = await tx.usuario.create({
        data: {
          id,
          email,
          username: dto.username,
          nombre: dto.name,
          telefono: dto.phone ?? null,
          passwordHash,
          debeCambiarClave: dto.forceChangePassword ?? false,
          rolId: dto.roleId,
          activo: dto.status,
          ...(dto.tipoVinculo ? { tipoVinculo: dto.tipoVinculo } : {}),
          especialidad: dto.specialty ?? null,
          createdBy: actor.id,
          updatedBy: actor.id,
          ...(Object.keys(rrhh).length ? { perfil: { create: { id: uuidv7(), ...rrhh } } } : {}),
        },
        include: { perfil: true, rol: true },
      });
      await this.publish(tx, 'creado', user, actor);
      return user;
    });
    return toUserResponse(created);
  }

  async update(id: string, dto: UpdateUserDto, actor: AuthUser): Promise<UserResponse> {
    const current = await this.prisma.usuario.findUnique({ where: { id } });
    if (!current) throw new NotFoundException(`Usuario ${id} no existe`);

    // Editar no puede servir para saltarse "inactivar": poner `status: false` a una cuenta activa ES inactivarla.
    if (
      dto.status === false &&
      current.activo &&
      !actor.permissions.includes(Permission.USUARIOS_INACTIVAR)
    ) {
      throw new ForbiddenException(
        `Para inactivar una cuenta se necesita el permiso ${Permission.USUARIOS_INACTIVAR}`,
      );
    }

    const email = dto.email?.trim().toLowerCase();
    if (dto.roleId) await this.assertRolExists(dto.roleId);
    if (email !== undefined || dto.username !== undefined) {
      await this.assertUnique(email ?? current.email, dto.username ?? current.username, id);
    }

    const rrhh = perfilData(dto);
    const passwordHash = dto.password ? await this.passwords.hash(dto.password) : undefined;
    // Estos cambios invalidan las sesiones abiertas: rol distinto, cuenta desactivada o clave nueva.
    const revokeSessions =
      (dto.roleId !== undefined && dto.roleId !== current.rolId) ||
      dto.status === false ||
      passwordHash !== undefined;

    const updated = await this.prisma.$transaction(async (tx) => {
      const user = await tx.usuario.update({
        where: { id },
        data: {
          ...(email !== undefined ? { email } : {}),
          ...(dto.username !== undefined ? { username: dto.username } : {}),
          ...(dto.name !== undefined ? { nombre: dto.name } : {}),
          ...(dto.phone !== undefined ? { telefono: dto.phone } : {}),
          ...(dto.roleId !== undefined ? { rolId: dto.roleId } : {}),
          ...(dto.status !== undefined ? { activo: dto.status } : {}),
          ...(dto.tipoVinculo !== undefined ? { tipoVinculo: dto.tipoVinculo } : {}),
          ...(dto.specialty !== undefined ? { especialidad: dto.specialty } : {}),
          ...(passwordHash
            ? {
                passwordHash,
                intentosFallidos: 0,
                bloqueadoHasta: null,
                // una clave fijada por un administrador es provisional solo si se indica
                debeCambiarClave: dto.forceChangePassword ?? false,
              }
            : {}),
          updatedBy: actor.id,
          ...(Object.keys(rrhh).length
            ? {
                perfil: {
                  upsert: {
                    create: { id: uuidv7(), ...rrhh },
                    update: rrhh,
                  },
                },
              }
            : {}),
        },
        include: { perfil: true, rol: true },
      });
      if (revokeSessions) {
        await tx.sesion.updateMany({
          where: { usuarioId: id, revocadoAt: null },
          data: { revocadoAt: new Date() },
        });
      }
      await this.publish(tx, dto.status === false ? 'desactivado' : 'actualizado', user, actor);
      return user;
    });
    return toUserResponse(updated);
  }

  /**
   * "Borrar" un usuario lo desactiva y cierra sus sesiones. Los datos no se eliminan (la base no
   * concede DELETE a la aplicación): otros módulos conservan referencias a su id.
   */
  async remove(id: string, actor: AuthUser): Promise<void> {
    const current = await this.prisma.usuario.findUnique({ where: { id } });
    if (!current) throw new NotFoundException(`Usuario ${id} no existe`);
    if (id === actor.id) throw new BadRequestException('No puede desactivar su propia cuenta');

    await this.prisma.$transaction(async (tx) => {
      const user = await tx.usuario.update({
        where: { id },
        data: { activo: false, updatedBy: actor.id },
        include: { rol: true },
      });
      await tx.sesion.updateMany({
        where: { usuarioId: id, revocadoAt: null },
        data: { revocadoAt: new Date() },
      });
      await this.publish(tx, 'desactivado', user, actor);
    });
  }

  private async assertRolExists(roleId: string): Promise<void> {
    const rol = await this.prisma.rol.findUnique({ where: { id: roleId }, select: { id: true } });
    if (!rol) throw new BadRequestException('El rol indicado no existe');
  }

  private async assertUnique(email: string, username: string, excludeId?: string): Promise<void> {
    const clash = await this.prisma.usuario.findFirst({
      where: { OR: [{ email }, { username }], ...(excludeId ? { NOT: { id: excludeId } } : {}) },
      select: { email: true },
    });
    if (clash) {
      throw new ConflictException(
        clash.email === email
          ? 'Ya existe un usuario con ese email'
          : 'Ya existe un usuario con ese username',
      );
    }
  }

  /** Evento `plataforma.usuario.actualizado.v1` en el outbox, dentro de la misma transacción. */
  private async publish(
    tx: Prisma.TransactionClient,
    cambio: Cambio,
    user: { id: string; activo: boolean; rol?: { codigo: string } },
    actor: AuthUser,
  ): Promise<void> {
    const event = this.bus.create({
      type: 'plataforma.usuario.actualizado',
      subject: { type: 'usuario', id: user.id },
      data: { usuarioId: user.id, cambio, activo: user.activo, rolCodigo: user.rol?.codigo },
      actor: { userId: actor.id, role: actor.roleCode },
      traceparent: currentTraceparent(),
    });
    await this.bus.publish(tx, event);
  }
}
