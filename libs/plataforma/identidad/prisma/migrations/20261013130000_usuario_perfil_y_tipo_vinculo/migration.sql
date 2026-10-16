-- 1) usuario_empleado → usuario_perfil.
-- No todo usuario es empleado: la tabla guarda el perfil (RRHH y datos personales) de quien lo tenga, y
-- `usuario.tipo_vinculo` indica de qué clase de persona se trata. Se renombran también la PK, la FK y el
-- índice único para que conserven la convención de nombres (de lo contrario Prisma detectaría deriva).
ALTER TABLE "usuario_empleado" RENAME TO "usuario_perfil";
ALTER TABLE "usuario_perfil" RENAME CONSTRAINT "usuario_empleado_pkey" TO "usuario_perfil_pkey";
ALTER TABLE "usuario_perfil" RENAME CONSTRAINT "usuario_empleado_usuario_id_fkey" TO "usuario_perfil_usuario_id_fkey";
ALTER INDEX "usuario_empleado_usuario_id_key" RENAME TO "usuario_perfil_usuario_id_key";

COMMENT ON TABLE "usuario_perfil" IS 'Perfil del usuario (1:1, opcional): datos de RRHH y personales. Contiene datos protegidos por la LOPDP: acceso restringido.';

-- 2) tipo_vinculo: los usuarios existentes son de la demo, todos empleados.
ALTER TABLE "usuario" ADD COLUMN "tipo_vinculo" TEXT NOT NULL DEFAULT 'empleado';
ALTER TABLE "usuario" ADD CONSTRAINT "usuario_tipo_vinculo_check"
  CHECK ("tipo_vinculo" IN ('empleado', 'contratista', 'externo'));

COMMENT ON COLUMN "usuario"."tipo_vinculo" IS 'Vínculo con Dynadrill: empleado, contratista o externo. No confundir con usuario_perfil.tipo_contrato (modalidad de contrato de un empleado).';
