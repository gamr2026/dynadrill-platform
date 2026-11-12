-- Valores nuevos de enums (12/11/2026). PostgreSQL no deja usar un valor en la misma migración que lo agrega: por eso van solos y las
-- migraciones siguientes (requisito exonerado, paso «anulado») ya pueden usarlos.
ALTER TYPE "fcr"."estado_requisito" ADD VALUE IF NOT EXISTS 'exonerado';
ALTER TYPE "fcr"."macro_estado" ADD VALUE IF NOT EXISTS 'anulado';
