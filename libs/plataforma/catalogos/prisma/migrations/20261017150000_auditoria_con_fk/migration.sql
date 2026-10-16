-- Quién creó o modificó cada registro (y quién subió o eliminó un archivo) pasa a ser FK real a `identidad.usuario`.
-- Ver documentacion/database/INVENTARIO-COPIAS-DE-NOMBRE.md.
ALTER TABLE catalogos.bloque
  ADD CONSTRAINT "bloque_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
  ADD CONSTRAINT "bloque_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id");

ALTER TABLE catalogos.bodega
  ADD CONSTRAINT "bodega_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
  ADD CONSTRAINT "bodega_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id");

ALTER TABLE catalogos.campo
  ADD CONSTRAINT "campo_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
  ADD CONSTRAINT "campo_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id");

ALTER TABLE catalogos.chofer
  ADD CONSTRAINT "chofer_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
  ADD CONSTRAINT "chofer_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id");

ALTER TABLE catalogos.cliente
  ADD CONSTRAINT "cliente_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
  ADD CONSTRAINT "cliente_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id");

ALTER TABLE catalogos.condicion_pago
  ADD CONSTRAINT "condicion_pago_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
  ADD CONSTRAINT "condicion_pago_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id");

ALTER TABLE catalogos.persona_contacto
  ADD CONSTRAINT "persona_contacto_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
  ADD CONSTRAINT "persona_contacto_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id");

ALTER TABLE catalogos.pozo
  ADD CONSTRAINT "pozo_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
  ADD CONSTRAINT "pozo_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id");

ALTER TABLE catalogos.taladro
  ADD CONSTRAINT "taladro_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
  ADD CONSTRAINT "taladro_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id");

ALTER TABLE catalogos.tipo_vehiculo
  ADD CONSTRAINT "tipo_vehiculo_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
  ADD CONSTRAINT "tipo_vehiculo_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id");

ALTER TABLE catalogos.transportista
  ADD CONSTRAINT "transportista_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
  ADD CONSTRAINT "transportista_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id");

ALTER TABLE catalogos.vehiculo
  ADD CONSTRAINT "vehiculo_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
  ADD CONSTRAINT "vehiculo_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id");

ALTER TABLE catalogos.zona
  ADD CONSTRAINT "zona_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
  ADD CONSTRAINT "zona_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id");
