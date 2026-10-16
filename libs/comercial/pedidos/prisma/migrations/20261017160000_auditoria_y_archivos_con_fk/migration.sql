-- Quién creó o modificó cada registro (y quién subió o eliminó un archivo) pasa a ser FK real a `identidad.usuario`.
-- Ver documentacion/database/INVENTARIO-COPIAS-DE-NOMBRE.md.

-- Lectura de los datos del archivo (solo lo necesario; nunca la clave del blob ni el hash)
GRANT USAGE ON SCHEMA archivos TO app_comercial;
GRANT SELECT (id, nombre_original, mime_type, tamano_bytes, subido_por) ON archivos.archivo TO app_comercial;

ALTER TABLE comercial.lista_precios
  ADD CONSTRAINT "lista_precios_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
  ADD CONSTRAINT "lista_precios_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id");
ALTER TABLE comercial.pedido
  ADD CONSTRAINT "pedido_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
  ADD CONSTRAINT "pedido_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id");

-- Los adjuntos y los archivos firmados apuntan al archivo con FK; su nombre, tipo, tamaño y quién lo subió salen del JOIN
ALTER TABLE "pedido_documento" DROP COLUMN "nombre", DROP COLUMN "mime_type", DROP COLUMN "tamano_bytes", DROP COLUMN "subido_por",
  ADD CONSTRAINT "pedido_documento_archivo_id_fkey" FOREIGN KEY ("archivo_id") REFERENCES archivos.archivo ("id");
ALTER TABLE "prefactura_firma" DROP COLUMN "archivo_nombre",
  ADD CONSTRAINT "prefactura_firma_archivo_id_fkey" FOREIGN KEY ("archivo_id") REFERENCES archivos.archivo ("id");
ALTER TABLE "guia_remision" DROP COLUMN "archivo_firmado_nombre",
  ADD CONSTRAINT "guia_remision_archivo_firmado_id_fkey" FOREIGN KEY ("archivo_firmado_id") REFERENCES archivos.archivo ("id");
ALTER TABLE "orden_trabajo" DROP COLUMN "archivo_firmado_nombre",
  ADD CONSTRAINT "orden_trabajo_archivo_firmado_id_fkey" FOREIGN KEY ("archivo_firmado_id") REFERENCES archivos.archivo ("id");
