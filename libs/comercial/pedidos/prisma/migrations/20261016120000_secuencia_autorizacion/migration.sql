-- Número de autorización del SRI de la secuencia (la guía de remisión lo imprime con su fecha de autorización y caducidad).
ALTER TABLE "secuencia" ADD COLUMN "autorizacion_numero" TEXT;
