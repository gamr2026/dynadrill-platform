-- Los desechos se registran en galones (`desecho_item.cantidad_galones`); la demo los mostraba como «kg». El indicador del tablero HSE se mide en galones.
UPDATE "kpi_indicador" SET "unidad" = 'galones' WHERE "codigo" = 'desechos_peligrosos_kg_mes';
