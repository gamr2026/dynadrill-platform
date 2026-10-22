-- 20 schemas: los 19 del modelo de datos v1 (Propuesta de Base de Datos, cap. 4) más `integraciones` (13/10/2026).
-- Cada módulo es dueño de su schema; sin FK entre schemas.

REVOKE CREATE ON SCHEMA public FROM PUBLIC;

CREATE SCHEMA identidad       AUTHORIZATION dyn_migrator;
CREATE SCHEMA catalogos       AUTHORIZATION dyn_migrator;
CREATE SCHEMA integraciones   AUTHORIZATION dyn_migrator;
CREATE SCHEMA archivos        AUTHORIZATION dyn_migrator;
CREATE SCHEMA firmas          AUTHORIZATION dyn_migrator;
CREATE SCHEMA auditoria       AUTHORIZATION dyn_migrator;
CREATE SCHEMA avisos          AUTHORIZATION dyn_migrator;
CREATE SCHEMA comercial       AUTHORIZATION dyn_migrator;
CREATE SCHEMA inventario      AUTHORIZATION dyn_migrator;
CREATE SCHEMA fcr             AUTHORIZATION dyn_migrator;
CREATE SCHEMA pumping         AUTHORIZATION dyn_migrator;
CREATE SCHEMA flota           AUTHORIZATION dyn_migrator;
CREATE SCHEMA mantenimiento   AUTHORIZATION dyn_migrator;
CREATE SCHEMA qhse            AUTHORIZATION dyn_migrator;
CREATE SCHEMA reporting       AUTHORIZATION dyn_migrator;
CREATE SCHEMA msg_plataforma  AUTHORIZATION dyn_migrator;
CREATE SCHEMA msg_comercial   AUTHORIZATION dyn_migrator;
CREATE SCHEMA msg_operaciones AUTHORIZATION dyn_migrator;
CREATE SCHEMA msg_qhse        AUTHORIZATION dyn_migrator;
CREATE SCHEMA msg_worker      AUTHORIZATION dyn_migrator;

COMMENT ON SCHEMA identidad       IS 'Usuarios, roles y sesiones';
COMMENT ON SCHEMA catalogos       IS 'Datos maestros compartidos: clientes, contactos y ubicaciones operativas';
COMMENT ON SCHEMA integraciones   IS 'Registro de integraciones con terceros (AS2...): proveedores, operaciones, mapeos y bitácora';
COMMENT ON SCHEMA archivos        IS 'Metadatos de archivos guardados en Blob Storage';
COMMENT ON SCHEMA firmas          IS 'Firmas como evidencia, con hash del documento firmado';
COMMENT ON SCHEMA auditoria       IS 'Registro inmutable de eventos de negocio y línea de tiempo';
COMMENT ON SCHEMA avisos          IS 'Avisos dentro de la aplicación';
COMMENT ON SCHEMA comercial       IS 'Ciclo comercial: Pedido, documentos operativos, prefactura, guía y AOT';
COMMENT ON SCHEMA inventario      IS 'Artículos, kardex y despachos de bodega';
COMMENT ON SCHEMA fcr             IS 'Tickets FCR (Fishing, Completion & Remedial)';
COMMENT ON SCHEMA pumping         IS 'Tickets de Pumping (bombeo) y sus registros de campo';
COMMENT ON SCHEMA flota           IS 'Unidades, conductores, inspecciones vehiculares y Gerenciamiento de Viaje';
COMMENT ON SCHEMA mantenimiento   IS 'Reportes de unidad, órdenes y sub-órdenes de mantenimiento';
COMMENT ON SCHEMA qhse            IS 'Calidad, salud, seguridad y ambiente';
COMMENT ON SCHEMA reporting       IS 'Proyecciones de lectura para indicadores (las escribe el worker)';
COMMENT ON SCHEMA msg_plataforma  IS 'Outbox e inbox del contenedor plataforma';
COMMENT ON SCHEMA msg_comercial   IS 'Outbox e inbox del contenedor comercial';
COMMENT ON SCHEMA msg_operaciones IS 'Outbox e inbox del contenedor operaciones';
COMMENT ON SCHEMA msg_qhse        IS 'Outbox e inbox del contenedor qhse';
COMMENT ON SCHEMA msg_worker      IS 'Outbox e inbox del contenedor worker';

-- Privilegios por contenedor (documento de BD, cap. 7.1).
--  * Tablas de negocio: SELECT, INSERT, UPDATE. Sin DELETE: los documentos se anulan, no se borran.
--    Si una tabla de detalle necesita DELETE se concede explícitamente en su migración.
--  * msg_*: además DELETE (limpieza de outbox/inbox ya procesados).
--  * auditoria: solo SELECT e INSERT.
-- Las tablas las crea dyn_migrator, por eso se fijan DEFAULT PRIVILEGES además de los GRANT actuales.
DO $$
DECLARE
  g record;
  s text;
BEGIN
  FOR g IN
    SELECT * FROM (VALUES
      ('app_plataforma',  ARRAY['identidad','catalogos','integraciones','archivos','firmas','avisos'], 'SELECT, INSERT, UPDATE'),
      ('app_plataforma',  ARRAY['msg_plataforma'],                                      'SELECT, INSERT, UPDATE, DELETE'),
      ('app_plataforma',  ARRAY['auditoria'],                                           'SELECT, INSERT'),
      ('app_comercial',   ARRAY['comercial'],                                           'SELECT, INSERT, UPDATE'),
      ('app_comercial',   ARRAY['msg_comercial'],                                       'SELECT, INSERT, UPDATE, DELETE'),
      ('app_operaciones', ARRAY['fcr','pumping','flota','mantenimiento','inventario'], 'SELECT, INSERT, UPDATE'),
      ('app_operaciones', ARRAY['msg_operaciones'],                                    'SELECT, INSERT, UPDATE, DELETE'),
      ('app_qhse',        ARRAY['qhse'],                                               'SELECT, INSERT, UPDATE'),
      ('app_qhse',        ARRAY['msg_qhse'],                                           'SELECT, INSERT, UPDATE, DELETE'),
      ('app_worker',      ARRAY['reporting','msg_worker'],                             'SELECT, INSERT, UPDATE, DELETE'),
      ('dyn_lectura',     ARRAY['reporting'],                                          'SELECT')
    ) AS t(rol, schemas, privilegios)
  LOOP
    FOREACH s IN ARRAY g.schemas LOOP
      EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I', s, g.rol);
      EXECUTE format('GRANT %s ON ALL TABLES IN SCHEMA %I TO %I', g.privilegios, s, g.rol);
      EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE dyn_migrator IN SCHEMA %I GRANT %s ON TABLES TO %I',
                     s, g.privilegios, g.rol);
      IF g.privilegios <> 'SELECT' THEN
        EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO %I', s, g.rol);
        EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE dyn_migrator IN SCHEMA %I GRANT USAGE, SELECT ON SEQUENCES TO %I',
                       s, g.rol);
      END IF;
    END LOOP;
  END LOOP;
END
$$;

-- encuestas (24/10/2026, plataforma): schema creado después de los 20 originales. No está en la lista de privilegios de arriba:
-- su primera migración concede a app_plataforma lo que necesita (SELECT, INSERT, UPDATE y los REVOKE de lo inmutable).
CREATE SCHEMA encuestas AUTHORIZATION dyn_migrator;
COMMENT ON SCHEMA encuestas IS 'Encuestas (plantillas versionadas, invitaciones y respuestas), administradas por el Superadmin';
