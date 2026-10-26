// Las pruebas de integración (RUN_INTEGRATION=1) corren SOLO contra la base y el vhost de RabbitMQ `<POSTGRES_DB>_test`
// (npm run db:test:preparar). Antes compartían los del portal: dejaban datos visibles, el outbox que escribían lo
// publicaban los servicios encendidos y estos les consumían los mensajes. Aquí se definen las URL que leen las pruebas
// (TEST_*), con las credenciales de infra/.env, y se rechaza cualquier URL que apunte a otra base u otro vhost.
const { readFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');

if (process.env.RUN_INTEGRATION) {
  const archivo = join(__dirname, '..', '..', 'infra', '.env');
  if (!existsSync(archivo))
    throw new Error('Pruebas de integración: falta infra/.env (copie infra/.env.example).');
  const env = Object.fromEntries(
    readFileSync(archivo, 'utf8')
      .split(/\r?\n/)
      .filter((l) => /^[A-Z_]+=/.test(l))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
  );
  const base = `${env.POSTGRES_DB}_test`;
  const url = (usuario, clave) =>
    `postgresql://${usuario}:${encodeURIComponent(clave)}@localhost:${env.POSTGRES_PORT}/${base}`;
  const porDefecto = {
    TEST_ADMIN_DATABASE_URL: url(env.POSTGRES_SUPERUSER, env.POSTGRES_SUPERUSER_PASSWORD),
    TEST_MIGRATOR_DATABASE_URL: url('dyn_migrator', env.DYN_MIGRATOR_PASSWORD),
    TEST_DATABASE_URL: url('app_plataforma', env.APP_PLATAFORMA_PASSWORD),
    TEST_PLATAFORMA_DATABASE_URL: url('app_plataforma', env.APP_PLATAFORMA_PASSWORD),
    TEST_COMERCIAL_DATABASE_URL: url('app_comercial', env.APP_COMERCIAL_PASSWORD),
    TEST_OPERACIONES_DATABASE_URL: url('app_operaciones', env.APP_OPERACIONES_PASSWORD),
    TEST_QHSE_DATABASE_URL: url('app_qhse', env.APP_QHSE_PASSWORD),
  };
  // RabbitMQ: vhost propio (npm run db:test:preparar lo crea); si no, el servicio encendido consume los mensajes de la prueba
  porDefecto.TEST_RABBITMQ_URL = `amqp://${env.RABBITMQ_USER}:${encodeURIComponent(env.RABBITMQ_PASSWORD)}@localhost:${env.RABBITMQ_PORT}/${base}`;
  for (const [clave, valor] of Object.entries(porDefecto)) {
    process.env[clave] ??= valor;
    const nombre = decodeURIComponent(new URL(process.env[clave]).pathname.slice(1));
    if (!nombre.endsWith('_test')) {
      throw new Error(
        `Pruebas de integración: ${clave} apunta a "${nombre}"; solo se permite una base o vhost *_test.`,
      );
    }
  }
}
