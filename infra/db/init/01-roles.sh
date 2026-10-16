#!/bin/bash
# Crea los usuarios de base de datos (documento de BD, cap. 4.2). Solo desarrollo local:
# en Azure las credenciales viven en Key Vault.
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<EOSQL
-- Dueño de todos los schemas; solo lo usa el pipeline de migraciones.
-- CREATEDB: Prisma Migrate necesita una base "shadow" en desarrollo.
CREATE ROLE dyn_migrator LOGIN CREATEDB PASSWORD '${DYN_MIGRATOR_PASSWORD}';
CREATE ROLE dyn_lectura  LOGIN PASSWORD '${DYN_LECTURA_PASSWORD}';
CREATE ROLE app_plataforma  LOGIN PASSWORD '${APP_PLATAFORMA_PASSWORD}';
CREATE ROLE app_comercial   LOGIN PASSWORD '${APP_COMERCIAL_PASSWORD}';
CREATE ROLE app_operaciones LOGIN PASSWORD '${APP_OPERACIONES_PASSWORD}';
CREATE ROLE app_qhse        LOGIN PASSWORD '${APP_QHSE_PASSWORD}';
CREATE ROLE app_worker      LOGIN PASSWORD '${APP_WORKER_PASSWORD}';
-- Solo consulta credenciales para PgBouncer (auth_query).
CREATE ROLE pgbouncer LOGIN PASSWORD '${PGBOUNCER_AUTH_PASSWORD}';
EOSQL
