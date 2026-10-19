-- Corrección de negocio (18/10/2026, indicada por el usuario): el gerenciamiento de viaje de riesgo MEDIO lo autoriza el Supervisor (igual que
-- el BAJO) y el de riesgo ALTO un gerente (permiso `flota.viajes.autorizar_mayor`). La demo `main` decía otra cosa (el Supervisor solo BAJO;
-- MEDIO y ALTO el Jefe de Base), y la semilla inicial la seguía. Es un cambio de datos del catálogo: se registra aquí y se revierte con otra migración.
UPDATE "umbral_riesgo_viaje"
   SET "permiso_autoriza" = 'flota.viajes.aprobar',
       "descripcion" = 'Riesgo medio: requiere la autorización del Supervisor antes de viajar.',
       "updated_at" = CURRENT_TIMESTAMP
 WHERE "nivel" = 'medio';

UPDATE "umbral_riesgo_viaje"
   SET "permiso_autoriza" = 'flota.viajes.autorizar_mayor',
       "descripcion" = 'Riesgo alto: requiere la autorización de un gerente (Gerente HSE o Jefe de Base) y, además, el visto bueno del Director General (Quito), fuera del alcance del sistema.',
       "updated_at" = CURRENT_TIMESTAMP
 WHERE "nivel" = 'alto';
