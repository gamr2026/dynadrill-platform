-- Quién creó o modificó cada registro (y quién subió o eliminó un archivo) pasa a ser FK real a `identidad.usuario`.
-- Ver documentacion/database/INVENTARIO-COPIAS-DE-NOMBRE.md.
ALTER TABLE identidad.usuario
  ADD CONSTRAINT "usuario_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
  ADD CONSTRAINT "usuario_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id");
ALTER TABLE identidad.sincronizacion_as2
  ADD CONSTRAINT "sincronizacion_as2_disparada_por_fkey" FOREIGN KEY ("disparada_por") REFERENCES identidad.usuario ("id");
