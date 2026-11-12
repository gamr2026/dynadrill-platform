// Migrador ordenado de toda la plataforma: aplica las migraciones de los 15 módulos en UN solo orden global (por timestamp).
//
// Por qué existe: cada módulo tiene su propio historial de Prisma (`libs/<contenedor>/<modulo>/prisma/migrations`, con su
// tabla `_prisma_migrations` dentro de su schema) pero hay claves foráneas entre schemas (aceptadas a propósito, p. ej.
// flota -> pumping.ticket y pumping -> flota.unidad). Correr `prisma migrate deploy` módulo por módulo no permite armar
// una base desde cero: siempre falta alguna tabla de otro módulo. El orden por timestamp sí.
//
// Cómo (decisión): `prisma migrate deploy` aplica TODAS las pendientes de un módulo y no tiene "aplicar solo hasta X".
// Intercalar módulos con Prisma obligaría a lanzarlo ~190 veces (una por cada cambio de módulo en el orden global) con un
// directorio de migraciones filtrado por cada tanda. En su lugar este script hace lo mismo que Prisma, que es poco:
// ejecuta el SQL de `migration.sql` y registra la fila en `<schema>._prisma_migrations` (mismo checksum sha256 y mismas
// columnas), de modo que después `prisma migrate status` y `prisma migrate deploy` de cada módulo lo ven como aplicado.
// Si cambia el formato interno de esa tabla en una versión mayor de Prisma, hay que revisar `registrar()`.
//
// Uso:
//   node scripts/migrar-todo.mjs                      plan (--dry-run, por defecto): no cambia nada
//   node scripts/migrar-todo.mjs --aplicar            aplica las pendientes en orden global
//   --url <postgresql://...>   base destino (si no, DATABASE_URL_MIGRATOR; si no, la de desarrollo según infra/.env).
//                              Se ignora el parámetro ?schema= de la URL: cada migración usa el schema de su módulo.
//   --confirmar-desarrollo     necesario para --aplicar si el nombre de la base no termina en `_test`
//   --pendientes               en el plan, listar solo las pendientes
// Solo lee el estado y, con --aplicar, escribe. Nunca borra ni reinicia nada. Se detiene en el primer error.
import { createHash, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { descubrirModulos, urlDestino } from './lib-modulos.mjs';

const args = process.argv.slice(2);
const tiene = (f) => args.includes(f);
const aplicar = tiene('--aplicar') && !tiene('--dry-run');
const soloPendientes = tiene('--pendientes');

// --- Destino -------------------------------------------------------------------------------------------------------
const url = urlDestino(args);
const baseDatos = decodeURIComponent(url.pathname.slice(1));
if (aplicar && !baseDatos.endsWith('_test') && !tiene('--confirmar-desarrollo')) {
  console.error(
    `Rechazado: "${baseDatos}" no termina en _test. Para aplicar sobre una base que no es de pruebas pase --confirmar-desarrollo.`,
  );
  process.exit(2);
}

// --- Descubrimiento ------------------------------------------------------------------------------------------------
const modulos = descubrirModulos();
const plan = [];
for (const m of modulos) {
  for (const e of readdirSync(m.migraciones, { withFileTypes: true })) {
    if (!e.isDirectory() || !/^\d{14}_/.test(e.name)) continue;
    plan.push({
      nombre: e.name,
      modulo: m.schema,
      ruta: m.ruta,
      archivo: join(m.migraciones, e.name, 'migration.sql'),
    });
  }
}
// Orden global: timestamp (los 14 primeros dígitos); a igualdad, por nombre completo y luego por módulo, para que sea estable.
plan.sort(
  (a, b) =>
    a.nombre.slice(0, 14).localeCompare(b.nombre.slice(0, 14)) ||
    a.nombre.localeCompare(b.nombre) ||
    a.modulo.localeCompare(b.modulo),
);

// --- Estado en la base ---------------------------------------------------------------------------------------------
const cliente = new pg.Client({ connectionString: url.toString() });
await cliente.connect();

/** Migraciones registradas como aplicadas por módulo: Map<schema, Map<nombre, checksum>>. */
async function leerAplicadas() {
  const aplicadas = new Map();
  for (const m of modulos) {
    const existe = await cliente.query(
      `SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = '_prisma_migrations'`,
      [m.schema],
    );
    const filas = existe.rowCount
      ? (
          await cliente.query(
            `SELECT migration_name, checksum FROM "${m.schema}"."_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`,
          )
        ).rows
      : [];
    aplicadas.set(m.schema, new Map(filas.map((f) => [f.migration_name, f.checksum])));
  }
  return aplicadas;
}

// Prisma calcula el checksum sobre el texto con saltos de línea LF (en Windows el checkout trae CRLF).
const checksum = (sql) => createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
const aplicadas = await leerAplicadas();
const pendientes = [];
const alertas = [];
for (const p of plan) {
  const registrada = aplicadas.get(p.modulo).get(p.nombre);
  p.sql = readFileSync(p.archivo, 'utf8');
  p.estado = registrada ? 'aplicada' : 'PENDIENTE';
  if (registrada && registrada !== checksum(p.sql))
    alertas.push(`checksum distinto al aplicado (migración editada): ${p.modulo} ${p.nombre}`);
  if (!registrada) pendientes.push(p);
}
for (const [schema, mapa] of aplicadas) {
  const enDisco = new Set(plan.filter((p) => p.modulo === schema).map((p) => p.nombre));
  for (const nombre of mapa.keys())
    if (!enDisco.has(nombre))
      alertas.push(`aplicada en la base pero sin carpeta en el repo: ${schema} ${nombre}`);
}

// --- Plan ----------------------------------------------------------------------------------------------------------
console.log(`Base destino: ${baseDatos}  (${aplicar ? 'APLICAR' : 'dry-run: no se cambia nada'})`);
console.log(
  `Plan global ordenado por timestamp (${plan.length} migraciones, ${pendientes.length} pendientes):`,
);
plan.forEach((p, i) => {
  if (soloPendientes && p.estado === 'aplicada') return;
  console.log(`${String(i + 1).padStart(3)}. [${p.estado}] ${p.nombre}  (${p.modulo})`);
});
console.log('\nPor módulo (total / pendientes):');
for (const m of modulos.map((x) => x.schema).sort()) {
  const total = plan.filter((p) => p.modulo === m).length;
  console.log(
    `  ${m.padEnd(15)} ${String(total).padStart(3)} / ${pendientes.filter((p) => p.modulo === m).length}`,
  );
}
for (const a of alertas) console.warn(`ALERTA: ${a}`);

if (!aplicar) {
  await cliente.end();
  process.exit(0);
}

// --- Aplicación ----------------------------------------------------------------------------------------------------
const DDL_HISTORIAL = (schema) => `CREATE TABLE IF NOT EXISTS "${schema}"."_prisma_migrations" (
  id VARCHAR(36) PRIMARY KEY NOT NULL,
  checksum VARCHAR(64) NOT NULL,
  finished_at TIMESTAMPTZ,
  migration_name VARCHAR(255) NOT NULL,
  logs TEXT,
  rolled_back_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_steps_count INTEGER NOT NULL DEFAULT 0
)`;

async function registrar(p, inicio) {
  await cliente.query(
    `INSERT INTO "${p.modulo}"."_prisma_migrations" (id, checksum, migration_name, started_at, finished_at, applied_steps_count)
     VALUES ($1, $2, $3, $4, now(), 1)`,
    [randomUUID(), checksum(p.sql), p.nombre, inicio],
  );
}

let hechas = 0;
for (const p of pendientes) {
  const schema = await cliente.query(`SELECT 1 FROM pg_namespace WHERE nspname = $1`, [p.modulo]);
  if (!schema.rowCount) {
    console.error(
      `Falta el schema "${p.modulo}" (lo crea infra/db/init/02-schemas.sql). Detenido antes de ${p.nombre}.`,
    );
    process.exit(1);
  }
  const inicio = new Date();
  try {
    await cliente.query(DDL_HISTORIAL(p.modulo));
    // Igual que Prisma: la sesión trabaja con el schema del módulo en el search_path.
    await cliente.query(`SET search_path TO "${p.modulo}"`);
    await cliente.query(p.sql);
    await cliente.query('RESET search_path');
    await registrar(p, inicio);
  } catch (e) {
    console.error(`FALLÓ ${p.modulo} ${p.nombre}: ${e.message}`);
    console.error(
      `Aplicadas antes del fallo: ${hechas}. Nada se revirtió; corrija y vuelva a correr (retoma desde la pendiente).`,
    );
    process.exit(1);
  }
  hechas++;
  console.log(`aplicada ${p.nombre} (${p.modulo})`);
}
console.log(`Listo: ${hechas} migraciones aplicadas.`);
await cliente.end();
