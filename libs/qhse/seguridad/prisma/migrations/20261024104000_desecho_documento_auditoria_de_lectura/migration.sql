-- Corrección de privilegios de desecho_documento (migración 20261024103000): al guardar el resultado de la lectura de firma, Prisma también
-- actualiza `updated_at` (y quien lo hace, `updated_by`), que no estaban permitidos; el error quedaba oculto porque la lectura nunca debe
-- interrumpir la carga. Lo demás del documento (archivo, tipo, fecha de emisión) sigue sin poder cambiarse.
GRANT UPDATE ("updated_at", "updated_by") ON "desecho_documento" TO app_qhse;
