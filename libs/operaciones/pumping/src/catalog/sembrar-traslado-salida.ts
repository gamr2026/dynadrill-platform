import { createHash } from 'node:crypto';
import { uuidv7 } from '@dyn/utils';
import type {
  AmbitoRequisito,
  GasIngreso,
  ModuloDueno,
  PrismaClient,
  SeccionInspeccion,
} from '../generated/client';

type Cliente = Pick<
  PrismaClient,
  'requisito' | 'pasoRequisito' | 'terminosVersion' | 'gasLimite' | 'lotoItem' | 'inspeccionItem'
>;

/** Códigos de los requisitos del traslado de salida (los usa el código; el catálogo vive en la base de datos). */
export const REQ = {
  inspeccionRealizada: 'inspeccion_vehiculo_realizada',
  inspeccionAprobada: 'inspeccion_vehiculo_aprobada',
  ingresoLocacion: 'checklist_ingreso_locacion',
  epiDespachado: 'epi_despachado',
  terminos: 'terminos_aceptados',
  reporteSalida: 'reporte_unidad_salida',
  gerenciamientoSalida: 'gerenciamiento_viaje_salida_aprobado',
  gerenciamientoRetorno: 'gerenciamiento_viaje_retorno_aprobado',
  ejecucionFormalizada: 'ejecucion_formalizada',
  reporteLlegada: 'reporte_unidad_llegada',
  actaEntregaLocacion: 'acta_entrega_locacion',
} as const;

interface RequisitoDef {
  codigo: string;
  nombre: string;
  descripcion: string;
  ambito: AmbitoRequisito;
  modulo: ModuloDueno;
  /** Paso del que se SALE cuando se cumple. */
  paso: string;
}

export const REQUISITOS: RequisitoDef[] = [
  {
    codigo: REQ.inspeccionRealizada,
    nombre: 'Inspección de vehículos realizada',
    descripcion: 'El operador realizó la Inspección de Vehículos (DYN-SGI-RE-068) de su unidad.',
    ambito: 'unidad',
    modulo: 'flota',
    paso: 'traslado_salida',
  },
  {
    codigo: REQ.ingresoLocacion,
    nombre: 'Checklist de ingreso a locación',
    descripcion:
      'Ingreso a locación y verificaciones de seguridad completos (gases, LOTO y confirmaciones). Se hace al llegar al sitio, al iniciar la ejecución.',
    ambito: 'ticket',
    modulo: 'pumping',
    paso: 'ejecucion_operativa',
  },
  {
    codigo: REQ.epiDespachado,
    nombre: 'Entrega de EPI despachada',
    descripcion: 'QHSE despachó el equipo de protección individual al operador.',
    ambito: 'operador',
    modulo: 'qhse',
    paso: 'traslado_salida',
  },
  {
    codigo: REQ.terminos,
    nombre: 'Términos y condiciones aceptados',
    descripcion:
      'El operador aceptó la versión vigente de los términos y condiciones de uso de equipos.',
    ambito: 'operador',
    modulo: 'pumping',
    paso: 'traslado_salida',
  },
  {
    codigo: REQ.reporteSalida,
    nombre: 'Reporte de unidad de salida',
    descripcion: 'El operador firmó el Reporte de Unidad (DYN-MNT-RE-012) de salida de su unidad.',
    ambito: 'unidad',
    modulo: 'pumping',
    paso: 'traslado_salida',
  },
  {
    codigo: REQ.inspeccionAprobada,
    nombre: 'Inspección de vehículos aprobada',
    descripcion: 'El supervisor aprobó la Inspección de Vehículos de la unidad.',
    ambito: 'unidad',
    modulo: 'flota',
    paso: 'revision_reportes_salida',
  },
  {
    codigo: REQ.gerenciamientoSalida,
    nombre: 'Gerenciamiento de viaje de salida aprobado',
    descripcion:
      'El Gerenciamiento de Viaje (DYN-SGI-RE-049) de salida que solicitó el Conductor de la unidad está aprobado.',
    ambito: 'unidad',
    modulo: 'flota',
    paso: 'revision_reportes_salida',
  },
  {
    codigo: REQ.gerenciamientoRetorno,
    nombre: 'Gerenciamiento de viaje de retorno aprobado',
    descripcion:
      'El Gerenciamiento de Viaje (DYN-SGI-RE-049) de retorno que solicitó el Conductor de la unidad está aprobado.',
    ambito: 'unidad',
    modulo: 'flota',
    paso: 'control_retorno',
  },
  {
    codigo: REQ.ejecucionFormalizada,
    nombre: 'Formalización de la ejecución',
    descripcion:
      'El Supervisor confirmó que el Company Man aprobó el inicio de la ejecución (se hace junto con el checklist de ingreso a locación).',
    ambito: 'ticket',
    modulo: 'pumping',
    paso: 'ejecucion_operativa',
  },
  {
    codigo: REQ.reporteLlegada,
    nombre: 'Reporte de unidad de llegada',
    descripcion: 'El operador firmó el Reporte de Unidad (DYN-MNT-RE-012) de llegada de su unidad.',
    ambito: 'unidad',
    modulo: 'pumping',
    paso: 'traslado_llegada',
  },
  {
    codigo: REQ.actaEntregaLocacion,
    nombre: 'Acta de Entrega de Locación cargada',
    descripcion:
      'QHSE cargó el Acta de Entrega de Locación (DYN-PMP-RE-027). Se exige para dar el servicio por cerrado.',
    ambito: 'ticket',
    modulo: 'qhse',
    paso: 'revision_final',
  },
];

