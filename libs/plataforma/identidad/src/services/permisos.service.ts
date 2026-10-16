import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { SUPERADMIN_PROTECTED_PERMISSIONS, RoleCode } from '@dyn/authz';
import { currentTraceparent, type AuthUser } from '@dyn/common';
import { EventBus } from '@dyn/messaging';
import { uuidv7 } from '@dyn/utils';
import type {
  CambioPermisosResponse,
  HistorialPermisoResponse,
  PermisoResponse,
} from '../dto/permisos.dto';
import { PrismaService } from '../prisma/prisma.service';

/** Tope de filas que devuelve el historial por consulta. */
const MAX_HISTORIAL = 200;

/**
 * Administración de RBAC: qué permisos tiene cada rol. El catálogo de permisos lo fija el código (cada
 * endpoint exige uno); aquí solo se ASIGNAN y se QUITAN permisos a los roles existentes.
 */
@Injectable()
export class PermisosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: EventBus,
  ) {}

  async catalogo(): Promise<PermisoResponse[]> {
    const permisos = await this.prisma.permiso.findMany({
      orderBy: [{ modulo: 'asc' }, { recurso: 'asc' }, { accion: 'asc' }],
    });
    return permisos.map((p) => ({
      id: p.id,
      codigo: p.codigo,
      modulo: p.modulo,
      recurso: p.recurso,
      accion: p.accion,
      descripcion: p.descripcion,
    }));
  }

  async permisosDeRol(rolId: string): Promise<string[]> {
    await this.rolOrFail(rolId);
    return this.codigosDe(rolId);
  }

  /**
   * Reemplaza el conjunto completo de permisos del rol. Solo escribe la diferencia (otorgados y
   * revocados), deja una fila inmutable por cambio en la bitácora y publica el evento
   * `plataforma.rol.actualizado` en la misma transacción.
   */
  async reemplazar(
    rolId: string,
    solicitados: string[],
    actor: AuthUser,
  ): Promise<CambioPermisosResponse> {
    const rol = await this.rolOrFail(rolId);
    const nuevos = [...new Set(solicitados)];

    const catalogo = await this.prisma.permiso.findMany({ select: { id: true, codigo: true } });
    const idPorCodigo = new Map(catalogo.map((p) => [p.codigo, p.id]));
    const desconocidos = nuevos.filter((c) => !idPorCodigo.has(c));
    if (desconocidos.length) {
      throw new BadRequestException(`Permisos que no existen: ${desconocidos.join(', ')}`);
    }

    // Sin esto el sistema podría quedarse sin nadie que administre usuarios y permisos.
    if (rol.codigo === RoleCode.SUPERADMIN) {
      const faltan = SUPERADMIN_PROTECTED_PERMISSIONS.filter((c) => !nuevos.includes(c));
      if (faltan.length) {
        throw new BadRequestException(
          `No se puede quitar a Superadmin: ${faltan.join(', ')} (dejaría el sistema sin administrador)`,
        );
      }
    }

    return this.prisma.$transaction(async (tx) => {
      const actuales = (
        await tx.rolPermiso.findMany({
          where: { rolId },
          select: { permiso: { select: { codigo: true } } },
        })
      ).map((r) => r.permiso.codigo);

      const otorgados = nuevos.filter((c) => !actuales.includes(c)).sort();
      const revocados = actuales.filter((c) => !nuevos.includes(c)).sort();

      if (otorgados.length || revocados.length) {
        if (revocados.length) {
          await tx.rolPermiso.deleteMany({
            where: { rolId, permiso: { codigo: { in: revocados } } },
          });
        }
        if (otorgados.length) {
          await tx.rolPermiso.createMany({
            data: otorgados.map((c) => ({
              rolId,
              permisoId: idPorCodigo.get(c) as string,
              asignadoPor: actor.id,
            })),
          });
        }
        await tx.rolPermisoHistorial.createMany({
          data: [
            ...otorgados.map((c) => ({
              id: uuidv7(),
              rolId,
              permisoCodigo: c,
              accion: 'otorgado' as const,
              realizadoPor: actor.id,
            })),
            ...revocados.map((c) => ({
              id: uuidv7(),
              rolId,
              permisoCodigo: c,
              accion: 'revocado' as const,
              realizadoPor: actor.id,
            })),
          ],
        });
        await this.bus.publish(
          tx,
          this.bus.create({
            type: 'plataforma.rol.actualizado',
            subject: { type: 'rol', id: rolId },
            data: { rolId, rolCodigo: rol.codigo, otorgados, revocados },
            actor: { userId: actor.id, role: actor.roleCode },
            traceparent: currentTraceparent(),
          }),
        );
      }

      return { roleId: rolId, permisos: [...nuevos].sort(), otorgados, revocados };
    });
  }

  async historial(rolId: string, limite = 50): Promise<HistorialPermisoResponse[]> {
    await this.rolOrFail(rolId);
    const filas = await this.prisma.rolPermisoHistorial.findMany({
      where: { rolId },
      orderBy: [{ realizadoAt: 'desc' }, { id: 'desc' }],
      take: Math.min(Math.max(limite, 1), MAX_HISTORIAL),
      include: { realizador: { select: { id: true, nombre: true } } },
    });
    return filas.map((f) => ({
      id: f.id,
      permiso: f.permisoCodigo,
      accion: f.accion as 'otorgado' | 'revocado',
      realizadoPor: f.realizador ? { id: f.realizador.id, name: f.realizador.nombre } : null,
      realizadoAt: f.realizadoAt.toISOString(),
    }));
  }

  private async rolOrFail(rolId: string) {
    const rol = await this.prisma.rol.findUnique({ where: { id: rolId } });
    if (!rol) throw new NotFoundException(`Rol ${rolId} no existe`);
    return rol;
  }

  private async codigosDe(rolId: string): Promise<string[]> {
    const rows = await this.prisma.rolPermiso.findMany({
      where: { rolId },
      select: { permiso: { select: { codigo: true } } },
    });
    return rows.map((r) => r.permiso.codigo).sort();
  }
}
