// Verifica que `prisma migrate diff` no proponga ELIMINAR objetos de un módulo que no estén en la lista de permitidos.
//
// Contexto: restricciones como índices únicos parciales, CHECK, triggers y FKs entre schemas viven solo en SQL escrito a mano
// (ver docs/restricciones-solo-sql.md). Si alguien corre `prisma migrate dev` o aplica un diff generado, Prisma las borraría.
// Este script compara la base (migrada con `npm run db:migrate:todo`) contra cada schema.prisma y falla (exit 1) si el diff de un
// módulo contiene un DROP que no figura en `docs/restricciones-solo-sql.permitidas.json`. SOLO LEE: `migrate diff` no escribe.
//
// Cómo: `--from-config-datasource` (la base) contra `--to-schema` (el datamodel). Prisma 7 no admite `--from-url` y
// `--from-migrations` exigiría una base sombra imposible de armar módulo por módulo (FKs entre schemas). Como la introspección
// falla si una FK apunta a un schema que el datamodel no declara, se usa una copia temporal del schema.prisma con TODOS los
// schemas de la base en `schemas = [...]`, y del diff solo se evalúan las sentencias sobre objetos del schema propio del módulo
// (las de los demás schemas son ruido de esa copia).
// Nota: Prisma no introspecciona CHECK ni triggers: esos nunca aparecen en el diff y se listan solo en el documento.
//
// Uso: node scripts/verificar-restricciones.mjs [--url <postgresql://...>] [--informe] [--generar]
//   --informe   imprime además los cambios no destructivos (ALTER/CREATE) que Prisma propondría
//   --generar   escribe la lista de permitidos con los DROP encontrados ahora (para regenerarla tras revisar el diff a mano)
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pg from 'pg';
import { descubrirModulos, urlDestino } from './lib-modulos.mjs';

const args = process.argv.slice(2);
const ARCHIVO_PERMITIDAS = 'docs/restricciones-solo-sql.permitidas.json';
const url = urlDestino(args);

// Schemas de la base (todos, salvo los de sistema y public) para la copia temporal del datamodel.
const cliente = new pg.Client({ connectionString: url.toString() });
await cliente.connect();
const schemasBase = (
  await cliente.query(
    `SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg\\_%' AND nspname NOT IN ('information_schema', 'public') ORDER BY 1`,
  )
).rows.map((r) => r.nspname);
await cliente.end();

/** Schema dueño de una sentencia de Prisma: los objetos del schema propio salen SIN calificar (la sesión usa ?schema=). */
function duenoDelBloque(propio, bloque) {
  const sentencia = bloque.split(/\r?\n/).slice(1).join('\n').trim();
  const calificado =
    /^(?:ALTER TABLE|DROP INDEX|DROP TABLE|DROP TYPE|DROP VIEW|DROP FUNCTION|CREATE TABLE|CREATE TYPE|ALTER TYPE)(?: ONLY)?\s+"([^"]+)"\./.exec(
      sentencia,
    ) ?? /^CREATE (?:UNIQUE )?INDEX\s+"[^"]+"\s+ON\s+"([^"]+)"\./.exec(sentencia);
  return calificado ? calificado[1] : propio;
}

/** Clave estable de un DROP: `<modulo>|<tipo>|<schema.objeto>`. */
function clavesDeDrops(modulo, bloque) {
  const sentencia = bloque.split(/\r?\n/).slice(1).join('\n');
  const claves = [];
  const calificar = (o) => (o.includes('.') ? o : `${modulo}.${o}`);
  const quitar = (o) => o.replace(/"/g, '');
  const tabla = /ALTER TABLE(?: ONLY)? ("[^"]+"(?:\."[^"]+")?)/.exec(sentencia)?.[1];
  const f = (tipo, objeto) => claves.push(`${modulo}|${tipo}|${calificar(quitar(objeto))}`);
  const tablaQ = tabla ? calificar(quitar(tabla)) : '';
  for (const m of sentencia.matchAll(/DROP CONSTRAINT "([^"]+)"/g))
    f('DROP CONSTRAINT', `${tablaQ}.${m[1]}`);
  for (const m of sentencia.matchAll(/DROP COLUMN "([^"]+)"/g))
    f('DROP COLUMN', `${tablaQ}.${m[1]}`);
  for (const m of sentencia.matchAll(
    /^DROP (INDEX|TABLE|TYPE|VIEW|FUNCTION) ("[^"]+"(?:\."[^"]+")?)/gm,
  ))
    f(`DROP ${m[1]}`, m[2]);
  return claves;
}

