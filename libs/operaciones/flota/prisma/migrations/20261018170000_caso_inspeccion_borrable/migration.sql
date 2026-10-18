-- El caso de inspección no es historia: si Pumping cambia la asignación y la unidad ya no está en el ticket, el caso sin inspecciones se
-- retira. Los privilegios por omisión de `app_operaciones` no incluyen DELETE; se concede solo en esta tabla (las inspecciones, sus
-- resultados y revisiones siguen sin DELETE, y la FK impide borrar un caso que ya tiene inspecciones).
GRANT DELETE ON "inspeccion_caso" TO app_operaciones;
