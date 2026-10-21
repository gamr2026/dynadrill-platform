-- D9 (21/10/2026): QHSE valida el texto de los términos y condiciones. Una versión sin validar es un borrador (la v1 viene de la demo).
-- Las aceptaciones ya hechas no cambian (son constancia inmutable de la versión que se leyó).
ALTER TABLE "terminos_version" ADD COLUMN "validado_at" TIMESTAMPTZ(6), ADD COLUMN "validado_por" UUID;
ALTER TABLE "terminos_version" ADD CONSTRAINT "terminos_version_validado_por_fkey" FOREIGN KEY ("validado_por") REFERENCES identidad.usuario ("id");
ALTER TABLE "terminos_version" ADD CONSTRAINT "terminos_version_validado_check" CHECK (("validado_at" IS NULL) = ("validado_por" IS NULL));
COMMENT ON COLUMN "terminos_version"."validado_at" IS 'Cuándo QHSE validó el texto; nulo = borrador sin validar.';
