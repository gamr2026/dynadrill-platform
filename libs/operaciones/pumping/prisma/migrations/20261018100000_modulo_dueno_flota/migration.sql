-- La inspección de vehículos es de Flota (schema `flota`), no de Mantenimiento: el módulo dueño de esos requisitos pasa a llamarse flota.
ALTER TYPE "modulo_dueno" RENAME VALUE 'mantenimiento' TO 'flota';
