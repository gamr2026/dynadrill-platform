-- Auditoría de la base (26/10/2026): el nombre de un criterio de inspección no se repite dentro de su tipo (sin mayúsculas ni espacios sobrantes).
CREATE UNIQUE INDEX "inspeccion_criterio_tipo_nombre_key" ON "qhse"."inspeccion_criterio" ("tipo_id", lower(btrim("nombre")));
