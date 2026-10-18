import type { PlantillaDef } from './tipos';
import { PLANTILLAS_FCR } from './fcr';
import { PLANTILLAS_MANTENIMIENTO } from './mantenimiento';
import { PLANTILLAS_PUMPING } from './pumping';
import { PLANTILLAS_QHSE } from './qhse';

export type { PlantillaDef } from './tipos';

/**
 * Plantillas iniciales de todos los módulos. **Cada módulo tiene su propio archivo** (`plantillas/<modulo>.ts`) y agrega aquí UNA
 * línea; así varias sesiones pueden sembrar avisos a la vez sin pisarse (ver documentacion/modulos/01-REGLAS-DE-COORDINACION.md).
 */
export const PLANTILLAS: PlantillaDef[] = [
  ...PLANTILLAS_PUMPING,
  ...PLANTILLAS_QHSE,
  // ...PLANTILLAS_FLOTA,
  ...PLANTILLAS_MANTENIMIENTO,
  // ...PLANTILLAS_INVENTARIO,
  ...PLANTILLAS_FCR,
];
