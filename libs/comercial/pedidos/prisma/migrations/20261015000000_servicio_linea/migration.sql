-- Catálogo de líneas de servicio: la línea deja de ser un texto repetido en cada tipo y en cada pedido.
CREATE TABLE "servicio_linea" (
    "codigo" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "orden" INTEGER NOT NULL DEFAULT 0,
    "activo" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "servicio_linea_pkey" PRIMARY KEY ("codigo")
);

-- Las dos líneas que ya existían (las claves foráneas de abajo las necesitan; la siembra completa el resto).
INSERT INTO "servicio_linea" ("codigo", "nombre", "orden") VALUES ('fcr', 'FCR', 0), ('pumping', 'Pumping', 1);

-- Ya no se valida con listas fijas: la clave foránea es la regla.
ALTER TABLE "pedido" DROP CONSTRAINT "pedido_linea_check";
ALTER TABLE "servicio_tipo" DROP CONSTRAINT "servicio_tipo_linea_check";

ALTER TABLE "servicio_tipo" ADD CONSTRAINT "servicio_tipo_linea_servicio_fkey"
  FOREIGN KEY ("linea_servicio") REFERENCES "servicio_linea"("codigo") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pedido" ADD CONSTRAINT "pedido_linea_servicio_fkey"
  FOREIGN KEY ("linea_servicio") REFERENCES "servicio_linea"("codigo") ON DELETE RESTRICT ON UPDATE CASCADE;

COMMENT ON TABLE "servicio_linea" IS 'Catálogo de líneas de servicio; cada una tiene sus tipos de servicio.';
