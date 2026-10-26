-- Auditoría de la base (26/10/2026): identificador externo, no una referencia a otra tabla.
COMMENT ON COLUMN "usuario"."entra_object_id" IS 'Identificador de la cuenta en Microsoft Entra ID (sistema externo): uuid sin FK.';
