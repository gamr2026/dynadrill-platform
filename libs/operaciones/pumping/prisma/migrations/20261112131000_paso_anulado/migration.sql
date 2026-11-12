-- Paso terminal `anulado`: el ticket llega aquí cuando Comercial anula su pedido (consumidor de `comercial.pedido.anulado`), desde cualquier paso
-- que no sea terminal. No hay filas en `transicion`: la anulación no la pide nadie desde la pantalla (`avanzar` solo recorre transiciones), la hace
-- el sistema, y la base de datos no valida los pasos con disparadores, así que tampoco hay excepción que agregar. Sin filas en `paso_rol`: ningún rol
-- «atiende» un ticket anulado. Al ser terminal deja de contar como ocupado al personal (la disponibilidad solo mira tickets de pasos no terminales).
-- Los pasos también los siembra `sembrarPasos` (idempotente); aquí se inserta para que las bases ya sembradas lo tengan sin volver a sembrar.
INSERT INTO "pumping"."paso" ("codigo", "nombre", "macro", "orden", "terminal", "activo")
VALUES ('anulado', 'Anulado', 'anulado', 110, true, true)
ON CONFLICT ("codigo") DO NOTHING;
