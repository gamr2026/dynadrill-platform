-- Auditoría de la base (26/10/2026): el evento que originó el aviso es un mensaje (outbox/inbox de otro contenedor), no una fila con FK.
COMMENT ON COLUMN "aviso"."evento_id" IS 'Id del evento que originó el aviso (llave de idempotencia); el evento vive en el outbox del contenedor que lo publicó: sin FK.';
COMMENT ON COLUMN "correo_aviso"."evento_id" IS 'Id del evento que originó el correo (llave de idempotencia); sin FK, igual que en `aviso`.';
