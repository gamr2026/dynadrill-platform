-- Los consumidores de despachos comprueban que el archivo de respaldo existe antes de guardarlo (solo el id; el resto lo administra archivos).
GRANT USAGE ON SCHEMA archivos TO app_operaciones;
GRANT SELECT (id) ON archivos.archivo TO app_operaciones;
