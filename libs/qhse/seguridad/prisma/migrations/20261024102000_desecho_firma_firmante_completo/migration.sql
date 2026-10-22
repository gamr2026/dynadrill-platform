-- Corrección de desecho_firma_firmante_check (migración 20261024101000): con nombre o cédula en NULL, `length(btrim(NULL)) > 0` da NULL y un CHECK
-- que da NULL se acepta, de modo que el transportista o el gestor podían firmar sin identificarse. Se vuelve explícito: quien firma en papel trae
-- nombre y cédula con texto.
ALTER TABLE "desecho_firma" DROP CONSTRAINT "desecho_firma_firmante_check";
ALTER TABLE "desecho_firma" ADD CONSTRAINT "desecho_firma_firmante_check" CHECK (
  ("rol" = 'despachado_por' AND "firmante_nombre" IS NULL AND "firmante_cedula" IS NULL)
  OR ("rol" <> 'despachado_por'
      AND "firmante_nombre" IS NOT NULL AND length(btrim("firmante_nombre")) > 0
      AND "firmante_cedula" IS NOT NULL AND length(btrim("firmante_cedula")) > 0));
