-- La Inspección de Vehículos la realiza el conductor de la unidad (desde Flota), no el operador: se corrige la descripción del requisito.
UPDATE "pumping"."requisito"
   SET "descripcion" = 'El conductor de la unidad realizó la Inspección de Vehículos (DYN-SGI-RE-068) desde Flota.'
 WHERE "codigo" = 'inspeccion_vehiculo_realizada';
