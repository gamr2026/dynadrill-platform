-- El texto de una versión de los términos no se cambia nunca (constancia). Lo único que se actualiza es cuál es la vigente y la validación de QHSE:
-- se concede UPDATE solo sobre esas columnas.
GRANT UPDATE ("vigente", "validado_at", "validado_por") ON "terminos_version" TO app_operaciones;
