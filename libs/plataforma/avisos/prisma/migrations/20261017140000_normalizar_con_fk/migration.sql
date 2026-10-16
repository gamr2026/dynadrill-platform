-- Normalización: el aviso y la bitácora de correos apuntan a la cuenta con FK a `identidad.usuario`; el nombre y el correo de la
-- persona salen del JOIN (ya no se copian). Decisión del 16/10/2026: ver documentacion/database/INVENTARIO-COPIAS-DE-NOMBRE.md.
ALTER TABLE "correo_aviso" ADD COLUMN "usuario_id" UUID;

-- lo ya registrado se enlaza por el correo de la cuenta
UPDATE "correo_aviso" c SET "usuario_id" = u."id"
  FROM identidad.usuario u WHERE lower(u."email") = lower(c."destinatario_correo");

ALTER TABLE "correo_aviso" DROP COLUMN "destinatario_nombre", DROP COLUMN "destinatario_correo",
  ADD CONSTRAINT "correo_aviso_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES identidad.usuario ("id");
CREATE INDEX "correo_aviso_usuario_id_idx" ON "correo_aviso" ("usuario_id");

ALTER TABLE "aviso"
  ADD CONSTRAINT "aviso_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES identidad.usuario ("id");
