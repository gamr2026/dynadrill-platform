-- Normalización: los ids de catálogo y de personas pasan a ser FK reales (a `catalogos` e `identidad`) y desaparecen las copias de
-- nombre. El nombre se obtiene con JOIN. Decisión del 16/10/2026: ver documentacion/database/INVENTARIO-COPIAS-DE-NOMBRE.md.

-- Lectura de las tablas maestras (solo lo necesario; de `identidad.usuario` nunca la clave ni los datos de acceso)
GRANT USAGE ON SCHEMA catalogos, identidad TO app_operaciones;
GRANT SELECT ON catalogos.cliente, catalogos.campo, catalogos.bloque, catalogos.pozo, catalogos.taladro,
  catalogos.vehiculo, catalogos.tipo_vehiculo TO app_operaciones;
GRANT SELECT (id, nombre, email, activo, rol_id) ON identidad.usuario TO app_operaciones;
GRANT SELECT (id, codigo, nombre) ON identidad.rol TO app_operaciones;

-- Ticket: copias de nombre fuera; FK a los catálogos
ALTER TABLE "ticket"
  DROP COLUMN "cliente_nombre", DROP COLUMN "cliente_ruc",
  DROP COLUMN "campo_nombre", DROP COLUMN "bloque_nombre", DROP COLUMN "pozo_nombre", DROP COLUMN "taladro_nombre",
  ADD CONSTRAINT "ticket_cliente_id_fkey" FOREIGN KEY ("cliente_id") REFERENCES catalogos.cliente ("id"),
  ADD CONSTRAINT "ticket_campo_id_fkey" FOREIGN KEY ("campo_id") REFERENCES catalogos.campo ("id"),
  ADD CONSTRAINT "ticket_bloque_id_fkey" FOREIGN KEY ("bloque_id") REFERENCES catalogos.bloque ("id"),
  ADD CONSTRAINT "ticket_pozo_id_fkey" FOREIGN KEY ("pozo_id") REFERENCES catalogos.pozo ("id"),
  ADD CONSTRAINT "ticket_taladro_id_fkey" FOREIGN KEY ("taladro_id") REFERENCES catalogos.taladro ("id");

-- Asignación: personas y unidades por id con FK
ALTER TABLE "ticket_persona" DROP COLUMN "usuario_nombre",
  ADD CONSTRAINT "ticket_persona_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES identidad.usuario ("id"),
  ADD CONSTRAINT "ticket_persona_asignado_por_fkey" FOREIGN KEY ("asignado_por") REFERENCES identidad.usuario ("id");

ALTER TABLE "ticket_unidad" DROP COLUMN "placa", DROP COLUMN "descripcion",
  ADD CONSTRAINT "ticket_unidad_vehiculo_id_fkey" FOREIGN KEY ("vehiculo_id") REFERENCES catalogos.vehiculo ("id"),
  ADD CONSTRAINT "ticket_unidad_asignado_por_fkey" FOREIGN KEY ("asignado_por") REFERENCES identidad.usuario ("id");

-- Historial: quién lo hizo es su id (el nombre sale del JOIN); el rol con el que actuó se conserva (dato histórico)
ALTER TABLE "ticket_historial" DROP COLUMN "actor_nombre",
  ADD CONSTRAINT "ticket_historial_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES identidad.usuario ("id");
