-- Versión firmada de cualquier documento del expediente del pedido (no solo monitoreo y mezcla). Los valores nuevos del enum van solos en
-- esta migración: la siguiente ya puede usarlos. Cada valor es el `tipo` que el índice del expediente da al documento.
ALTER TYPE "tipo_documento_respaldo" ADD VALUE IF NOT EXISTS 'reporte_job';
ALTER TYPE "tipo_documento_respaldo" ADD VALUE IF NOT EXISTS 'reporte_herramientas';
ALTER TYPE "tipo_documento_respaldo" ADD VALUE IF NOT EXISTS 'reporte_unidad';
ALTER TYPE "tipo_documento_respaldo" ADD VALUE IF NOT EXISTS 'prefactura';
ALTER TYPE "tipo_documento_respaldo" ADD VALUE IF NOT EXISTS 'guia_remision';
ALTER TYPE "tipo_documento_respaldo" ADD VALUE IF NOT EXISTS 'orden_trabajo';
ALTER TYPE "tipo_documento_respaldo" ADD VALUE IF NOT EXISTS 'qhse_formato_recepcion';
ALTER TYPE "tipo_documento_respaldo" ADD VALUE IF NOT EXISTS 'qhse_art';
ALTER TYPE "tipo_documento_respaldo" ADD VALUE IF NOT EXISTS 'qhse_pt';
ALTER TYPE "tipo_documento_respaldo" ADD VALUE IF NOT EXISTS 'qhse_sfi';
ALTER TYPE "tipo_documento_respaldo" ADD VALUE IF NOT EXISTS 'qhse_formato_entrega';
ALTER TYPE "tipo_documento_respaldo" ADD VALUE IF NOT EXISTS 'fcr_formulario_inspeccion_externo';
ALTER TYPE "tipo_documento_respaldo" ADD VALUE IF NOT EXISTS 'fcr_formato_dimensionamiento_servicio';
ALTER TYPE "tipo_documento_respaldo" ADD VALUE IF NOT EXISTS 'fcr_formato_dureza_servicio';
ALTER TYPE "tipo_documento_respaldo" ADD VALUE IF NOT EXISTS 'fcr_documento_inspeccion';
ALTER TYPE "tipo_documento_respaldo" ADD VALUE IF NOT EXISTS 'fcr_registro_dureza';
ALTER TYPE "tipo_documento_respaldo" ADD VALUE IF NOT EXISTS 'fcr_registro_qaqc';
ALTER TYPE "tipo_documento_respaldo" ADD VALUE IF NOT EXISTS 'inspeccion_vehiculo';
ALTER TYPE "tipo_documento_respaldo" ADD VALUE IF NOT EXISTS 'gerenciamiento_viaje';
ALTER TYPE "tipo_documento_respaldo" ADD VALUE IF NOT EXISTS 'orden_mantenimiento_general';
ALTER TYPE "tipo_documento_respaldo" ADD VALUE IF NOT EXISTS 'orden_mantenimiento_operativa';
ALTER TYPE "tipo_documento_respaldo" ADD VALUE IF NOT EXISTS 'informe_mantenimiento';
ALTER TYPE "tipo_documento_respaldo" ADD VALUE IF NOT EXISTS 'adjunto';
