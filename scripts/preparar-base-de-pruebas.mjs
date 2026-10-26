// Crea (o reinicia) la base de las pruebas de integración: `<POSTGRES_DB>_test`, copia de la base de desarrollo
// (esquemas, permisos, migraciones aplicadas y catálogos sembrados). Las pruebas con RUN_INTEGRATION=1 solo corren contra
// ella (ver tools/jest/base-de-pruebas.cjs): así no ensucian la base que usa el portal ni sus eventos llegan a los servicios.
// Uso: npm run db:test:preparar   (repetirlo cuando se agreguen migraciones o se quiera partir de cero)
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const env = Object.fromEntries(
  readFileSync('infra/.env', 'utf8')
    .split(/\r?\n/)
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
);
const base = env.POSTGRES_DB;
const prueba = `${base}_test`;
if (!/^[a-z_]+$/.test(base)) throw new Error(`POSTGRES_DB inválido en infra/.env: ${base}`);

// Dentro del contenedor el superusuario entra por el socket local, sin contraseña.
const pasos = [
  `dropdb -U "$POSTGRES_USER" --if-exists --force ${prueba}`,
  `createdb -U "$POSTGRES_USER" ${prueba}`,
  `pg_dump -U "$POSTGRES_USER" -Fc ${base} | pg_restore -U "$POSTGRES_USER" -d ${prueba} --exit-on-error`,
].join(' && ');
const r = spawnSync(
  'docker',
  ['compose', '-f', 'infra/docker-compose.yml', 'exec', '-T', 'postgres', 'sh', '-c', pasos],
  { stdio: 'inherit' },
);
if (r.status !== 0) {
  console.error(
    `No se pudo preparar ${prueba} (¿está arriba el contenedor de Postgres? npm run infra:up).`,
  );
  process.exit(r.status ?? 1);
}
console.log(`Base de pruebas ${prueba} lista (copia de ${base}).`);

// RabbitMQ: vhost propio para que los servicios encendidos no consuman los mensajes de las pruebas (ni al revés)
const rabbit = (...args) =>
  spawnSync(
    'docker',
    [
      'compose',
      '-f',
      'infra/docker-compose.yml',
      'exec',
      '-T',
      'rabbitmq',
      'rabbitmqctl',
      '-q',
      ...args,
    ],
    {
      encoding: 'utf8',
    },
  );
const vhosts = rabbit('list_vhosts');
if (vhosts.status !== 0) {
  console.error('No se pudo consultar RabbitMQ (¿está arriba el contenedor?).');
  process.exit(vhosts.status ?? 1);
}
if (!vhosts.stdout.split(/\r?\n/).includes(prueba)) {
  if (rabbit('add_vhost', prueba).status !== 0) process.exit(1);
}
if (rabbit('set_permissions', '-p', prueba, env.RABBITMQ_USER, '.*', '.*', '.*').status !== 0)
  process.exit(1);
console.log(`Vhost de RabbitMQ ${prueba} listo.`);
