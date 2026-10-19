-- F3: inspección y reparación de herramientas (una por herramienta del ticket, con las partes del artículo, resultado visual y por END,
-- cambio de elemento y tres firmas), documentos del ticket y las transiciones que solo se hacen por una acción propia (asignar, aprobar y
-- rechazar). Aplica a la entrada SERVICIOS. Formato de origen: «Inspeccion y reparacion de herramientas» (documentacion/fcr).

CREATE TYPE "estado_inspeccion" AS ENUM ('borrador', 'enviada', 'aprobada', 'rechazada');
CREATE TYPE "responsable_trabajo" AS ENUM ('dynadrill', 'proveedor_externo');
CREATE TYPE "resultado_parte" AS ENUM ('ok', 'defectuoso');
CREATE TYPE "rol_firma_inspeccion" AS ENUM ('reparado_por', 'revisado_por', 'liberado_qhse');
CREATE TYPE "campo_documento_fcr" AS ENUM (
  'formulario_inspeccion_externo', 'formato_dimensionamiento_servicio', 'formato_dureza_servicio',
  'documento_inspeccion', 'registro_dureza', 'registro_qaqc'
);

-- Lectura mínima de `archivos`: comprobar que el documento lo subió el módulo correcto y que no fue eliminado
GRANT USAGE ON SCHEMA archivos TO app_operaciones;
GRANT SELECT (id, modulo_id, eliminado_at) ON archivos.archivo TO app_operaciones;
GRANT SELECT (id, codigo) ON archivos.modulo_archivo TO app_operaciones;

-- ---------------------------------------------------------------------------------------------------------------
-- Transiciones que solo se hacen por una acción propia, y el rastro de pasos válido en la base
-- ---------------------------------------------------------------------------------------------------------------
ALTER TABLE "transicion" ADD COLUMN "solo_por_accion" BOOLEAN NOT NULL DEFAULT false;
COMMENT ON COLUMN "transicion"."solo_por_accion" IS 'Verdadero: el cambio de paso lo hace una acción propia (asignar, aprobar o rechazar la inspección), que además guarda lo suyo; el avance genérico no la ofrece.';
UPDATE "transicion" SET "solo_por_accion" = true WHERE ("origen_codigo", "destino_codigo") IN (
  ('aprobacion_supervisor_operaciones', 'preparacion_herramientas'), ('aprobacion_supervisor_operaciones', 'inspeccion')
);
-- la asignación (asignacion → reunion_operativa) la hace el servicio de asignación: ahora también consta como transición
INSERT INTO "transicion" ("id", "origen_codigo", "destino_codigo", "solo_por_accion")
VALUES (gen_random_uuid(), 'asignacion', 'reunion_operativa', true)
ON CONFLICT ("origen_codigo", "destino_codigo") DO NOTHING;

-- Un ticket solo cambia de paso por una transición activa del catálogo (si el servicio fallara, la base no deja saltarse pasos)
CREATE FUNCTION fcr.exigir_transicion_valida() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.paso_codigo IS DISTINCT FROM OLD.paso_codigo AND NOT EXISTS (
    SELECT 1 FROM fcr.transicion t WHERE t.origen_codigo = OLD.paso_codigo AND t.destino_codigo = NEW.paso_codigo AND t.activa
  ) THEN
    RAISE EXCEPTION 'El ticket no puede pasar de "%" a "%"', OLD.paso_codigo, NEW.paso_codigo USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "ticket_paso_valido" BEFORE UPDATE OF "paso_codigo" ON "ticket" FOR EACH ROW EXECUTE FUNCTION fcr.exigir_transicion_valida();

-- ---------------------------------------------------------------------------------------------------------------
-- Quién puede dejar cada firma (roles de cuenta): lo exige la base al firmar
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE "firma_rol_permitido" (
    "rol_firma" "rol_firma_inspeccion" NOT NULL,
    "rol_codigo" TEXT NOT NULL,
    CONSTRAINT "firma_rol_permitido_pkey" PRIMARY KEY ("rol_firma", "rol_codigo"),
    CONSTRAINT "firma_rol_permitido_rol_fkey" FOREIGN KEY ("rol_codigo") REFERENCES identidad.rol ("codigo")
);
COMMENT ON TABLE "firma_rol_permitido" IS 'Roles de cuenta (`identidad.rol.codigo`) que pueden dejar cada firma de la inspección: reparado por (operador FCR), revisado por (Supervisor) y liberado por QHSE (técnico o gerente HSE).';

