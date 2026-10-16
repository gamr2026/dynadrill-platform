-- Quién creó o modificó cada registro (y quién subió o eliminó un archivo) pasa a ser FK real a `identidad.usuario`.
-- Ver documentacion/database/INVENTARIO-COPIAS-DE-NOMBRE.md.
ALTER TABLE integraciones.cambio
  ADD CONSTRAINT "cambio_realizado_por_fkey" FOREIGN KEY ("realizado_por") REFERENCES identidad.usuario ("id");
ALTER TABLE integraciones.operacion
  ADD CONSTRAINT "operacion_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id");
ALTER TABLE integraciones.proveedor
  ADD CONSTRAINT "proveedor_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id");