const TERMINOS_TITULO =
  'Términos y condiciones de uso de equipos y unidades — Servicios de Pumping';
/** Borrador de la demo (PUMP-TyC-v1). Pendiente de validación de QHSE/Legal (ver el plan del paso). */
const TERMINOS_TEXTO = [
  'Yo, el operador identificado en este registro, declaro que:',
  '1. Recepción. Recibo la unidad y los equipos asignados a este servicio en el estado registrado en la inspección de salida, y he verificado su funcionamiento antes de operarlos.',
  '2. Competencia. Estoy capacitado y autorizado para operar estos equipos, y no los operaré si no me siento apto físicamente o bajo los efectos de alcohol, drogas o medicamentos que afecten mi atención.',
  '3. Uso adecuado. Usaré los equipos solo para las actividades del servicio asignado, siguiendo los procedimientos de Dynadrill, el manual del fabricante, el ART/PT vigentes y las indicaciones del Supervisor. No modificaré, anularé ni puentearé dispositivos de seguridad.',
  '4. EPI. Usaré en todo momento el equipo de protección individual entregado para la tarea.',
  '5. Reporte. Reportaré de inmediato al Supervisor cualquier falla, daño, incidente, casi-accidente o condición insegura, y detendré la operación si pone en riesgo a personas, al ambiente o al equipo (derecho a detener el trabajo).',
  '6. Terceros. No permitiré que personas no autorizadas operen los equipos a mi cargo.',
  '7. Responsabilidad. Entiendo que el uso contrario a estas condiciones o a los procedimientos de la empresa puede generar medidas disciplinarias conforme al reglamento interno, y que esta aceptación quedará registrada como constancia.',
  '8. Devolución. Devolveré la unidad y los equipos al finalizar el servicio, informando su estado en la inspección de llegada.',
  'Al aceptar, declaro haber leído y comprendido estas condiciones.',
].join('\n\n');
export const TERMINOS_CODIGO = 'PUMP-TyC-v1';
export const hashTexto = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex');

const GASES: Array<{
  gas: GasIngreso;
  nombre: string;
  unidad: string;
  minimo: number | null;
  maximo: number;
}> = [
  { gas: 'h2s', nombre: 'H2S (Ácido Sulfhídrico)', unidad: 'ppm', minimo: null, maximo: 10 },
  { gas: 'lel', nombre: 'LEL (Límite Explosivo Inferior)', unidad: '%', minimo: null, maximo: 10 },
  { gas: 'o2', nombre: 'O2 (Oxígeno)', unidad: '%', minimo: 19.5, maximo: 23.5 },
  { gas: 'co', nombre: 'CO (Monóxido de Carbono)', unidad: 'ppm', minimo: null, maximo: 25 },
];

const LOTO = [
  'Válvulas bloqueadas con candado',
  'Etiquetas "NO OPERAR" visibles',
  'Líneas despresorizadas',
  'Prueba de cero energía realizada',
];