-- ---------------------------------------------------------------------------------------------------------------
-- Inspección de una herramienta (una vigente por herramienta; una rechazada queda como historia y se rehace como versión nueva)
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE "inspeccion_herramienta" (
    "id" UUID NOT NULL,
    "herramienta_id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "estado" "estado_inspeccion" NOT NULL DEFAULT 'borrador',
    "fecha_inspeccion" DATE,
    "fecha_reparacion" DATE,
    "fecha_envio" DATE,
    "inspeccionado_por" "responsable_trabajo",
    "reparado_por" "responsable_trabajo",
    "observaciones" TEXT,
    "version_anterior_id" UUID,
    "enviada_at" TIMESTAMPTZ(6),
    "enviada_por" UUID,
    "decidida_at" TIMESTAMPTZ(6),
    "decidida_por" UUID,
    "motivo_rechazo" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID NOT NULL,
    CONSTRAINT "inspeccion_herramienta_pkey" PRIMARY KEY ("id"),
    -- una herramienta con inspección no se puede borrar (la historia firmada no se pierde)
    CONSTRAINT "inspeccion_herramienta_herramienta_fkey" FOREIGN KEY ("herramienta_id") REFERENCES "ticket_herramienta" ("id") ON DELETE RESTRICT,
    CONSTRAINT "inspeccion_herramienta_anterior_fkey" FOREIGN KEY ("version_anterior_id") REFERENCES "inspeccion_herramienta" ("id"),
    CONSTRAINT "inspeccion_herramienta_enviada_por_fkey" FOREIGN KEY ("enviada_por") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "inspeccion_herramienta_decidida_por_fkey" FOREIGN KEY ("decidida_por") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "inspeccion_herramienta_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "inspeccion_herramienta_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "inspeccion_herramienta_version_check" CHECK ("version" >= 1),
    CONSTRAINT "inspeccion_herramienta_enviada_check" CHECK (("enviada_at" IS NULL) = ("enviada_por" IS NULL)),
    CONSTRAINT "inspeccion_herramienta_decidida_check" CHECK (("decidida_at" IS NULL) = ("decidida_por" IS NULL)),
    -- el estado y sus marcas van juntos: borrador sin enviar; enviada con su envío; aprobada o rechazada con envío y decisión
    CONSTRAINT "inspeccion_herramienta_estado_check" CHECK (
      ("estado" = 'borrador' AND "enviada_at" IS NULL AND "decidida_at" IS NULL)
      OR ("estado" = 'enviada' AND "enviada_at" IS NOT NULL AND "decidida_at" IS NULL)
      OR ("estado" IN ('aprobada', 'rechazada') AND "enviada_at" IS NOT NULL AND "decidida_at" IS NOT NULL)
    ),
    CONSTRAINT "inspeccion_herramienta_rechazo_check" CHECK (("estado" = 'rechazada') = ("motivo_rechazo" IS NOT NULL)),
    CONSTRAINT "inspeccion_herramienta_texto_check" CHECK (
      length(btrim(coalesce("motivo_rechazo", 'x'))) > 0 AND length(btrim(coalesce("observaciones", 'x'))) > 0
    ),
    CONSTRAINT "inspeccion_herramienta_fechas_check" CHECK (
      "fecha_reparacion" IS NULL OR "fecha_inspeccion" IS NULL OR "fecha_reparacion" >= "fecha_inspeccion"
    )
);
CREATE UNIQUE INDEX "inspeccion_herramienta_version_key" ON "inspeccion_herramienta" ("herramienta_id", "version");
-- una sola inspección vigente (no rechazada) por herramienta
CREATE UNIQUE INDEX "inspeccion_herramienta_vigente_key" ON "inspeccion_herramienta" ("herramienta_id") WHERE "estado" <> 'rechazada';
CREATE INDEX "inspeccion_herramienta_estado_idx" ON "inspeccion_herramienta" ("estado");
COMMENT ON TABLE "inspeccion_herramienta" IS 'Checklist «Inspección y reparación de herramientas» de una herramienta del ticket (entrada SERVICIOS). La cabecera (cliente, pozo, descripción y serie) se lee de ticket, artículo y herramienta con JOIN; aquí solo lo que se define al inspeccionar. Estados borrador → enviada → aprobada o rechazada; una rechazada es historia y se rehace como versión nueva.';
COMMENT ON COLUMN "inspeccion_herramienta"."inspeccionado_por" IS 'Quién inspeccionó: Dynadrill o un proveedor externo.';
COMMENT ON COLUMN "inspeccion_herramienta"."reparado_por" IS 'Quién reparó: Dynadrill o un proveedor externo.';
COMMENT ON COLUMN "inspeccion_herramienta"."fecha_reparacion" IS 'Fecha de revisión: se fija sola al firmar «reparado por» y no se vuelve a tocar.';
COMMENT ON COLUMN "inspeccion_herramienta"."version_anterior_id" IS 'La inspección rechazada de la que se copió el contenido al rehacerla (las firmas no se copian).';

