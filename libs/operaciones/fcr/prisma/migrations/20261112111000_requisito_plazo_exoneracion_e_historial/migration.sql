-- Requisitos con plazo, responsable, exoneración e historial (12/11/2026).
-- Catálogo: plazo en horas (NULL = sin plazo) y rol de cuenta responsable de cumplirlo.
ALTER TABLE "fcr"."requisito"
  ADD COLUMN "plazo_horas" INTEGER,
  ADD COLUMN "rol_responsable" TEXT,
  ADD CONSTRAINT "requisito_plazo_horas_check" CHECK ("plazo_horas" IS NULL OR "plazo_horas" >= 0),
  ADD CONSTRAINT "requisito_rol_responsable_fkey" FOREIGN KEY ("rol_responsable") REFERENCES identidad.rol ("codigo");
CREATE INDEX "requisito_rol_responsable_idx" ON "fcr"."requisito" ("rol_responsable");
COMMENT ON COLUMN "fcr"."requisito"."plazo_horas" IS 'Horas que tiene el responsable para cumplir el requisito desde que se crea. NULL: sin plazo.';
COMMENT ON COLUMN "fcr"."requisito"."rol_responsable" IS 'Rol de cuenta (identidad.rol.codigo) a quien le corresponde cumplir el requisito; se avisa a su equipo cuando vence. NULL: no hay uno único.';

-- Solo donde el catálogo lo deja sin ambigüedad (un único rol actúa en el paso del que el requisito es salida y es quien lo cumple)
UPDATE "fcr"."requisito" SET "rol_responsable" = 'supervisor'
  WHERE "codigo" IN ('tipo_operador_definido', 'listado_herramientas_confirmado', 'acta_reunion_operativa')
    AND EXISTS (SELECT 1 FROM identidad.rol WHERE "codigo" = 'supervisor');
UPDATE "fcr"."requisito" SET "rol_responsable" = 'operador_fcr'
  WHERE "codigo" IN ('inspecciones_enviadas', 'formulario_inspeccion_externo', 'bitacora_enviada', 'listado_uso_confirmado')
    AND EXISTS (SELECT 1 FROM identidad.rol WHERE "codigo" = 'operador_fcr');
UPDATE "fcr"."requisito" SET "rol_responsable" = 'bodeguero'
  WHERE "codigo" = 'herramientas_devueltas'
    AND EXISTS (SELECT 1 FROM identidad.rol WHERE "codigo" = 'bodeguero');

-- Estado del requisito del ticket: vencimiento y exoneración
ALTER TABLE "fcr"."ticket_requisito"
  ADD COLUMN "vence_at" TIMESTAMPTZ(6),
  ADD COLUMN "vencido_at" TIMESTAMPTZ(6),
  ADD COLUMN "exonerado_at" TIMESTAMPTZ(6),
  ADD COLUMN "exonerado_por" UUID,
  ADD CONSTRAINT "ticket_requisito_exonerado_por_fkey" FOREIGN KEY ("exonerado_por") REFERENCES identidad.usuario ("id"),
  -- exonerado exactamente cuando hay fecha y autor de la exoneración, y con motivo
  ADD CONSTRAINT "ticket_requisito_exonerado_check" CHECK (
    ("estado" = 'exonerado') = ("exonerado_at" IS NOT NULL)
    AND ("exonerado_at" IS NULL) = ("exonerado_por" IS NULL)
    AND ("estado" <> 'exonerado' OR length(btrim(coalesce("motivo", ''))) > 0)
  );
CREATE INDEX "ticket_requisito_exonerado_por_idx" ON "fcr"."ticket_requisito" ("exonerado_por");
-- la revisión periódica busca los pendientes con plazo vencido y sin marcar
CREATE INDEX "ticket_requisito_por_vencer_idx" ON "fcr"."ticket_requisito" ("vence_at")
  WHERE "estado" = 'pendiente' AND "vencido_at" IS NULL AND "vence_at" IS NOT NULL;
COMMENT ON COLUMN "fcr"."ticket_requisito"."vence_at" IS 'Hasta cuándo debe cumplirse (plazo del catálogo o, en la bitácora, el fin del día siguiente al primer día sin enviar). NULL: sin plazo.';
COMMENT ON COLUMN "fcr"."ticket_requisito"."vencido_at" IS 'Cuándo la revisión periódica lo marcó vencido (seguía pendiente pasado vence_at). Se limpia al reabrirse.';
COMMENT ON COLUMN "fcr"."ticket_requisito"."exonerado_at" IS 'Cuándo se exoneró (estado exonerado): no bloquea la salida del paso y ningún recálculo automático lo toca.';
COMMENT ON COLUMN "fcr"."ticket_requisito"."exonerado_por" IS 'Quién lo exoneró (identidad.usuario). El motivo queda en `motivo`.';

-- Un requisito exonerado no pasa a cumplido por un recálculo o un evento tardío: solo se revierte (vuelve a pendiente) desde la exoneración.
CREATE FUNCTION fcr.proteger_requisito_exonerado() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.estado = 'exonerado' AND NEW.estado = 'cumplido' THEN
    RAISE EXCEPTION 'El requisito exonerado no se puede cumplir: primero se revierte la exoneración' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "ticket_requisito_exonerado_protegido" BEFORE UPDATE OF "estado" ON "fcr"."ticket_requisito"
  FOR EACH ROW EXECUTE FUNCTION fcr.proteger_requisito_exonerado();

