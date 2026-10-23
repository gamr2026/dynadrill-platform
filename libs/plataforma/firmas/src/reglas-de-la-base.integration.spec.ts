/**
 * Reglas de la base de firmas contra PostgreSQL real: inmutabilidad (privilegios y trigger), CHECK y FK.
 * Cada prueba intenta violar una regla y espera el rechazo. Limpia lo que crea (como dyn_migrator con la limpieza explícita).
 *   RUN_INTEGRATION=1 npx nx test firmas
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

const HASH = 'a'.repeat(64);

run('firmas: reglas de la base', () => {
  const app = new Pool({ connectionString: APP_DB, max: 2 });
  const migrator = new Pool({ connectionString: MIGRATOR_DB, max: 2 });
  const archivoId = uuidv7();
  const firmaLinea = uuidv7();
  const eventos: string[] = [uuidv7(), uuidv7()];
  let usuarioId = '';
  let documentoTipoId = '';
  let rolId = '';

  type Cols = Partial<{
    id: string;
    evento: string;
    metodo: string;
    archivo: string | null;
    hash: string | null;
    firmante: string;
    documentoTipo: string;
    rol: string;
  }>;
  const insertarFirma = (c: Cols = {}) =>
    app.query(
      `INSERT INTO firmas.firma (id, evento_id, documento_tipo_id, documento_id, rol_firmante_id, firmante_id, metodo, archivo_id, hash_documento)
       VALUES ($1, $2, $3, $4, $5, $6, $7::firmas.metodo_firma, $8, $9)`,
      [
        c.id ?? uuidv7(),
        c.evento ?? uuidv7(),
        c.documentoTipo ?? documentoTipoId,
        uuidv7(),
        c.rol ?? rolId,
        c.firmante ?? usuarioId,
        c.metodo ?? 'linea',
        c.archivo === undefined ? null : c.archivo,
        c.hash === undefined ? HASH : c.hash,
      ],
    );

  beforeAll(async () => {
    usuarioId = (await migrator.query(`SELECT id FROM identidad.usuario LIMIT 1`)).rows[0].id;
    documentoTipoId = (
      await app.query(`SELECT id FROM firmas.documento_tipo WHERE codigo = 'qhse_ptw'`)
    ).rows[0].id;
    rolId = (await app.query(`SELECT id FROM firmas.rol_firmante WHERE codigo = 'trabajador'`))
      .rows[0].id;
    await migrator.query(
      `INSERT INTO archivos.archivo (id, modulo_id, nombre_original, mime_type, tamano_bytes, sha256, blob_key, escaneo, subido_por)
       SELECT $1::uuid, mo.id, 'firma-prueba.pdf', 'application/pdf', 10, repeat('b', 64), 'prueba/' || $1::text, 'omitido', $2::uuid
         FROM archivos.modulo_archivo mo WHERE mo.codigo = 'documento_respaldo_firmado'`,
      [archivoId, usuarioId],
    );
    await insertarFirma({ id: firmaLinea, evento: eventos[0] });
  });

  afterAll(async () => {
    const c = await migrator.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SET LOCAL firmas.limpieza_de_pruebas = 'on'`);
      await c.query(
        `DELETE FROM firmas.firma_verificacion WHERE firma_id IN (SELECT id FROM firmas.firma WHERE evento_id = ANY($1::uuid[]))`,
        [eventos],
      );
      await c.query(`DELETE FROM firmas.firma WHERE evento_id = ANY($1::uuid[])`, [eventos]);
      await c.query('COMMIT');
    } finally {
      c.release();
    }
    await migrator.query(`DELETE FROM archivos.archivo WHERE id = $1`, [archivoId]);
    await app.end();
    await migrator.end();
  });

  it('la aplicación no puede modificar ni borrar firmas ni sus verificaciones', async () => {
    await expect(
      app.query(`UPDATE firmas.firma SET firmada_at = now() WHERE id = $1`, [firmaLinea]),
    ).rejects.toThrow(/permission denied/);
    await expect(app.query(`DELETE FROM firmas.firma WHERE id = $1`, [firmaLinea])).rejects.toThrow(
      /permission denied/,
    );
    await expect(app.query(`UPDATE firmas.firma_verificacion SET confianza = 1`)).rejects.toThrow(
      /permission denied/,
    );
    await expect(app.query(`DELETE FROM firmas.firma_verificacion`)).rejects.toThrow(
      /permission denied/,
    );
  });

  it('el trigger rechaza UPDATE y DELETE incluso al dueño del DDL, salvo la limpieza explícita de las pruebas', async () => {
    await expect(
      migrator.query(`UPDATE firmas.firma SET firmada_at = now() WHERE id = $1`, [firmaLinea]),
    ).rejects.toThrow(/firmas son inmutables/);
    await expect(
      migrator.query(`DELETE FROM firmas.firma WHERE id = $1`, [firmaLinea]),
    ).rejects.toThrow(/firmas son inmutables/);
  });

  it('una firma «de una línea» exige la huella y no admite archivo', async () => {
    await expect(insertarFirma({ hash: null })).rejects.toThrow(/metodo_coherente/);
    await expect(insertarFirma({ archivo: archivoId })).rejects.toThrow(/metodo_coherente/);
  });

  it('una firma con archivo (electrónica o manuscrita) exige el archivo y no guarda huella propia', async () => {
    await expect(insertarFirma({ metodo: 'manuscrita', hash: null })).rejects.toThrow(
      /metodo_coherente/,
    );
    await expect(
      insertarFirma({ metodo: 'electronica', archivo: archivoId, hash: HASH }),
    ).rejects.toThrow(/metodo_coherente/);
    await expect(
      insertarFirma({ metodo: 'manuscrita', archivo: archivoId, hash: null, evento: eventos[1] }),
    ).resolves.toBeDefined();
  });

  it('rechaza una huella que no es un SHA-256 en hexadecimal', async () => {
    await expect(insertarFirma({ hash: 'zz' })).rejects.toThrow(/hash_formato/);
    await expect(insertarFirma({ hash: 'A'.repeat(64) })).rejects.toThrow(/hash_formato/);
  });

  it('rechaza el mismo evento dos veces (idempotencia en la base)', async () => {
    await expect(insertarFirma({ evento: eventos[0] })).rejects.toThrow(/firma_evento_id_key/);
  });

  it('rechaza un firmante, un documento, un papel o un archivo que no existen', async () => {
    await expect(insertarFirma({ firmante: uuidv7() })).rejects.toThrow(/firmante_id_fkey/);
    await expect(insertarFirma({ documentoTipo: uuidv7() })).rejects.toThrow(
      /documento_tipo_id_fkey/,
    );
    await expect(insertarFirma({ rol: uuidv7() })).rejects.toThrow(/rol_firmante_id_fkey/);
    await expect(
      insertarFirma({ metodo: 'manuscrita', archivo: uuidv7(), hash: null }),
    ).rejects.toThrow(/archivo_id_fkey/);
  });

  it('rechaza una verificación con confianza fuera de 0 a 1 y una sin firma', async () => {
    await expect(
      app.query(
        `INSERT INTO firmas.firma_verificacion (id, firma_id, resultado, confianza, solicitada_por)
         VALUES ($1, $2, 'firma_detectada', 1.5, $3)`,
        [uuidv7(), firmaLinea, usuarioId],
      ),
    ).rejects.toThrow(/confianza_rango/);
    await expect(
      app.query(
        `INSERT INTO firmas.firma_verificacion (id, firma_id, resultado, confianza, solicitada_por)
         VALUES ($1, $2, 'firma_detectada', 0.9, $3)`,
        [uuidv7(), uuidv7(), usuarioId],
      ),
    ).rejects.toThrow(/firma_id_fkey/);
  });

  it('rechaza un documento o un papel con código mal formado', async () => {
    await expect(
      app.query(
        `INSERT INTO firmas.documento_tipo (id, codigo, descripcion) VALUES ($1, 'Mal Formato', 'x')`,
        [uuidv7()],
      ),
    ).rejects.toThrow(/codigo_formato/);
    await expect(
      app.query(
        `INSERT INTO firmas.rol_firmante (id, codigo, descripcion) VALUES ($1, 'Mal Formato', 'x')`,
        [uuidv7()],
      ),
    ).rejects.toThrow(/codigo_formato/);
  });
});