-- Solo las herramientas de tickets de SERVICIOS se inspeccionan
CREATE FUNCTION fcr.exigir_ticket_de_servicios() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM fcr.ticket_herramienta h JOIN fcr.ticket t ON t.id = h.ticket_id WHERE h.id = NEW.herramienta_id AND t.tipo_ot = 'servicio'
  ) THEN
    RAISE EXCEPTION 'Solo se inspeccionan las herramientas de los tickets de servicios' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "inspeccion_herramienta_servicios" BEFORE INSERT ON "inspeccion_herramienta" FOR EACH ROW EXECUTE FUNCTION fcr.exigir_ticket_de_servicios();

-- La cabecera queda bloqueada desde que «reparado por» firma o la inspección se envía (solo cambian el estado y sus marcas)
CREATE FUNCTION fcr.proteger_inspeccion_firmada() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.herramienta_id IS DISTINCT FROM OLD.herramienta_id OR NEW.version IS DISTINCT FROM OLD.version THEN
    RAISE EXCEPTION 'La herramienta y la versión de una inspección no cambian' USING ERRCODE = 'check_violation';
  END IF;
  IF (OLD.estado <> 'borrador' OR EXISTS (SELECT 1 FROM fcr.inspeccion_firma f WHERE f.inspeccion_id = OLD.id AND f.rol = 'reparado_por'))
     AND (NEW.fecha_inspeccion, NEW.fecha_envio, NEW.inspeccionado_por, NEW.reparado_por, NEW.observaciones)
         IS DISTINCT FROM (OLD.fecha_inspeccion, OLD.fecha_envio, OLD.inspeccionado_por, OLD.reparado_por, OLD.observaciones) THEN
    RAISE EXCEPTION 'La inspección está firmada o enviada: sus datos ya no se pueden cambiar' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.estado <> 'borrador' AND NEW.fecha_reparacion IS DISTINCT FROM OLD.fecha_reparacion THEN
    RAISE EXCEPTION 'La inspección está enviada: la fecha de revisión ya no cambia' USING ERRCODE = 'check_violation';
  END IF;
  -- una inspección decidida es definitiva
  IF OLD.estado IN ('aprobada', 'rechazada') AND NEW.estado IS DISTINCT FROM OLD.estado THEN
    RAISE EXCEPTION 'Una inspección aprobada o rechazada ya no cambia de estado' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Partes de la inspección: copia fija de las partes del artículo al iniciar (o agregadas a mano)
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE "inspeccion_parte" (
    "id" UUID NOT NULL,
    "inspeccion_id" UUID NOT NULL,
    "orden" INTEGER NOT NULL,
    "articulo_parte_id" UUID,
    "manual" BOOLEAN NOT NULL DEFAULT false,
    "item" TEXT NOT NULL,
    "codigo" TEXT,
    "descripcion" TEXT NOT NULL,
    "cantidad_esperada" INTEGER NOT NULL DEFAULT 1,
    "visual" "resultado_parte",
    "end_resultado" "resultado_parte",
    "cambio_cantidad" INTEGER,
    "accion" TEXT,
    CONSTRAINT "inspeccion_parte_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "inspeccion_parte_inspeccion_fkey" FOREIGN KEY ("inspeccion_id") REFERENCES "inspeccion_herramienta" ("id") ON DELETE RESTRICT,
    -- si Inventario da de baja la parte, la copia sigue siendo la que se inspeccionó
    CONSTRAINT "inspeccion_parte_articulo_parte_fkey" FOREIGN KEY ("articulo_parte_id") REFERENCES inventario.articulo_parte ("id") ON DELETE SET NULL,
    CONSTRAINT "inspeccion_parte_orden_check" CHECK ("orden" >= 1),
    CONSTRAINT "inspeccion_parte_cantidad_check" CHECK ("cantidad_esperada" >= 1 AND ("cambio_cantidad" IS NULL OR "cambio_cantidad" >= 0)),
    -- una parte agregada a mano no viene del catálogo; la copiada de una parte tiene su código
    CONSTRAINT "inspeccion_parte_manual_check" CHECK (NOT "manual" OR "articulo_parte_id" IS NULL),
    CONSTRAINT "inspeccion_parte_codigo_check" CHECK ("codigo" IS NOT NULL OR "manual"),
    CONSTRAINT "inspeccion_parte_texto_check" CHECK (
      length(btrim("item")) > 0 AND length(btrim("descripcion")) > 0 AND length(btrim(coalesce("accion", 'x'))) > 0
    )
);
CREATE UNIQUE INDEX "inspeccion_parte_orden_key" ON "inspeccion_parte" ("inspeccion_id", "orden");
CREATE INDEX "inspeccion_parte_articulo_parte_idx" ON "inspeccion_parte" ("articulo_parte_id");
COMMENT ON TABLE "inspeccion_parte" IS 'Partes de una inspección. Item, código, descripción y cantidad esperada son una COPIA FIJA de la parte del artículo al iniciar la inspección (es un documento firmado: un cambio posterior al catálogo no la altera); `articulo_parte_id` conserva el vínculo mientras la parte exista. Las `manual` las agrega quien inspecciona y son las únicas que se pueden quitar.';
COMMENT ON COLUMN "inspeccion_parte"."cambio_cantidad" IS 'Cambio de elemento (cantidad): dato informativo, no mueve el kardex.';

