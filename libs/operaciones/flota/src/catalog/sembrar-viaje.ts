import { uuidv7 } from '@dyn/utils';
import type { PrismaClient } from '../generated/client';

/**
 * Cuestionario de riesgo del Gerenciamiento de Viaje (DYN-SGI-RE-049) y sus umbrales. Las preguntas, opciones y puntajes son los del
 * formato de la demo (`main`). `impide` marca la respuesta «Deténgase» / «no conduce» (999 en el formato): no suma, impide el viaje.
 * Idempotente: no pisa lo que el negocio ya haya editado.
 */
interface OpcionSemilla {
  etiqueta: string;
  puntos: number;
  impide?: boolean;
}
interface PreguntaSemilla {
  codigo: string;
  texto: string;
  opciones: OpcionSemilla[];
}

export const PREGUNTAS_RIESGO: PreguntaSemilla[] = [
  {
    codigo: 'inspeccion_previaje',
    texto: '¿Realizó inspección Pre-viaje?',
    opciones: [
      { etiqueta: 'Sí: Continue', puntos: 0 },
      { etiqueta: 'NO: Deténgase', puntos: 0, impide: true },
    ],
  },
  {
    codigo: 'primera_vez_ruta',
    texto: '¿Es la primera vez que el conductor viajará por esta ruta?',
    opciones: [
      { etiqueta: 'NO = 0', puntos: 0 },
      { etiqueta: 'Sí = 15', puntos: 15 },
    ],
  },
  {
    codigo: 'conductor_nuevo',
    texto: '¿Es un conductor nuevo?',
    opciones: [
      { etiqueta: 'NO = 0', puntos: 0 },
      { etiqueta: '4m - 8m = 15', puntos: 15 },
      { etiqueta: '0m - 3m = 40', puntos: 40 },
    ],
  },
  {
    codigo: 'horas_trabajadas',
    texto: '¿Cuántas horas trabajó el conductor antes de iniciar el viaje?',
    opciones: [
      { etiqueta: '8 a 12 hs = 10', puntos: 10 },
      { etiqueta: '> 12 <16 hs = 30', puntos: 30 },
      { etiqueta: '> 16 hs', puntos: 0, impide: true },
    ],
  },
  {
    codigo: 'horas_sueno',
    texto: '¿Cuántas horas de sueño (durmió) tuvo el conductor en las últimas 24 horas?',
    opciones: [
      { etiqueta: '< 4 hs = no conduce', puntos: 0, impide: true },
      { etiqueta: '> 4 < 6 hs = 5', puntos: 5 },
      { etiqueta: '> 6 hs = 0', puntos: 0 },
    ],
  },
  {
    codigo: 'duracion_viaje',
    texto: '¿Cuánto tiempo (horas) se estima que demandará el viaje?',
    opciones: [
      { etiqueta: '> 2 < 4 hs = 10', puntos: 10 },
      { etiqueta: '> 4 < 6 hs = 15', puntos: 15 },
      { etiqueta: '> 6 hs = 20', puntos: 20 },
    ],
  },
  {
    codigo: 'conductor_respaldo',
    texto: '¿Hay un conductor de respaldo para los viajes de más de 10 horas?',
    opciones: [
      { etiqueta: 'NO = 5', puntos: 5 },
      { etiqueta: 'Sí = 0', puntos: 0 },
    ],
  },
  {
    codigo: 'oscuridad',
    texto: '¿Parte del viaje se desarrollará en condiciones de oscuridad?',
    opciones: [
      { etiqueta: '< 4 hs = 0', puntos: 0 },
      { etiqueta: '> 4 < 6 hs = 20', puntos: 20 },
      { etiqueta: '> 6 hs = 40', puntos: 40 },
    ],
  },
  {
    codigo: 'clima',
    texto:
      '¿Cuáles son las condiciones meteorológicas y de visibilidad durante el viaje (lluvia, vientos fuertes, niebla, etc.)?',
    opciones: [
      { etiqueta: 'Bueno = 0', puntos: 0 },
      { etiqueta: 'Regular = 10', puntos: 10 },
      { etiqueta: 'Deficiente = 25', puntos: 25 },
    ],
  },
  {
    codigo: 'camino',
    texto: '¿Cuál es la condición del camino y la topografía?',
    opciones: [
      { etiqueta: 'Bueno = 0', puntos: 0 },
      { etiqueta: 'Regular = 5', puntos: 5 },
      { etiqueta: 'Deficiente = 15', puntos: 15 },
    ],
  },
  {
    codigo: 'seguridad_ruta',
    texto:
      '¿Existen cuestiones de seguridad a tener en cuenta (alto riesgo de rapto, secuestro, disturbios sociales, robo de material peligroso, etc.)?',
    opciones: [
      { etiqueta: 'NO = 0', puntos: 0 },
      { etiqueta: '**Sí, MITIGADO = 40', puntos: 40 },
      { etiqueta: 'Sí = 75 No viaja', puntos: 75 },
    ],
  },
  {
    codigo: 'materiales_peligrosos',
    texto:
      '¿Los Materiales Peligrosos y/o Controlados son enviados con la documentación necesaria, en vehículos apropiados y el conductor es certificado?',
    opciones: [
      { etiqueta: 'NO = 50 no viaja', puntos: 50 },
      { etiqueta: 'N/A = 0', puntos: 0 },
      { etiqueta: 'Sí = 0', puntos: 0 },
    ],
  },
];

/** Quién autoriza cada nivel (indicado por el negocio el 18/10/2026): BAJO y MEDIO el Supervisor; ALTO un gerente (permiso `autorizar_mayor`). */
export const UMBRALES_RIESGO = [
  {
    nivel: 'bajo',
    desdePuntos: 0,
    permisoAutoriza: 'flota.viajes.aprobar',
    descripcion:
      'Viaje de rutina con bajo riesgo: requiere la autorización del Supervisor de Pumping antes de viajar.',
  },
  {
    nivel: 'medio',
    desdePuntos: 31,
    permisoAutoriza: 'flota.viajes.aprobar',
    descripcion: 'Riesgo medio: requiere la autorización del Supervisor antes de viajar.',
  },
  {
    nivel: 'alto',
    desdePuntos: 76,
    permisoAutoriza: 'flota.viajes.autorizar_mayor',
    descripcion:
      'Riesgo alto: requiere la autorización de un gerente (Gerente HSE o Jefe de Base) y, además, el visto bueno del Director General (Quito), fuera del alcance del sistema.',
  },
] as const;

export async function sembrarViaje(prisma: PrismaClient) {
  let preguntas = 0;
  for (const [i, p] of PREGUNTAS_RIESGO.entries()) {
    if (await prisma.preguntaRiesgoViaje.findUnique({ where: { codigo: p.codigo } })) continue;
    await prisma.preguntaRiesgoViaje.create({
      data: {
        id: uuidv7(),
        codigo: p.codigo,
        orden: i + 1,
        texto: p.texto,
        opciones: {
          create: p.opciones.map((o, k) => ({
            id: uuidv7(),
            orden: k + 1,
            etiqueta: o.etiqueta,
            puntos: o.puntos,
            impideConducir: o.impide ?? false,
          })),
        },
      },
    });
    preguntas++;
  }
  const umbrales = await prisma.umbralRiesgoViaje.createMany({
    data: UMBRALES_RIESGO.map((u) => ({ ...u })),
    skipDuplicates: true,
  });
  return { preguntas, umbrales: umbrales.count };
}
