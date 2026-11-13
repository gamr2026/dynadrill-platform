-- "Documentos completos" deja de ser un paso manual del pedido: ya ocurre solo cuando la documentación queda completa (o al generar la
-- prefactura). Sin permiso, la transición no se ofrece como acción (`siguientes`) ni se acepta a mano; el sistema la sigue aplicando
-- (origen "automático" no consulta el permiso). Solo se actualizan las transiciones cuyo destino es ese estado.
UPDATE "proceso_transicion"
SET "permiso" = NULL
WHERE "proceso" = 'pedido'
  AND "estado_destino" = 'documentos_completos'
  AND "permiso" IS NOT NULL;
