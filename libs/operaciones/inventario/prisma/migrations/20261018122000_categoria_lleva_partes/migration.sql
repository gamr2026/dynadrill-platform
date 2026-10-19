-- Las herramientas de la categoría llevan lista de partes (componentes); así la pantalla y FCR no dependen del texto del nombre.
ALTER TABLE "categoria_articulo" ADD COLUMN "lleva_partes" BOOLEAN NOT NULL DEFAULT false;
COMMENT ON COLUMN "categoria_articulo"."lleva_partes" IS 'Los artículos de la categoría son herramientas con lista de partes.';
UPDATE "categoria_articulo" SET "lleva_partes" = true WHERE "nombre" = 'FISHING & TOOLS';
