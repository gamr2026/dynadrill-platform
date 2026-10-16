-- El código del pedido del portal lleva el prefijo PED- (como PEC- en AS2) para no confundirlo con el número de ticket /
-- prefactura (PRC- en AS2). Cambia solo cómo se formatean los códigos NUEVOS: lo ya emitido no se reescribe.
UPDATE "secuencia"
   SET "prefijo" = 'PED-', "longitud" = 10
 WHERE "documento_id" = (SELECT "id" FROM "documento" WHERE "codigo" = 'pedido');
