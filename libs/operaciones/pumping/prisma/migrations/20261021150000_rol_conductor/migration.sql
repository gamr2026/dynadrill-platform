-- El conductor de cada unidad se asigna en el ticket junto al supervisor y los operadores (es el responsable de la inspección del vehículo).
ALTER TYPE "pumping"."rol_asignado" ADD VALUE IF NOT EXISTS 'conductor';
