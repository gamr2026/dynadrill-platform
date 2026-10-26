-- FL-4 (PARIDAD-MODELO-DEMO.md): el permiso que autoriza cada nivel de riesgo del viaje era el código de un permiso sin FK; pasa a ser FK
-- a `identidad.permiso(codigo)` (las FK a identidad están permitidas). Los permisos del sistema se siembran antes que los umbrales.
ALTER TABLE "umbral_riesgo_viaje"
  ADD CONSTRAINT "umbral_riesgo_viaje_permiso_autoriza_fkey" FOREIGN KEY ("permiso_autoriza") REFERENCES identidad.permiso ("codigo");
COMMENT ON COLUMN "umbral_riesgo_viaje"."permiso_autoriza" IS 'Código del permiso (identidad.permiso) que autoriza los viajes de este nivel.';
