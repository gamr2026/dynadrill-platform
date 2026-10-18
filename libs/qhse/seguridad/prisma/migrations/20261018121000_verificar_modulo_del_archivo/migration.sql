-- QHSE: al enlazar un archivo a un documento se comprueba que lo subió el módulo correcto (qhse_acta_entrega o qhse_documento_pedido) y
-- que no fue eliminado; si no, cualquiera podría enlazar un archivo ajeno por su id. Lectura mínima de `archivos`.
GRANT SELECT (modulo_id, eliminado_at) ON archivos.archivo TO app_qhse;
GRANT SELECT (id, codigo) ON archivos.modulo_archivo TO app_qhse;
