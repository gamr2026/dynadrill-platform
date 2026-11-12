-- El Acta de Entrega de Locación la carga QHSE: su responsable es el Gerente HSE (`gerente_hse`).
UPDATE "fcr"."requisito" SET "rol_responsable" = 'gerente_hse'
 WHERE "codigo" = 'acta_entrega_locacion'
   AND EXISTS (SELECT 1 FROM identidad.rol WHERE "codigo" = 'gerente_hse');
