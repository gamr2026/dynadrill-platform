-- Quién creó o modificó cada registro (y quién subió o eliminó un archivo) pasa a ser FK real a `identidad.usuario`.
-- Ver documentacion/database/INVENTARIO-COPIAS-DE-NOMBRE.md.
ALTER TABLE archivos.archivo
  ADD CONSTRAINT "archivo_subido_por_fkey" FOREIGN KEY ("subido_por") REFERENCES identidad.usuario ("id"),
  ADD CONSTRAINT "archivo_eliminado_por_fkey" FOREIGN KEY ("eliminado_por") REFERENCES identidad.usuario ("id");