-- Historial de cada requisito del ticket (inmutable, lo escribe la base)
CREATE TABLE "fcr"."ticket_requisito_historial" (
    "id" UUID NOT NULL,
    "ticket_requisito_id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "estado_anterior" "fcr"."estado_requisito",
    "estado_nuevo" "fcr"."estado_requisito" NOT NULL,
    "vencido" BOOLEAN NOT NULL,
    "origen" TEXT NOT NULL,
    "actor_id" UUID,
    "motivo" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ticket_requisito_historial_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ticket_requisito_historial_requisito_fkey" FOREIGN KEY ("ticket_requisito_id") REFERENCES "fcr"."ticket_requisito" ("id") ON DELETE CASCADE,
    CONSTRAINT "ticket_requisito_historial_ticket_fkey" FOREIGN KEY ("ticket_id") REFERENCES "fcr"."ticket" ("id") ON DELETE CASCADE,
    CONSTRAINT "ticket_requisito_historial_actor_fkey" FOREIGN KEY ("actor_id") REFERENCES identidad.usuario ("id"),
    CONSTRAINT "ticket_requisito_historial_origen_check" CHECK ("origen" IN ('sistema', 'evento', 'manual', 'revision'))
);
CREATE INDEX "ticket_requisito_historial_requisito_idx" ON "fcr"."ticket_requisito_historial" ("ticket_requisito_id", "created_at");
CREATE INDEX "ticket_requisito_historial_ticket_idx" ON "fcr"."ticket_requisito_historial" ("ticket_id");
CREATE INDEX "ticket_requisito_historial_actor_idx" ON "fcr"."ticket_requisito_historial" ("actor_id");
-- la aplicación solo lee y (por el trigger) inserta
REVOKE UPDATE, DELETE ON "fcr"."ticket_requisito_historial" FROM app_operaciones;
COMMENT ON TABLE "fcr"."ticket_requisito_historial" IS 'Cada cambio de estado (o de vencimiento) de un requisito del ticket, escrito por el trigger de ticket_requisito. Inmutable: la aplicación solo lee e inserta (vía el trigger).';
COMMENT ON COLUMN "fcr"."ticket_requisito_historial"."estado_anterior" IS 'NULL al crearse el requisito.';
COMMENT ON COLUMN "fcr"."ticket_requisito_historial"."vencido" IS 'Si en ese momento el requisito estaba marcado como vencido (vencido_at no nulo).';
COMMENT ON COLUMN "fcr"."ticket_requisito_historial"."origen" IS 'sistema (recálculo de FCR), evento (de otro módulo), manual (exoneración o su reversión por una persona) o revision (marca de vencido de la revisión periódica).';
COMMENT ON COLUMN "fcr"."ticket_requisito_historial"."actor_id" IS 'Quien cumplió o exoneró; NULL si lo hizo el sistema, fue una reapertura o una reversión.';

-- El trigger escribe el historial. Sus ids usan gen_random_uuid() (UUIDv4): la aplicación genera UUIDv7, pero un trigger no puede pedírselo
-- a la aplicación; el orden de lectura es por created_at.
CREATE FUNCTION fcr.registrar_historial_requisito() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_origen TEXT;
  v_actor UUID;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.estado = OLD.estado THEN
    v_origen := 'revision'; v_actor := NULL; -- cambió solo vencido_at
  ELSIF NEW.estado = 'exonerado' THEN
    v_origen := 'manual'; v_actor := NEW.exonerado_por;
  ELSIF TG_OP = 'UPDATE' AND OLD.estado = 'exonerado' THEN
    v_origen := 'manual'; v_actor := NULL; -- la reversión de la exoneración
  ELSIF NEW.estado = 'cumplido' THEN
    v_origen := CASE WHEN NEW.origen = 'evento' THEN 'evento' ELSE 'sistema' END; v_actor := NEW.cumplido_por;
  ELSE
    v_origen := 'sistema'; v_actor := NULL;
  END IF;
  INSERT INTO fcr.ticket_requisito_historial (id, ticket_requisito_id, ticket_id, estado_anterior, estado_nuevo, vencido, origen, actor_id, motivo)
  VALUES (gen_random_uuid(), NEW.id, NEW.ticket_id, CASE WHEN TG_OP = 'UPDATE' THEN OLD.estado END, NEW.estado, NEW.vencido_at IS NOT NULL, v_origen, v_actor, NEW.motivo);
  RETURN NULL;
END $$;
CREATE TRIGGER "ticket_requisito_historial_insert" AFTER INSERT ON "fcr"."ticket_requisito"
  FOR EACH ROW EXECUTE FUNCTION fcr.registrar_historial_requisito();
CREATE TRIGGER "ticket_requisito_historial_update" AFTER UPDATE ON "fcr"."ticket_requisito"
  FOR EACH ROW WHEN (OLD.estado IS DISTINCT FROM NEW.estado OR OLD.vencido_at IS DISTINCT FROM NEW.vencido_at)
  EXECUTE FUNCTION fcr.registrar_historial_requisito();

-- Los requisitos que ya existen quedan con su estado actual como primera fila del historial
INSERT INTO "fcr"."ticket_requisito_historial" ("id", "ticket_requisito_id", "ticket_id", "estado_anterior", "estado_nuevo", "vencido", "origen", "actor_id", "motivo", "created_at")
SELECT gen_random_uuid(), r."id", r."ticket_id", NULL, r."estado", false,
       CASE WHEN r."origen" = 'evento' THEN 'evento' ELSE 'sistema' END, r."cumplido_por", r."motivo", r."created_at"
FROM "fcr"."ticket_requisito" r;
