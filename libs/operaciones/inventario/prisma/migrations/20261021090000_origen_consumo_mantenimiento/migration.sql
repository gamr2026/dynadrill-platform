-- Origen nuevo del kardex: el repuesto que Mantenimiento usa en una sub-orden. Va solo en esta migración porque PostgreSQL no deja usar
-- un valor de enum en la misma transacción en que se agrega; la migración siguiente lo usa.
ALTER TYPE "origen_movimiento" ADD VALUE 'consumo_mantenimiento';
