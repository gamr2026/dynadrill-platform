-- Exoneración de requisitos: un requisito pendiente puede exonerarse (con motivo) y entonces deja de bloquear. El valor nuevo del enum va solo en esta
-- migración porque PostgreSQL no permite usarlo en la misma transacción en que se agrega; la siguiente lo usa.
ALTER TYPE "pumping"."estado_requisito" ADD VALUE IF NOT EXISTS 'exonerado';