/** Ítems del formulario físico DYN-MNT-RE-012 (de la demo), por sección y en su orden. */
export const INSPECCION: Record<SeccionInspeccion, string[]> = {
  chasis: [
    'Condición/nivel de refrigerante',
    'Correas',
    'Aceite del motor: nivel y presión normal',
    'Mangueras y abrazaderas del motor',
    'Filtros y sistema de combustible',
    'Instrumental de cabina',
    'Presión del sistema neumático',
    'Parabrisas / limpiaparabrisas',
    'Luces del vehículo',
    'Conexiones de tráiler / quinta rueda',
    'Neumáticos, condición / PSI',
    'Frenos regulados, pérdidas de aire',
    'Instrumentación / electrónica (test)',
    'Sistema de monitoreo de conducción',
    'Pruebas operativas previas',
    'Mecanismos y mandos operacionales',
    'Equipos aux. (generador, compresor, etc.)',
    'Documentos del vehículo',
    'Cinturones de seguridad',
    'Otros ítems que afecten la seguridad',
  ],
  motor: [
    'Motor: rendimiento, ruidos, etc.',
    'Transmisión',
    'Diferenciales',
    'Dirección',
    'Frenos',
    'Embrague',
    'Radiadores',
    'Mangueras',
    'Cardanes',
    'Neumáticos',
    'Instrumental de cabina',
    'Luces, instalación eléctrica',
    'Suspensión',
    'Cables',
    'Sensores (presión, temp., etc.)',
    'Conexiones externas',
    'Estabilizadores',
    'Boom-tornamesa',
    'Poleas',
    'Otros',
  ],
  equipo: [
    'Motores/transmisiones',
    'Radiadores (niveles) y mangueras',
    'Aceites (contaminación y niveles)',
    'Filtros y sistema de diésel (combustible)',
    'Sistema hidráulico',
    'Sistema neumático',
    'Fluid End - Power End',
    'Cardanes y protecciones',
    'Centrífugas',
    'Equipos aux. (generador, compresor, etc.)',
    'Instalación eléctrica',
    'Instrumentos panel del operador',
    'Pare de emergencia',
    'Manifold y líneas de alta y baja presión',
    'Sistema de mezcla - recirculador',
    'Inyector - BOP - Reel - Cabina de control',
  ],
  instrumentacion: [
    'Sistema de adquisición de datos (DAS)',
    'Controladores',
    'Monitores, indicadores, etc.',
  ],
};

/** Idempotente: lo que ya existe no se toca. */
export async function sembrarTrasladoSalida(
  db: Cliente,
): Promise<{ requisitos: number; items: number }> {
  let requisitos = 0;
  let items = 0;

  for (const r of REQUISITOS) {
    if (
      !(await db.requisito.findUnique({ where: { codigo: r.codigo }, select: { codigo: true } }))
    ) {
      await db.requisito.create({
        data: {
          codigo: r.codigo,
          nombre: r.nombre,
          descripcion: r.descripcion,
          ambito: r.ambito,
          modulo: r.modulo,
        },
      });
      requisitos++;
    }
    const existe = await db.pasoRequisito.findUnique({
      where: { pasoCodigo_requisitoCodigo: { pasoCodigo: r.paso, requisitoCodigo: r.codigo } },
      select: { pasoCodigo: true },
    });
    if (!existe)
      await db.pasoRequisito.create({ data: { pasoCodigo: r.paso, requisitoCodigo: r.codigo } });
  }

  if (
    !(await db.terminosVersion.findUnique({
      where: { codigo: TERMINOS_CODIGO },
      select: { codigo: true },
    }))
  ) {
    await db.terminosVersion.create({
      data: {
        codigo: TERMINOS_CODIGO,
        titulo: TERMINOS_TITULO,
        texto: TERMINOS_TEXTO,
        textoHash: hashTexto(TERMINOS_TEXTO),
        vigente: true,
      },
    });
    items++;
  }

  for (const g of GASES) {
    if (!(await db.gasLimite.findUnique({ where: { gas: g.gas }, select: { gas: true } }))) {
      await db.gasLimite.create({ data: g });
      items++;
    }
  }
  for (const [i, etiqueta] of LOTO.entries()) {
    if (!(await db.lotoItem.findUnique({ where: { etiqueta }, select: { id: true } }))) {
      await db.lotoItem.create({ data: { id: uuidv7(), orden: i + 1, etiqueta } });
      items++;
    }
  }
  for (const [seccion, etiquetas] of Object.entries(INSPECCION) as Array<
    [SeccionInspeccion, string[]]
  >) {
    for (const [i, etiqueta] of etiquetas.entries()) {
      const existe = await db.inspeccionItem.findUnique({
        where: { seccion_etiqueta: { seccion, etiqueta } },
        select: { id: true },
      });
      if (!existe) {
        await db.inspeccionItem.create({ data: { id: uuidv7(), seccion, orden: i + 1, etiqueta } });
        items++;
      }
    }
  }
  return { requisitos, items };
}
