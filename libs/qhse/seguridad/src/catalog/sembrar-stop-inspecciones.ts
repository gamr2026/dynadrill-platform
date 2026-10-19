import { uuidv7 } from '@dyn/utils';
import { BloqueStop, type PrismaClient } from '../generated/client';

/** Subcategorías e ítems del formato DYN-SGI-RE-008 (Tarjeta de observación), con el orden y el texto del formato. */
export const FORMATO_STOP: Array<{
  bloque: BloqueStop;
  codigo: string;
  nombre: string;
  items: string[];
}> = [
  {
    bloque: BloqueStop.acciones,
    codigo: 'uso_epp',
    nombre: 'Uso de EPP',
    items: [
      'Protección de la cabeza',
      'Protección de los ojos y cara',
      'Protección auditiva',
      'Protección respiratoria',
      'Protección de manos y brazos',
      'Protección de los pies',
      'Protección del cuerpo',
      'Otros',
    ],
  },
  {
    bloque: BloqueStop.acciones,
    codigo: 'herramientas_equipos',
    nombre: 'Herramientas y equipos',
    items: ['Equipos de trabajo', 'Herramientas', 'Equipos auxiliares', 'Vehículos', 'Otros'],
  },
  {
    bloque: BloqueStop.acciones,
    codigo: 'manejo_cargas',
    nombre: 'Manejo de cargas',
    items: ['Levantamiento mecánico', 'Manipulación manual'],
  },
  {
    bloque: BloqueStop.acciones,
    codigo: 'posiciones_trabajo',
    nombre: 'Posiciones de trabajo',
    items: ['Son adecuadas', 'Ergonomía / portura forzada', 'Posiciones balanceadas', 'Otros'],
  },
  {
    bloque: BloqueStop.acciones,
    codigo: 'comportamiento_oficina',
    nombre: 'Comportamiento en oficina',
    items: [
      'Cuidado del ambiente y recursos',
      'Colocación de materiales',
      'Fatiga visual',
      'Cables o material de oficina sueltos',
      'Aplicación procedimientos de antisoborno',
      'Otros',
    ],
  },
  {
    bloque: BloqueStop.condiciones,
    codigo: 'caidas_distinto_nivel',
    nombre: 'Riesgo de caídas a distinto nivel',
    items: ['Trabajos en alturas', 'Equipos anticaídas', 'Escaleras y accesos'],
  },
  {
    bloque: BloqueStop.condiciones,
    codigo: 'zona_trabajo',
    nombre: 'Seguridad en la zona de trabajo',
    items: ['Señalización', 'Entorno de trabajo'],
  },
  {
    bloque: BloqueStop.condiciones,
    codigo: 'riesgos_entorno',
    nombre: 'Riesgos del entorno',
    items: [
      'Golpeado por',
      'Contra objetos',
      'Caídas al mismo nivel',
      'Caídas a diferente nivel',
      'Altas temperaturas',
      'Energía eléctrica',
      'Exposición química',
      'Niveles altos de ruido',
      'Potencial de fuego',
      'Nivel de iluminación',
      'Vectores',
      'Contaminación',
      'Derrames',
    ],
  },
  {
    bloque: BloqueStop.condiciones,
    codigo: 'orden_limpieza',
    nombre: 'Orden y limpieza',
    items: ['Orden y limpieza en el sitio de trabajo'],
  },
  {
    bloque: BloqueStop.condiciones,
    codigo: 'seguridad_vial',
    nombre: 'Seguridad vial',
    items: [
      'Conducción de vehículos',
      'Conservación de elementos de seguridad',
      'Respeto de señalización/ Peatones',
    ],
  },
];

/**
 * Tipos de equipo de HSE-SEGUIMIENTO-001 y sus criterios de rechazo (cualquiera que falle rechaza el equipo). La eslinga se controla cada 90 días
 * (código de colores trimestral); el detector de gas y el vehículo-grúa, a diario. El vehículo-grúa es una unidad de Flota y su rechazo
 * origina un reporte de unidad para Mantenimiento; el detector exige bump test.
 */
