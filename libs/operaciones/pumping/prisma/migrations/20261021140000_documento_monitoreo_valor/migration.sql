-- Tipo nuevo de documento del ticket: el monitoreo de un día de operación. Va solo en esta migración porque PostgreSQL no deja usar un
-- valor de enum en la misma transacción en que se agrega; la siguiente lo usa.
ALTER TYPE "tipo_documento_ticket" ADD VALUE 'monitoreo';
