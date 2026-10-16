-- TRANSICIÓN (patrón expand/contract): id numérico que cada rol y usuario tenía en el backend demo.
-- Los módulos que aún no se migran siguen usando esos ids; el gateway los traduce al token de la demo.
-- Se elimina (migración "contract") cuando el último módulo viejo pase al backend nuevo.
ALTER TABLE "rol" ADD COLUMN "legacy_id" INTEGER;
ALTER TABLE "usuario" ADD COLUMN "legacy_id" INTEGER;

CREATE UNIQUE INDEX "rol_legacy_id_key" ON "rol"("legacy_id");
CREATE UNIQUE INDEX "usuario_legacy_id_key" ON "usuario"("legacy_id");

COMMENT ON COLUMN "rol"."legacy_id" IS 'TRANSICIÓN: id del rol en el backend demo (se elimina al terminar la migración).';
COMMENT ON COLUMN "usuario"."legacy_id" IS 'TRANSICIÓN: id del usuario en el backend demo (se elimina al terminar la migración).';
