-- La demo llama al estado «OT generada» (orden de trabajo); el catálogo lo tenía como «AOT generada».
UPDATE "proceso_estado" SET "nombre" = 'OT generada' WHERE "proceso" = 'pedido' AND "codigo" = 'aot_generada';
