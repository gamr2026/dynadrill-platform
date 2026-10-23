/**
 * Reglas de la base de auditoría contra PostgreSQL real: inmutabilidad (privilegios y trigger), CHECK y FK.
 * Cada prueba intenta violar una regla y espera el rechazo. Limpia lo que crea (como dyn_migrator con la limpieza explícita).
 *   RUN_INTEGRATION=1 npx nx test auditoria
 */
import { Pool } from 'pg';
import { uuidv7 } from '@dyn/utils';

const run = process.env['RUN_INTEGRATION'] ? describe : describe.skip;

const APP_DB =
  process.env['TEST_PLATAFORMA_DATABASE_URL'] ??
  'postgresql://app_plataforma:dev_app_plataforma@localhost:6432/dynadrill?pgbouncer=true';
const MIGRATOR_DB =
  process.env['TEST_MIGRATOR_DATABASE_URL'] ??
  'postgresql://dyn_migrator:dev_dyn_migrator@localhost:5433/dynadrill';

run('auditoria: reglas de la base', () => {
  const app = new Pool({ connectionString: APP_DB, max: 2 });
  const migrator = new Pool({ connectionString: MIGRATOR_DB, max: 2 });
  const sufijo = Date.now();
  const tipoId = uuidv7();
  const sujetoTipoId = uuidv7();
  const eventoId = uuidv7();
  let claveId = '';
  let usuarioId = '';
  let rolId = '';

  const insertarEvento = (id: string, extra: Partial<Record<string, unknown>> = {}) => {
    const c = {
      version: 1,
      actor_id: null,
      actor_rol_id: null,
      ...extra,
    };
    return app.query(
      `INSERT INTO auditoria.evento_auditado (id, tipo_evento_id, version, ocurrido_at, origen, sujeto_tipo_id, sujeto_id, actor_id, actor_rol_id)
       VALUES ($1, $2, $3, now(), 'operaciones', $4, $5, $6, $7)`,
      [id, tipoId, c.version, sujetoTipoId, uuidv7(), c.actor_id, c.actor_rol_id],
    );
  };

  beforeAll(async () => {
    await app.query(`INSERT INTO auditoria.tipo_evento (id, codigo) VALUES ($1, $2)`, [
      tipoId,
      `prueba.regla.hecho_${sufijo}`,
    ]);
    await app.query(`INSERT INTO auditoria.sujeto_tipo (id, codigo) VALUES ($1, $2)`, [
      sujetoTipoId,
      `prueba_${sufijo}`,
    ]);
    claveId = (await app.query(`SELECT id FROM auditoria.clave_dato WHERE codigo = 'pedido_id'`))
      .rows[0].id;
    usuarioId = (await migrator.query(`SELECT id FROM identidad.usuario LIMIT 1`)).rows[0].id;
    rolId = (await migrator.query(`SELECT id FROM identidad.rol LIMIT 1`)).rows[0].id;
    await insertarEvento(eventoId, { actor_id: usuarioId, actor_rol_id: rolId });
    await app.query(
      `INSERT INTO auditoria.evento_auditado_dato (evento_id, clave_dato_id, valor) VALUES ($1, $2, 'P-1')`,
      [eventoId, claveId],
    );
  });

  afterAll(async () => {
    const c = await migrator.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SET LOCAL auditoria.limpieza_de_pruebas = 'on'`);
      await c.query(
        `DELETE FROM auditoria.evento_auditado_dato WHERE evento_id IN (SELECT id FROM auditoria.evento_auditado WHERE tipo_evento_id = $1)`,
        [tipoId],
      );
      await c.query(`DELETE FROM auditoria.evento_auditado WHERE tipo_evento_id = $1`, [tipoId]);
      await c.query('COMMIT');
    } finally {
      c.release();
    }
    await migrator.query(`DELETE FROM auditoria.tipo_evento WHERE id = $1`, [tipoId]);
    await migrator.query(`DELETE FROM auditoria.sujeto_tipo WHERE id = $1`, [sujetoTipoId]);
    await app.end();
    await migrator.end();
  });

  it('la aplicación no puede modificar ni borrar eventos ni sus datos', async () => {
    await expect(
      app.query(`UPDATE auditoria.evento_auditado SET version = 2 WHERE id = $1`, [eventoId]),
    ).rejects.toThrow(/permission denied/);
    await expect(
      app.query(`DELETE FROM auditoria.evento_auditado WHERE id = $1`, [eventoId]),
    ).rejects.toThrow(/permission denied/);
    await expect(
      app.query(`UPDATE auditoria.evento_auditado_dato SET valor = 'x' WHERE evento_id = $1`, [
        eventoId,
      ]),
    ).rejects.toThrow(/permission denied/);
    await expect(
      app.query(`DELETE FROM auditoria.evento_auditado_dato WHERE evento_id = $1`, [eventoId]),
    ).rejects.toThrow(/permission denied/);
  });

  it('el trigger rechaza UPDATE y DELETE incluso al dueño del DDL, salvo la limpieza explícita de las pruebas', async () => {
    await expect(
      migrator.query(`UPDATE auditoria.evento_auditado SET version = 2 WHERE id = $1`, [eventoId]),
    ).rejects.toThrow(/auditoría es inmutable/);
    await expect(
      migrator.query(`DELETE FROM auditoria.evento_auditado_dato WHERE evento_id = $1`, [eventoId]),
    ).rejects.toThrow(/auditoría es inmutable/);
  });

  it('rechaza un evento repetido (llave de idempotencia)', async () => {
    await expect(insertarEvento(eventoId)).rejects.toThrow(/duplicate key/);
  });

  it('rechaza una versión menor a 1', async () => {
    await expect(insertarEvento(uuidv7(), { version: 0 })).rejects.toThrow(/version_positiva/);
  });

  it('rechaza un rol sin actor', async () => {
    await expect(insertarEvento(uuidv7(), { actor_rol_id: rolId })).rejects.toThrow(
      /rol_requiere_actor/,
    );
  });

  it('rechaza un actor que no existe en identidad', async () => {
    await expect(insertarEvento(uuidv7(), { actor_id: uuidv7() })).rejects.toThrow(/actor_id_fkey/);
  });

  it('rechaza un tipo de evento o de sujeto con formato inválido', async () => {
    await expect(
      app.query(`INSERT INTO auditoria.tipo_evento (id, codigo) VALUES ($1, 'Mal Formato')`, [
        uuidv7(),
      ]),
    ).rejects.toThrow(/codigo_formato/);
    await expect(
      app.query(`INSERT INTO auditoria.sujeto_tipo (id, codigo) VALUES ($1, 'Mal Formato')`, [
        uuidv7(),
      ]),
    ).rejects.toThrow(/codigo_formato/);
  });

  it('rechaza un dato repetido para la misma clave, un valor vacío y una clave inexistente', async () => {
    await expect(
      app.query(
        `INSERT INTO auditoria.evento_auditado_dato (evento_id, clave_dato_id, valor) VALUES ($1, $2, 'P-2')`,
        [eventoId, claveId],
      ),
    ).rejects.toThrow(/duplicate key/);
    const otra = (await app.query(`SELECT id FROM auditoria.clave_dato WHERE codigo = 'ticket_id'`))
      .rows[0].id;
    await expect(
      app.query(
        `INSERT INTO auditoria.evento_auditado_dato (evento_id, clave_dato_id, valor) VALUES ($1, $2, '')`,
        [eventoId, otra],
      ),
    ).rejects.toThrow(/valor_largo/);
    await expect(
      app.query(
        `INSERT INTO auditoria.evento_auditado_dato (evento_id, clave_dato_id, valor) VALUES ($1, $2, 'x')`,
        [eventoId, uuidv7()],
      ),
    ).rejects.toThrow(/clave_dato_id_fkey/);
  });

  it('rechaza un origen que no es de un contenedor conocido', async () => {
    await expect(
      app.query(
        `INSERT INTO auditoria.evento_auditado (id, tipo_evento_id, version, ocurrido_at, origen, sujeto_tipo_id, sujeto_id)
         VALUES ($1, $2, 1, now(), 'otro', $3, $4)`,
        [uuidv7(), tipoId, sujetoTipoId, uuidv7()],
      ),
    ).rejects.toThrow(/origen_evento/);
  });
});
