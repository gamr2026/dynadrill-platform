// Prepara el entorno local de desarrollo (idempotente): llaves JWT RS256 y .env de cada app.
// Uso: npm run dev:setup           (no pisa archivos existentes)
//      npm run dev:setup -- --force (regenera llaves y .env)
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';

const force = process.argv.includes('--force');
const keysDir = 'infra/keys';
const privPath = `${keysDir}/jwt-private.pem`;
const pubPath = `${keysDir}/jwt-public.pem`;

mkdirSync(keysDir, { recursive: true });
if (force || !existsSync(privPath) || !existsSync(pubPath)) {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  writeFileSync(privPath, privateKey);
  writeFileSync(pubPath, publicKey);
  console.log(`llaves JWT generadas en ${keysDir}/`);
}
// Los PEM van en una sola línea con "\n" literales (normalizePem los restaura al leerlos).
const toOneLine = (path) => readFileSync(path, 'utf8').trim().split('\n').join('\\n');
const publicPem = toOneLine(pubPath);
const privatePem = toOneLine(privPath);

const apps = {
  gateway: `SERVICE_NAME=gateway
PORT=3100
LOG_LEVEL=info
CORS_ORIGIN=http://localhost:4200
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
JWT_PUBLIC_KEY="${publicPem}"

# Backend demo (dynadrill-backend). Todo lo que ningún contenedor nuevo atienda va aquí.
# Ajuste el puerto si la demo corre en otro (p. ej. PORT=3300 npm run start:prod dentro de dynadrill-backend).
LEGACY_URL=http://localhost:3000

# TRANSICIÓN (puente de identidad): JWT_SECRET del .env de la demo. Con él el gateway convierte el token
# nuevo en uno que la demo acepta. Sin él, los módulos que siguen en la demo rechazarán el login nuevo.
# LEGACY_JWT_SECRET=

# Un contenedor sin URL no recibe tráfico: sus rutas siguen en la demo.
# Descomente cada línea cuando el contenedor tenga listo el módulo que atiende esas rutas.
# PLATAFORMA_URL=http://localhost:3101
# COMERCIAL_URL=http://localhost:3102
# OPERACIONES_URL=http://localhost:3103
# QHSE_URL=http://localhost:3104
`,
  plataforma: `SERVICE_NAME=plataforma
PORT=3101
LOG_LEVEL=info
CORS_ORIGIN=http://localhost:4200
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
JWT_PUBLIC_KEY="${publicPem}"

JWT_PRIVATE_KEY="${privatePem}"
DEV_ROLE_SWITCH=true

# Superadmin inicial para npm run db:seed:identidad (solo desarrollo)
SEED_ADMIN_EMAIL=superadmin@dynadrill.com
SEED_ADMIN_PASSWORD=Dynadrill2026*

# Migraciones: dyn_migrator directo a Postgres (no por PgBouncer); el schema ubica el historial de Prisma.
DATABASE_URL_MIGRATOR=postgresql://dyn_migrator:dev_dyn_migrator@localhost:5433/dynadrill?schema=identidad

# Usuario app_plataforma a través de PgBouncer (las migraciones usan dyn_migrator directo al 5433).
DATABASE_URL=postgresql://app_plataforma:dev_app_plataforma@localhost:6432/dynadrill?pgbouncer=true
RABBITMQ_URL=amqp://dynadrill:dev_rabbitmq@localhost:5672

# Endpoints de prueba de F0 (outbox → RabbitMQ → inbox). Nunca en producción.
DIAGNOSTICO_ENABLED=true
`,
};

for (const [app, content] of Object.entries(apps)) {
  const path = `apps/${app}/.env`;
  if (force || !existsSync(path)) {
    writeFileSync(path, content);
    console.log(`creado ${path}`);
  } else {
    console.log(`existe ${path} (use --force para regenerar)`);
  }
}
