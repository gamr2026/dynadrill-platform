import { PERMISSION_CATALOG, PERMISSION_REPLACEMENTS, type PermissionDef } from '@dyn/authz';
import { uuidv7 } from '@dyn/utils';
import type { PrismaClient } from '../generated/client';

export interface SyncReport {
  /** Permisos creados en esta corrida. */
  nuevos: number;
  /** Asignaciones por defecto otorgadas a esos permisos nuevos. */
  asignacionesPorDefecto: number;
  /** Asignaciones traspasadas desde permisos retirados a sus reemplazos. */
  traspasadas: number;
  /** Permisos retirados del catálogo (eliminados). */
  retirados: number;
}

export interface SyncOptions {
  catalog?: readonly PermissionDef[];
  replacements?: ReadonlyArray<{ retired: string; replacedBy: readonly string[] }>;
}

/**
 * Pone la base al día con el catálogo del código, sin pisar lo que un administrador haya editado:
 *
 * 1. Crea los permisos que faltan. Solo a los NUEVOS les asigna los roles por defecto; volver a correrlo
 *    jamás revierte una asignación editada desde la app.
 * 2. Traspasa los permisos retirados: todo rol que tenía el viejo recibe los que lo reemplazan (aunque se lo
 *    hubieran dado a mano) y deja constancia en el historial; luego el viejo se elimina. Un cambio de
 *    catálogo nunca le quita acceso a nadie por sorpresa.
 *
 * Es idempotente: una segunda corrida no cambia nada.
 */
export async function syncPermisos(
  prisma: PrismaClient,
  options: SyncOptions = {},
): Promise<SyncReport> {
  const catalog = options.catalog ?? PERMISSION_CATALOG;
  const replacements = options.replacements ?? PERMISSION_REPLACEMENTS;
  const report: SyncReport = { nuevos: 0, asignacionesPorDefecto: 0, traspasadas: 0, retirados: 0 };

  const rolPorCodigo = new Map((await prisma.rol.findMany()).map((r) => [r.codigo, r.id]));

  // 1) catálogo
  for (const p of catalog) {
    const existente = await prisma.permiso.findUnique({ where: { codigo: p.code } });
    if (existente) {
      await prisma.permiso.update({
        where: { id: existente.id },
        data: {
          modulo: p.modulo,
          recurso: p.recurso,
          accion: p.accion,
          descripcion: p.descripcion,
        },
      });
      continue;
    }
    const permisoId = uuidv7();
    const rolIds = p.defaultRoles
      .map((c) => rolPorCodigo.get(c))
      .filter((id): id is string => !!id);
    await prisma.$transaction([
      prisma.permiso.create({
        data: {
          id: permisoId,
          codigo: p.code,
          modulo: p.modulo,
          recurso: p.recurso,
          accion: p.accion,
          descripcion: p.descripcion,
        },
      }),
      prisma.rolPermiso.createMany({ data: rolIds.map((rolId) => ({ rolId, permisoId })) }),
      prisma.rolPermisoHistorial.createMany({
        data: rolIds.map((rolId) => ({
          id: uuidv7(),
          rolId,
          permisoCodigo: p.code,
          accion: 'otorgado',
        })),
      }),
    ]);
    report.nuevos += 1;
    report.asignacionesPorDefecto += rolIds.length;
  }

  // 2) permisos retirados → traspaso a sus reemplazos
  for (const { retired, replacedBy } of replacements) {
    const viejo = await prisma.permiso.findUnique({ where: { codigo: retired } });
    if (!viejo) continue;

    const nuevos = await prisma.permiso.findMany({ where: { codigo: { in: [...replacedBy] } } });
    const faltantes = replacedBy.filter((c) => !nuevos.some((n) => n.codigo === c));
    if (faltantes.length) {
      throw new Error(
        `El permiso retirado "${retired}" se reemplaza por códigos que no existen en el catálogo: ${faltantes.join(', ')}`,
      );
    }

    const rolesConViejo = (
      await prisma.rolPermiso.findMany({ where: { permisoId: viejo.id }, select: { rolId: true } })
    ).map((r) => r.rolId);

    await prisma.$transaction(async (tx) => {
      for (const nuevo of nuevos) {
        const yaTienen = new Set(
          (
            await tx.rolPermiso.findMany({
              where: { permisoId: nuevo.id, rolId: { in: rolesConViejo } },
              select: { rolId: true },
            })
          ).map((r) => r.rolId),
        );
        const aOtorgar = rolesConViejo.filter((id) => !yaTienen.has(id));
        if (!aOtorgar.length) continue;
        await tx.rolPermiso.createMany({
          data: aOtorgar.map((rolId) => ({ rolId, permisoId: nuevo.id })),
        });
        await tx.rolPermisoHistorial.createMany({
          data: aOtorgar.map((rolId) => ({
            id: uuidv7(),
            rolId,
            permisoCodigo: nuevo.codigo,
            accion: 'otorgado',
          })),
        });
        report.traspasadas += aOtorgar.length;
      }
      await tx.rolPermisoHistorial.createMany({
        data: rolesConViejo.map((rolId) => ({
          id: uuidv7(),
          rolId,
          permisoCodigo: retired,
          accion: 'revocado',
        })),
      });
      await tx.rolPermiso.deleteMany({ where: { permisoId: viejo.id } });
      await tx.permiso.delete({ where: { id: viejo.id } });
    });
    report.retirados += 1;
  }

  return report;
}
