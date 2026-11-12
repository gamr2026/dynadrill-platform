# dynadrill-platform

Backend de producción de Dynadrill: monorepo Nx con NestJS, Prisma y PostgreSQL 17.
Diseño: _Arquitectura de Backend v1.0_ y _Propuesta de Base de Datos v1.0_ (DIGITEC, 11/10/2026),
adaptados según `documentacion/database/PROPUESTA-DESARROLLO-F0-F1.md` del repo `proyectos`.

## Estructura

```
apps/      gateway · plataforma · comercial · operaciones · qhse (NestJS)  y  firmas-ocr (Python, fuera de Nx)
libs/      shared/* y <contenedor>/<modulo>/ (controllers, services, dto, repositories, prisma, index.ts)
infra/     docker-compose y SQL de inicialización (schemas, usuarios, privilegios)
```

Fronteras (verificadas por ESLint, `@nx/enforce-module-boundaries`): un módulo solo importa
de su propio contenedor (`scope:*`) y de las librerías compartidas (`type:shared`).
Entre contenedores la comunicación es por HTTP interno o eventos, nunca por import.

## Infraestructura local

```bash
cp infra/.env.example infra/.env
npm run infra:up          # postgres, pgbouncer, rabbitmq, azurite, mailpit, jaeger
npm run infra:reset       # borra volúmenes y reaplica infra/db/init/*
docker compose -f infra/docker-compose.yml --profile files up -d clamav   # antimalware (módulo de archivos)
```

| Servicio                          | Puerto host | Equivale en Azure      |
| --------------------------------- | ----------- | ---------------------- |
| PostgreSQL 17 (directo, migrator) | 5433        | PostgreSQL Flexible    |
| PgBouncer (aplicaciones)          | 6432        | PgBouncer integrado    |
| RabbitMQ (UI 15672)               | 5672        | Service Bus            |
| Azurite (Blob)                    | 10000       | Blob Storage           |
| Mailpit (UI 8025, SMTP 1025)      | 8025 / 1025 | Communication Services |
| Jaeger (UI 16686, OTLP 4317/4318) | 16686       | Application Insights   |

El 5433 evita chocar con un PostgreSQL local en 5432. Los usuarios `app_*` no pueden crear
tablas, borrar filas de negocio ni leer schemas de otro contenedor; las migraciones corren
con `dyn_migrator` directo contra Postgres.

## Primer arranque

```bash
npm install
cp infra/.env.example infra/.env && npm run infra:up
npm run dev:setup          # llaves JWT RS256 de desarrollo + apps/*/.env (no se versionan)
npm run db:migrate:todo        # aplica las migraciones de TODOS los módulos en orden global (ver «Migraciones»)
npm run db:seed:identidad      # 17 roles + superadmin (SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD de apps/plataforma/.env)
npx nx serve plataforma    # :3101  (DIAGNOSTICO_ENABLED=true expone /api/plataforma/diagnostico/*)
npx nx serve gateway       # :3100  (descomente las URL de los contenedores en apps/gateway/.env para enrutar)
npm run dev:token -- superadmin   # token de prueba para curl / Postman
```

El gateway enruta por prefijo a cada contenedor (`PLATAFORMA_URL`, `COMERCIAL_URL`, `OPERACIONES_URL`, `QHSE_URL`);
una ruta que ningún contenedor atiende, o cuyo contenedor no tiene URL en `apps/gateway/.env`, responde 404.
La demo anterior se retiró el 27/10/2026: ya no hay backend detrás del gateway.

Trazas: Jaeger en http://localhost:16686 (`gateway` y `plataforma`; el span del consumidor de un evento
cuelga de la traza HTTP que lo originó). Pruebas de integración (necesitan `infra:up`):
`npm run test:integration`.

## Migraciones

Cada módulo tiene su schema de PostgreSQL, su `schema.prisma` y su historial independiente en
`libs/<contenedor>/<modulo>/prisma/migrations`. Hay claves foráneas entre schemas (aceptadas a propósito; ver
`infra/db/init/02-schemas.sql`), por eso **una base nueva no se arma módulo por módulo**: hay que aplicar todo en un único orden
global por timestamp.

```bash
npm run db:migrate:plan     # plan ordenado y migraciones pendientes; no cambia nada (--dry-run)
npm run db:migrate:todo     # aplica las pendientes en orden global (scripts/migrar-todo.mjs --aplicar)
npm run db:migrate:<modulo> # prisma migrate deploy de un solo módulo (base que ya tiene el resto al día)
npm run db:verificar        # falla si Prisma propondría borrar algo que vive solo en SQL
```

`db:migrate:todo` ejecuta el SQL de cada migración y la registra en `<schema>._prisma_migrations` igual que Prisma, así que
`prisma migrate status` de cada módulo sigue siendo válido. Rechaza bases cuyo nombre no termine en `_test` salvo con
`--confirmar-desarrollo`; `--url` o `DATABASE_URL_MIGRATOR` eligen el destino (por defecto, la base de desarrollo de `infra/.env`).

Las migraciones se escriben a mano. **Nunca `prisma migrate dev`** ni aplicar un diff generado sin revisar
[`docs/restricciones-solo-sql.md`](docs/restricciones-solo-sql.md): índices únicos parciales, CHECK, triggers y varias FK entre
schemas existen solo en SQL y Prisma los borraría. `npm run db:verificar` (solo lee; necesita una base migrada) lo comprueba contra
`docs/restricciones-solo-sql.permitidas.json`.

## Comandos

```bash
npm run build | lint | test       # todos los proyectos
npx nx serve gateway
npx nx graph                      # grafo de dependencias
```

Commits convencionales (`feat:`, `fix:`, `chore:`…), validados con commitlint.
