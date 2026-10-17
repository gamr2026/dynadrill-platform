/**
 * Ayuda de las pruebas de integración: las FK a `catalogos` e `identidad` exigen que los ids existan de verdad. Esto inserta
 * (con dyn_migrator) los registros maestros mínimos que usa cada prueba y los quita al final. Solo para pruebas.
 */
import type { Pool } from 'pg';

export interface MaestrosDePrueba {
  usuarios?: Array<{ id: string; nombre: string; rol: string; activo?: boolean }>;
  vehiculos?: Array<{ id: string; placa: string }>;
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
  }
  for (const v of m.vehiculos ?? []) {
    await admin.query(
      'INSERT INTO catalogos.vehiculo (id, placa) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING',
      [v.id, v.placa],
    );
  }
}

/** Quita lo sembrado, en el orden inverso. Lo que aún esté referenciado por otro dato se deja (no es un error de la prueba). */
export async function quitarMaestros(admin: Pool, m: MaestrosDePrueba): Promise<void> {
  const quitar = async (tabla: string, ids: string[] | undefined) => {
    for (const id of ids ?? []) {
      await admin.query(`DELETE FROM ${tabla} WHERE id = $1`, [id]).catch(() => undefined);
    }
  };
  await quitar('catalogos.vehiculo', m.vehiculos?.map((x) => x.id));
  await quitar('identidad.usuario', m.usuarios?.map((x) => x.id));
}
