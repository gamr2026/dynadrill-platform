/**
 * Limpieza de las pruebas de integración de investigaciones. Una investigación cerrada (y sus acciones y causas) está protegida por triggers que
 * también impiden borrarla, así que el rol migrador los apaga SOLO dentro de la misma transacción en que borra y los vuelve a encender antes de
 * confirmar: ninguna otra sesión llega a ver los triggers apagados. Solo para pruebas.
 */
import type { Pool } from 'pg';

const HIJAS = [
  'investigacion_accion_control',
  'investigacion_porque',
  'investigacion_ishikawa_causa',
  'investigacion_causa',
  'investigacion_testigo',
  'investigacion_entorno_factor',
  'investigacion_equipo',
  'investigacion_trabajador',
  'investigacion_detalle',
] as const;

/** Borra las investigaciones creadas por esas cuentas, con todo lo que cuelga de ellas, y sus eventos del outbox. */
export async function borrarInvestigacionesDe(admin: Pool, usuarios: string[]): Promise<void> {
  const c = await admin.connect();
  try {
    await c.query('BEGIN');
    const inv = '(SELECT id FROM qhse.investigacion WHERE created_by = ANY($1::uuid[]))';
    const acc = `(SELECT id FROM qhse.investigacion_accion WHERE investigacion_id IN ${inv})`;
    for (const h of HIJAS) await c.query(`ALTER TABLE qhse.${h} DISABLE TRIGGER USER`);
    await c.query(`DELETE FROM qhse.investigacion_accion_historial WHERE accion_id IN ${acc}`, [
      usuarios,
    ]);
    await c.query(`DELETE FROM qhse.investigacion_accion_control WHERE accion_id IN ${acc}`, [
      usuarios,
    ]);
    for (const h of HIJAS.filter((x) => x !== 'investigacion_accion_control'))
      await c.query(`DELETE FROM qhse.${h} WHERE investigacion_id IN ${inv}`, [usuarios]);
    for (const h of HIJAS) await c.query(`ALTER TABLE qhse.${h} ENABLE TRIGGER USER`);
    await c.query(`DELETE FROM qhse.investigacion_accion WHERE investigacion_id IN ${inv}`, [
      usuarios,
    ]);
    await c.query(`DELETE FROM qhse.investigacion_historial WHERE investigacion_id IN ${inv}`, [
      usuarios,
    ]);
    await c.query('DELETE FROM qhse.investigacion WHERE created_by = ANY($1::uuid[])', [usuarios]);
    await c.query(
      "DELETE FROM msg_qhse.outbox WHERE tipo LIKE 'qhse.investigacion.%' AND datos->'actor'->>'userId' = ANY($1::text[])",
      [usuarios],
    );
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}
