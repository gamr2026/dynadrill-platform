// Utilidades compartidas por los scripts de migraciones (migrar-todo.mjs, verificar-restricciones.mjs).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Todos los módulos con `prisma/migrations`, con el nombre de su schema (el que fija su prisma.config.ts). */
export function descubrirModulos() {
  const modulos = [];
  for (const contenedor of readdirSync('libs', { withFileTypes: true })) {
    if (!contenedor.isDirectory()) continue;
    for (const mod of readdirSync(join('libs', contenedor.name), { withFileTypes: true })) {
      const dir = join('libs', contenedor.name, mod.name);
      const migraciones = join(dir, 'prisma', 'migrations');
      if (!mod.isDirectory() || !existsSync(migraciones)) continue;
      const config = join(dir, 'prisma.config.ts');
      const schema = existsSync(config)
        ? /searchParams\.set\(\s*'schema'\s*,\s*'([a-z_]+)'/.exec(readFileSync(config, 'utf8'))?.[1]
        : undefined;
      modulos.push({
        ruta: `${contenedor.name}/${mod.name}`,
        dir,
        schema: schema ?? mod.name,
        migraciones,
      });
    }
  }
  return modulos;
}

/**
 * URL de la base destino, sin el parámetro ?schema=: `--url`, si no `DATABASE_URL_MIGRATOR`,
 * si no la base de desarrollo según infra/.env (usuario dyn_migrator).
 */
export function urlDestino(args) {
  const i = args.indexOf('--url');
  const explicita = (i >= 0 ? args[i + 1] : undefined) ?? process.env.DATABASE_URL_MIGRATOR;
  let url;
  if (explicita) {
    url = new URL(explicita);
  } else {
    const env = Object.fromEntries(
      readFileSync('infra/.env', 'utf8')
        .split(/\r?\n/)
        .filter((l) => /^[A-Z_]+=/.test(l))
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
    );
    url = new URL(
      `postgresql://dyn_migrator:${encodeURIComponent(env.DYN_MIGRATOR_PASSWORD)}@localhost:${env.POSTGRES_PORT}/${env.POSTGRES_DB}`,
    );
  }
  url.searchParams.delete('schema');
  return url;
}
