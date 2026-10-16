/**
 * Ayuda de las pruebas de integración: las FK a `identidad` exigen que los ids existan de verdad. Esto inserta (con
 * dyn_migrator) las cuentas mínimas que usa cada prueba, con su perfil de empleado si se indica, y las quita al final. Solo para pruebas.
 */
import type { Pool } from 'pg';

export interface MaestrosDePrueba {
  usuarios?: Array<{
    id: string;
    nombre: string;
    rol: string;
    activo?: boolean;
    cedula?: string;
    cargo?: string;
  }>;
}

/** Inserta los maestros (si un id ya existe, no lo toca). */
export async function sembrarMaestros(admin: Pool, m: MaestrosDePrueba): Promise<void> {
  const roles = new Map<string, string>(
    (await admin.query('SELECT id, codigo FROM identidad.rol')).rows.map(
      (r: { id: string; codigo: string }) => [r.codigo, r.id],
    ),
  );
  for (const u of m.usuarios ?? []) {
    const rolId = roles.get(u.rol);
    if (!rolId) throw new Error(`El rol ${u.rol} no existe en identidad.rol`);
    await admin.query(
      `INSERT INTO identidad.usuario (id, email, username, nombre, rol_id, activo)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING`,
      [u.id, `${u.id}@test.local`, u.id, u.nombre, rolId, u.activo ?? true],
    );
    if (u.cedula || u.cargo) {
      await admin.query(
        `INSERT INTO identidad.usuario_perfil (id, usuario_id, cedula, cargo)
         VALUES (gen_random_uuid(), $1, $2, $3) ON CONFLICT (usuario_id) DO NOTHING`,
        [u.id, u.cedula ?? null, u.cargo ?? null],
      );
    }
  }
}

/** Quita lo sembrado. Lo que aún esté referenciado por otro dato se deja (no es un error de la prueba). */
export async function quitarMaestros(admin: Pool, m: MaestrosDePrueba): Promise<void> {
  const ids = (m.usuarios ?? []).map((u) => u.id);
  if (!ids.length) return;
  await admin.query('DELETE FROM identidad.usuario_perfil WHERE usuario_id = ANY($1::uuid[])', [
    ids,
  ]);
  for (const id of ids) {
    await admin.query('DELETE FROM identidad.usuario WHERE id = $1', [id]).catch(() => undefined);
  }
}
