-- Auditoría de la base (26/10/2026): borrar un padre arrastraba en cascada historia que la aplicación no puede borrar directamente. La aceptación
-- de términos (constancia legal) y el reporte de unidad (firmado) dependían de la asignación de la persona o de la unidad: reasignar el ticket
-- los habría borrado. Ahora la asignación con registros firmados no se puede reemplazar (RESTRICT); el servicio lo avisa antes con un 409.
ALTER TABLE "aceptacion_terminos" DROP CONSTRAINT "aceptacion_terminos_persona_fkey";
ALTER TABLE "aceptacion_terminos" ADD CONSTRAINT "aceptacion_terminos_persona_fkey"
  FOREIGN KEY ("ticket_id", "usuario_id") REFERENCES "ticket_persona" ("ticket_id", "usuario_id") ON DELETE RESTRICT;

ALTER TABLE "reporte_unidad" DROP CONSTRAINT "reporte_unidad_unidad_fkey";
ALTER TABLE "reporte_unidad" ADD CONSTRAINT "reporte_unidad_unidad_fkey"
  FOREIGN KEY ("ticket_id", "unidad_id") REFERENCES "ticket_unidad" ("ticket_id", "unidad_id") ON DELETE RESTRICT;

-- La historia del ticket es inmutable (en FCR ya lo era): la aplicación solo agrega.
REVOKE UPDATE, DELETE ON "ticket_historial" FROM app_operaciones;
COMMENT ON TABLE "ticket_historial" IS 'Cada cambio de paso del ticket con quién lo hizo. Inmutable: la aplicación solo agrega.';