-- las partes solo se editan en una inspección en borrador sin la firma de «reparado por»; solo se borran las manuales
CREATE FUNCTION fcr.proteger_partes_de_inspeccion() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  inspeccion uuid := COALESCE(NEW.inspeccion_id, OLD.inspeccion_id);
BEGIN
  -- Inventario dio de baja la parte del catálogo: solo se suelta el vínculo, la copia no cambia
  IF TG_OP = 'UPDATE' AND NEW.articulo_parte_id IS NULL AND OLD.articulo_parte_id IS NOT NULL
     AND (NEW.inspeccion_id, NEW.orden, NEW.manual, NEW.item, NEW.codigo, NEW.descripcion, NEW.cantidad_esperada, NEW.visual, NEW.end_resultado, NEW.cambio_cantidad, NEW.accion)
         IS NOT DISTINCT FROM (OLD.inspeccion_id, OLD.orden, OLD.manual, OLD.item, OLD.codigo, OLD.descripcion, OLD.cantidad_esperada, OLD.visual, OLD.end_resultado, OLD.cambio_cantidad, OLD.accion) THEN
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM fcr.inspeccion_herramienta i WHERE i.id = inspeccion AND i.estado <> 'borrador')
     OR EXISTS (SELECT 1 FROM fcr.inspeccion_firma f WHERE f.inspeccion_id = inspeccion AND f.rol = 'reparado_por') THEN
    RAISE EXCEPTION 'La inspección está firmada o enviada: sus partes ya no se pueden cambiar' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF NOT OLD.manual THEN
      RAISE EXCEPTION 'Solo se pueden quitar las partes agregadas a mano' USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.inspeccion_id, NEW.orden, NEW.manual, NEW.item, NEW.codigo, NEW.descripcion, NEW.cantidad_esperada)
     IS DISTINCT FROM (OLD.inspeccion_id, OLD.orden, OLD.manual, OLD.item, OLD.codigo, OLD.descripcion, OLD.cantidad_esperada)
     AND NOT OLD.manual THEN
    RAISE EXCEPTION 'La parte copiada del artículo no se edita: solo sus resultados' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "inspeccion_parte_protegida" BEFORE INSERT OR UPDATE OR DELETE ON "inspeccion_parte" FOR EACH ROW EXECUTE FUNCTION fcr.proteger_partes_de_inspeccion();
GRANT DELETE ON "inspeccion_parte" TO app_operaciones;

-- ---------------------------------------------------------------------------------------------------------------
-- Firmas (inmutables): en orden y por quien corresponde
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE "inspeccion_firma" (
    "inspeccion_id" UUID NOT NULL,
    "rol" "rol_firma_inspeccion" NOT NULL,
    "usuario_id" UUID NOT NULL,
    "firmada_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "inspeccion_firma_pkey" PRIMARY KEY ("inspeccion_id", "rol"),
    CONSTRAINT "inspeccion_firma_inspeccion_fkey" FOREIGN KEY ("inspeccion_id") REFERENCES "inspeccion_herramienta" ("id") ON DELETE RESTRICT,
    CONSTRAINT "inspeccion_firma_usuario_fkey" FOREIGN KEY ("usuario_id") REFERENCES identidad.usuario ("id")
);
CREATE INDEX "inspeccion_firma_usuario_idx" ON "inspeccion_firma" ("usuario_id");
REVOKE UPDATE, DELETE ON "inspeccion_firma" FROM app_operaciones;
COMMENT ON TABLE "inspeccion_firma" IS 'Las tres firmas de la inspección: la cuenta que firma y la hora del servidor (no un dibujo). Inmutable; cada firma exige la anterior.';

