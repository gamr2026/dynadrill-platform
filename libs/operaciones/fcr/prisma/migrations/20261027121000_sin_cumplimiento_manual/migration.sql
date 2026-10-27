-- Retiro del puente manual (27/10/2026): los requisitos de otros módulos los cumple el evento de su dueño (QHSE, Flota).
-- Ninguna fila nueva puede registrarse con origen 'manual_temporal'; las anteriores (si las hubiera) se conservan como historia,
-- por eso la restricción se crea NOT VALID (solo vigila lo que se escriba desde ahora).
ALTER TABLE fcr.ticket_requisito
  ADD CONSTRAINT ticket_requisito_sin_manual_check CHECK (origen <> 'manual_temporal') NOT VALID;
COMMENT ON CONSTRAINT ticket_requisito_sin_manual_check ON fcr.ticket_requisito IS 'El puente manual se retiró: un requisito se cumple por el sistema o por el evento de su módulo dueño. Las filas históricas con origen manual_temporal se conservan.';
