-- Responsable de los requisitos de documentación QHSE: el Gerente HSE (`gerente_hse`), confirmado por el dueño del producto.
-- Quedan sin responsable (NULL) el gerenciamiento de viaje y la aprobación de la inspección: quién autoriza una jornada depende de su nivel de riesgo.
UPDATE "pumping"."requisito" SET "rol_responsable" = 'gerente_hse'
 WHERE "codigo" IN ('ptw_dia_aprobado', 'pt_dia_cargado', 'art_vigente', 'sin_swa_dia', 'swa_sin_activar',
                    'ptw_primer_dia_abierto', 'epi_despachado', 'acta_entrega_locacion');
