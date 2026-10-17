-- Los preventivos de la carga inicial (historial de la demo) no traen una cuenta responsable: en ellos queda vacío. Los que se registran
-- desde la aplicación siempre lo llevan (por omisión, quien los registra).
ALTER TABLE "unidad_preventivo" ALTER COLUMN "responsable_id" DROP NOT NULL;
