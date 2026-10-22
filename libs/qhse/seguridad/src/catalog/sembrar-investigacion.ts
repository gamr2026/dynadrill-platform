import { uuidv7 } from '@dyn/utils';
import type { PrismaClient } from '../generated/client';

interface ResultadoSembrado {
  codigo: string;
  nombre: string;
  inicioHoras: number;
  preliminarHoras: number | null;
  finalDias: number;
  /** El documento no tabula este plazo: se adoptó el de «leve» (supuesto de la demo, pendiente de confirmar con Dynadrill). */
  plazoSupuesto?: boolean;
  involucraLesionado: boolean;
  sugiereNotificacionLegal: boolean;
}

/** Resultados del incidente con los plazos de HSE-TRIAGE-002. QHSE los ajusta después; el comportamiento nunca depende del nombre. */
export const RESULTADOS_INVESTIGACION: readonly ResultadoSembrado[] = [
  {
    codigo: 'fatal',
    nombre: 'Fatal: muerte del trabajador',
    inicioHoras: 0,
    preliminarHoras: 24,
    finalDias: 15,
    involucraLesionado: true,
    sugiereNotificacionLegal: true,
  },
  {
    codigo: 'grave',
    nombre: 'Grave: incapacidad permanente, amputación, pérdida de sentido',
    inicioHoras: 0,
    preliminarHoras: 48,
    finalDias: 30,
    involucraLesionado: true,
    sugiereNotificacionLegal: true,
  },
  {
    codigo: 'leve',
    nombre: 'Leve: atención médica, días de reposo menores a 30',
    inicioHoras: 24,
    preliminarHoras: 72,
    finalDias: 45,
    involucraLesionado: true,
    sugiereNotificacionLegal: true,
  },
  {
    codigo: 'primeros_auxilios',
    nombre: 'Primeros auxilios: sin días perdidos',
    inicioHoras: 24,
    preliminarHoras: 72,
    finalDias: 45,
    plazoSupuesto: true,
    involucraLesionado: true,
    sugiereNotificacionLegal: false,
  },
  {
    codigo: 'dano_material',
    nombre: 'Daño material: sin lesionados',
    inicioHoras: 24,
    preliminarHoras: 72,
    finalDias: 45,
    plazoSupuesto: true,
    involucraLesionado: false,
    sugiereNotificacionLegal: false,
  },
  {
    codigo: 'near_miss',
    nombre: 'Cuasi accidente (Near Miss): sin daño, pero pudo haberlo',
    inicioHoras: 72,
    preliminarHoras: null,
    finalDias: 30,
    involucraLesionado: false,
    sugiereNotificacionLegal: false,
  },
  {
    codigo: 'incidente_ambiental',
    nombre: 'Incidente ambiental: derrame, emisión, contaminación',
    inicioHoras: 24,
    preliminarHoras: 72,
    finalDias: 45,
    plazoSupuesto: true,
    involucraLesionado: false,
    sugiereNotificacionLegal: false,
  },
];

/** Idempotente: solo agrega lo que falta y no toca lo que QHSE ya ajustó. */
export async function sembrarInvestigacion(prisma: PrismaClient): Promise<{ resultados: number }> {
  let resultados = 0;
  for (const [i, r] of RESULTADOS_INVESTIGACION.entries()) {
    if (await prisma.investigacionResultado.count({ where: { codigo: r.codigo } })) continue;
    await prisma.investigacionResultado.create({
      data: {
        id: uuidv7(),
        codigo: r.codigo,
        nombre: r.nombre,
        orden: i + 1,
        inicioHoras: r.inicioHoras,
        preliminarHoras: r.preliminarHoras,
        finalDias: r.finalDias,
        plazoSupuesto: r.plazoSupuesto ?? false,
        involucraLesionado: r.involucraLesionado,
        sugiereNotificacionLegal: r.sugiereNotificacionLegal,
      },
    });
    resultados++;
  }
  return { resultados };
}
