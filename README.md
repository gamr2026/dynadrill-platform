# dynadrill-platform

Backend de producción de Dynadrill: monorepo Nx con NestJS, Prisma y PostgreSQL 17.
Diseño: _Arquitectura de Backend v1.0_ y _Propuesta de Base de Datos v1.0_ (DIGITEC, 11/10/2026),
adaptados según `documentacion/database/PROPUESTA-DESARROLLO-F0-F1.md` del repo `proyectos`.

## Estructura

```
apps/      gateway · plataforma  (comercial, operaciones y qhse se agregan en sus fases)
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
npm run db:migrate:identidad   # aplica las migraciones del módulo (como dyn_migrator, schema identidad)
npm run db:seed:identidad      # 17 roles + superadmin (SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD de apps/plataforma/.env)
npm run db:migrate-demo:identidad   # TRANSICIÓN: trae los usuarios de la demo (SQLite) con su id viejo como legacy_id
npx nx serve plataforma    # :3101  (DIAGNOSTICO_ENABLED=true expone /api/plataforma/diagnostico/*)
npx nx serve gateway       # :3100  (descomente PLATAFORMA_URL en apps/gateway/.env para enrutar a la plataforma)
npm run dev:token -- superadmin   # token de prueba para curl / Postman
```

El gateway manda a `demo-legacy` (`LEGACY_URL`, el backend actual) todo lo que ningún contenedor nuevo
atienda; un contenedor sin URL en `apps/gateway/.env` no recibe tráfico. Cada módulo se conmuta
agregando su URL cuando supera su criterio de salida.

Trazas: Jaeger en http://localhost:16686 (`gateway` y `plataforma`; el span del consumidor de un evento
cuelga de la traza HTTP que lo originó). Pruebas de integración (necesitan `infra:up`):
`npm run test:integration`.

## Comandos

```bash
npm run build | lint | test       # todos los proyectos
npx nx serve gateway
npx nx graph                      # grafo de dependencias
```

Commits convencionales (`feat:`, `fix:`, `chore:`…), validados con commitlint.
