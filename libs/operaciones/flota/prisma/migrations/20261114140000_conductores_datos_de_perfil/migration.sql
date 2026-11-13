-- Flota lee del perfil del usuario (identidad.usuario_perfil) los datos que identifican al conductor en la lista de conductores: nombres,
-- apellidos, tipo de identificación y cédula. Son datos personales protegidos por la LOPDP: el permiso es de lectura y sobre exactamente
-- esas columnas (nunca cargo, fechas, contrato, discapacidad ni nada más del perfil).
GRANT SELECT (usuario_id, cedula, tipo_identificacion, apellidos, nombres) ON identidad.usuario_perfil TO app_operaciones;
