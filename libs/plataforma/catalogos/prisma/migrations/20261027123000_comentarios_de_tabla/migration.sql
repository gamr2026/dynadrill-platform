-- Estándar de la base de datos: toda tabla lleva su comentario en español (catalogos, 3 tablas).
COMMENT ON TABLE catalogos.chofer IS 'Chofer: pertenece a un transportista (como en AS2).';
COMMENT ON TABLE catalogos.tipo_vehiculo IS 'Tipos de vehículo (camión, camioneta...).';
COMMENT ON TABLE catalogos.vehiculo IS 'Vehículo de la matrícula (placa, marca, modelo, año): dato patrimonial al que se enlaza la unidad de Flota.';
