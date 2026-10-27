-- El aviso del límite de almacenamiento y del certificado de disposición ahora lo emite también la revisión automática de avisos por vencimiento,
-- que no actúa una persona: en ese caso el aviso no tiene quien lo disparó.
ALTER TABLE "desecho_aviso" ALTER COLUMN "emitido_por" DROP NOT NULL;
COMMENT ON COLUMN "desecho_aviso"."emitido_por" IS 'Quien disparó la revisión que emitió el aviso; vacío cuando lo emitió la revisión automática.';