CREATE FUNCTION fcr.exigir_firma_valida() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  anterior fcr.rol_firma_inspeccion;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM fcr.inspeccion_herramienta i WHERE i.id = NEW.inspeccion_id AND i.estado = 'borrador') THEN
    RAISE EXCEPTION 'Solo se firma una inspección en borrador' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM identidad.usuario u JOIN identidad.rol r ON r.id = u.rol_id
    JOIN fcr.firma_rol_permitido p ON p.rol_codigo = r.codigo AND p.rol_firma = NEW.rol
    WHERE u.id = NEW.usuario_id
  ) THEN
    RAISE EXCEPTION 'La cuenta no tiene el rol que exige esta firma' USING ERRCODE = 'check_violation';
  END IF;
  anterior := CASE NEW.rol WHEN 'revisado_por' THEN 'reparado_por'::fcr.rol_firma_inspeccion WHEN 'liberado_qhse' THEN 'revisado_por'::fcr.rol_firma_inspeccion END;
  IF anterior IS NOT NULL AND NOT EXISTS (SELECT 1 FROM fcr.inspeccion_firma f WHERE f.inspeccion_id = NEW.inspeccion_id AND f.rol = anterior) THEN
    RAISE EXCEPTION 'Primero debe firmarse "%" antes de firmar "%"', anterior, NEW.rol USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "inspeccion_firma_valida" BEFORE INSERT ON "inspeccion_firma" FOR EACH ROW EXECUTE FUNCTION fcr.exigir_firma_valida();
-- las funciones de protección necesitan `inspeccion_firma`: el disparador de cabecera se crea ahora que existe
CREATE TRIGGER "inspeccion_herramienta_protegida" BEFORE UPDATE ON "inspeccion_herramienta" FOR EACH ROW EXECUTE FUNCTION fcr.proteger_inspeccion_firmada();

-- ---------------------------------------------------------------------------------------------------------------
-- Documentos del ticket (los seis campos de la demo): el archivo vive en `archivos`; aquí solo se enlaza. Inmutables: el vigente es el último.
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE "ticket_documento" (
    "id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "campo" "campo_documento_fcr" NOT NULL,
    "archivo_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    CONSTRAINT "ticket_documento_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ticket_documento_ticket_fkey" FOREIGN KEY ("ticket_id") REFERENCES "ticket" ("id") ON DELETE CASCADE,
    CONSTRAINT "ticket_documento_archivo_fkey" FOREIGN KEY ("archivo_id") REFERENCES archivos.archivo ("id"),
    CONSTRAINT "ticket_documento_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES identidad.usuario ("id")
);
CREATE UNIQUE INDEX "ticket_documento_archivo_key" ON "ticket_documento" ("ticket_id", "archivo_id");
CREATE INDEX "ticket_documento_campo_idx" ON "ticket_documento" ("ticket_id", "campo", "created_at");
REVOKE UPDATE, DELETE ON "ticket_documento" FROM app_operaciones;
COMMENT ON TABLE "ticket_documento" IS 'Documentos adjuntos de un ticket de FCR: de SERVICIOS (formulario de inspección externo, dimensionamiento, dureza) y del tronco (inspección y dimensionamiento, registro de dureza, registro de QAQC). Inmutable: el vigente de cada campo es el último.';

-- el archivo debe haberlo subido el módulo de documentos de FCR y no estar eliminado (si no, cualquiera enlazaría un archivo ajeno)
CREATE FUNCTION fcr.exigir_archivo_del_modulo() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM archivos.archivo a JOIN archivos.modulo_archivo m ON m.id = a.modulo_id
    WHERE a.id = NEW.archivo_id AND a.eliminado_at IS NULL AND m.codigo = 'ticket_fcr_documento'
  ) THEN
    RAISE EXCEPTION 'El archivo no existe, fue eliminado o no es un documento de FCR' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "ticket_documento_archivo_valido" BEFORE INSERT ON "ticket_documento" FOR EACH ROW EXECUTE FUNCTION fcr.exigir_archivo_del_modulo();
