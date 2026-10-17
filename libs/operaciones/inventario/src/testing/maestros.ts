/**
 * Ayuda de las pruebas de integración: las FK a `catalogos` e `identidad` exigen que los ids existan de verdad. Esto inserta
 * (con dyn_migrator) las cuentas y bodegas mínimas que usa cada prueba y las quita al final. Solo para pruebas.
 */
import type { Pool } from 'pg';

export interface MaestrosDePrueba {
  usuarios?: Array<{ id: string; nombre: string; rol: string }>;
  bodegas?: Array<{ id: string; nombre: string }>;
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
       VALUES ($1, $2, $3, $4, $5, true) ON CONFLICT (id) DO NOTHING`,
      [u.id, `${u.id}@test.local`, u.id, u.nombre, rolId],
    );
  }
  for (const b of m.bodegas ?? []) {
    await admin.query(
      'INSERT INTO catalogos.bodega (id, nombre) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING',
      [b.id, b.nombre],
    );
  }
}

/** Quita lo sembrado, en el orden inverso. Lo que aún esté referenciado se deja (no es un error de la prueba). */
export async function quitarMaestros(admin: Pool, m: MaestrosDePrueba): Promise<void> {
  const quitar = async (tabla: string, ids: string[] | undefined) => {
    for (const id of ids ?? [])
      await admin.query(`DELETE FROM ${tabla} WHERE id = $1`, [id]).catch(() => undefined);
  };
  await quitar(
    'catalogos.bodega',
    m.bodegas?.map((x) => x.id),
  );
  await quitar(
    'identidad.usuario',
    m.usuarios?.map((x) => x.id),
  );
}