const permitidas = (() => {
  try {
    return new Set(
      Object.values(JSON.parse(readFileSync(ARCHIVO_PERMITIDAS, 'utf8')).permitidas).flat(),
    );
  } catch {
    return new Set();
  }
})();

const temporal = mkdtempSync(join(tmpdir(), 'verificar-restricciones-'));
const hallados = {}; // modulo -> claves de DROP
const informe = [];
let fallos = 0;
let errores = 0; // módulos cuyo diff no pudo calcularse
try {
  for (const m of descubrirModulos().sort((a, b) => a.schema.localeCompare(b.schema))) {
    const original = readFileSync(join(m.dir, 'prisma', 'schema.prisma'), 'utf8');
    const copia = original.replace(/^(\s*schemas\s*=).*$/m, `$1 ${JSON.stringify(schemasBase)}`);
    const rutaCopia = join(temporal, `${m.schema}.prisma`);
    writeFileSync(rutaCopia, copia);
    const r = spawnSync(
      process.execPath,
      [
        resolve('node_modules/prisma/build/index.js'),
        'migrate',
        'diff',
        '--from-config-datasource',
        '--to-schema',
        rutaCopia,
        '--script',
      ],
      {
        cwd: m.dir,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, DATABASE_URL_MIGRATOR: url.toString() },
      },
    );
    if (r.status !== 0) {
      console.error(
        `ERROR en ${m.schema}: prisma migrate diff terminó con ${r.status}\n${r.stderr}`,
      );
      fallos++;
      errores++;
      continue;
    }
    // Una sentencia por bloque "-- Tipo" de Prisma; solo las que tocan el schema propio del módulo.
    const bloques = r.stdout.split(/^-- (?=\w+\s*$)/m).filter((b) => b.trim());
    const propios = bloques.filter((b) => duenoDelBloque(m.schema, b) === m.schema);
    const claves = propios.flatMap((b) => clavesDeDrops(m.schema, b));
    hallados[m.schema] = claves;
    for (const b of propios)
      if (!/\bDROP (CONSTRAINT|COLUMN|INDEX|TABLE|TYPE|VIEW|FUNCTION)\b/.test(b))
        informe.push(`[${m.schema}] ${b.trim().split('\n').slice(0, 3).join(' ')}`);
    const nuevas = claves.filter((c) => !permitidas.has(c));
    console.log(
      `${m.schema.padEnd(14)} bloques propios: ${String(propios.length).padStart(3)}  DROP: ${String(claves.length).padStart(3)}  no permitidos: ${nuevas.length}`,
    );
    for (const c of nuevas) console.error(`  NO PERMITIDO: ${c}`);
    fallos += nuevas.length;
  }
} finally {
  rmSync(temporal, { recursive: true, force: true });
}
if (args.includes('--informe'))
  for (const l of informe) console.log(`  cambio no destructivo propuesto: ${l}`);
if (args.includes('--generar')) {
  if (errores > 0) {
    console.error('No se escribe la lista de permitidos: hubo módulos sin diff.');
    process.exit(1);
  }
  const contenido = {
    _nota:
      'Objetos que Prisma propondría borrar y que el proyecto mantiene a propósito solo en SQL. Generado por scripts/verificar-restricciones.mjs --generar; revisar contra docs/restricciones-solo-sql.md.',
    permitidas: Object.fromEntries(
      Object.entries(hallados).map(([k, v]) => [k, [...new Set(v)].sort()]),
    ),
  };
  writeFileSync(ARCHIVO_PERMITIDAS, `${JSON.stringify(contenido, null, 2)}\n`);
  console.log(`Escrito ${ARCHIVO_PERMITIDAS}`);
  process.exit(0);
}
if (fallos > 0) {
  console.error(
    `\nFALLO: ${fallos} problema(s). Revise docs/restricciones-solo-sql.md antes de aplicar cualquier diff de Prisma.`,
  );
  process.exit(1);
}
console.log('OK: ningún DROP fuera de la lista de permitidos.');