export const TIPOS_INSPECCION: Array<{
  codigo: string;
  nombre: string;
  frecuenciaDias: number;
  requiereBumpTest: boolean;
  requiereUnidad: boolean;
  generaCasoMantenimiento: boolean;
  criterios: string[];
}> = [
  {
    codigo: 'eslinga_cable',
    nombre: 'Eslinga de cable',
    frecuenciaDias: 90,
    requiereBumpTest: false,
    requiereUnidad: false,
    generaCasoMantenimiento: false,
    criterios: [
      'Sin hilos rotos, cocas ni aplastamientos',
      'Ganchos con seguro funcional, sin deformación',
      'Etiqueta de capacidad (WLL) legible',
      'Sin corrosión ni decoloración por calor',
    ],
  },
  {
    codigo: 'detector_gas',
    nombre: 'Detector de gas',
    frecuenciaDias: 1,
    requiereBumpTest: true,
    requiereUnidad: false,
    generaCasoMantenimiento: false,
    criterios: [
      'Bump test vigente (últimas 24 h)',
      'Batería con carga suficiente para el turno',
      'Sensores sin daño físico ni obstrucción',
      'Calibración dentro del período del fabricante',
    ],
  },
  {
    codigo: 'vehiculo_grua',
    nombre: 'Vehículo-grúa',
    frecuenciaDias: 1,
    requiereBumpTest: false,
    requiereUnidad: true,
    generaCasoMantenimiento: true,
    criterios: [
      'Frenos, luces y cinturones operativos',
      'Estabilizadores y niveles sin fugas',
      'Cable/pluma sin daño visible',
      'Documentos de la unidad vigentes',
    ],
  },
];

/** Idempotente: solo agrega lo que falta y no toca lo que QHSE ya ajustó. */
export async function sembrarStopEInspecciones(
  prisma: PrismaClient,
): Promise<{ subcategorias: number; items: number; tipos: number; criterios: number }> {
  let subcategorias = 0;
  let items = 0;
  const ordenSub = new Map<BloqueStop, number>();
  for (const s of FORMATO_STOP) {
    ordenSub.set(s.bloque, (ordenSub.get(s.bloque) ?? 0) + 1);
    let sub = await prisma.stopSubcategoria.findUnique({ where: { codigo: s.codigo } });
    if (!sub) {
      sub = await prisma.stopSubcategoria.create({
        data: {
          id: uuidv7(),
          bloque: s.bloque,
          codigo: s.codigo,
          nombre: s.nombre,
          orden: ordenSub.get(s.bloque) as number,
        },
      });
      subcategorias++;
    }
    for (const [i, nombre] of s.items.entries()) {
      if (await prisma.stopItem.count({ where: { subcategoriaId: sub.id, nombre } })) continue;
      await prisma.stopItem.create({
        data: { id: uuidv7(), subcategoriaId: sub.id, nombre, orden: i + 1 },
      });
      items++;
    }
  }
  let tipos = 0;
  let criterios = 0;
  for (const [i, t] of TIPOS_INSPECCION.entries()) {
    let tipo = await prisma.inspeccionTipo.findUnique({ where: { codigo: t.codigo } });
    if (!tipo) {
      const { criterios: _c, ...datos } = t;
      void _c;
      tipo = await prisma.inspeccionTipo.create({ data: { id: uuidv7(), orden: i + 1, ...datos } });
      tipos++;
    }
    for (const [j, nombre] of t.criterios.entries()) {
      if (await prisma.inspeccionCriterio.count({ where: { tipoId: tipo.id, nombre } })) continue;
      await prisma.inspeccionCriterio.create({
        data: { id: uuidv7(), tipoId: tipo.id, nombre, orden: j + 1 },
      });
      criterios++;
    }
  }
  return { subcategorias, items, tipos, criterios };
}
