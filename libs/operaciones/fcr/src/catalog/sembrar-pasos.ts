import { uuidv7 } from '@dyn/utils';
import type {
  AmbitoRequisito,
  MacroEstado,
  ModuloDueno,
  PrismaClient,
  TipoOt,
} from '../generated/client';

type Cliente = Pick<
  PrismaClient,
  | 'paso'
  | 'pasoRol'
  | 'transicion'
  | 'entradaOt'
  | 'requisito'
  | 'pasoRequisito'
  | 'tipoOperador'
  | 'tipoCompletacion'
  | 'tipoTrabajo'
  | 'tipoPicker'
  | 'unidadCotizacion'
  | 'firmaRolPermitido'
>;

/** Códigos de los requisitos (los usa el código; el catálogo vive en la base de datos). */
export const REQ = {
  tipoOperadorDefinido: 'tipo_operador_definido',
  listadoConfirmado: 'listado_herramientas_confirmado',
  herramientasRecibidas: 'herramientas_recibidas',
  inspeccionesEnviadas: 'inspecciones_enviadas',
  formularioInspeccionExterno: 'formulario_inspeccion_externo',
} as const;

interface PasoDef {
  codigo: string;
  nombre: string;
  macro: MacroEstado;
  roles: string[];
  /** Falso: cualquier cuenta del rol actúa (arranque del ticket y Bodega); verdadero: solo el equipo asignado. */
  requiereEquipo?: boolean;
  terminal?: boolean;
}

/**
 * Los pasos del servicio de FCR y quién actúa en cada uno (`FCR_PHASE_ROLE` y `FCR_PHASE_MACRO` de la demo `main`).
 *
 * Entrada VENTA:    revision_inicial → preparacion_herramientas
 * Entrada SERVICIOS: tipo_operador → inspeccion → aprobacion_supervisor_operaciones → preparacion_herramientas
 * Tronco común:     preparacion_herramientas → asignacion → reunion_operativa → ejecucion_operativa → revision_reportes
 *                   → control_retorno → cierre → cerrado
 */
export const PASOS: PasoDef[] = [
  {
    codigo: 'revision_inicial',
    nombre: 'Revisión inicial',
    macro: 'pendiente',
    roles: ['supervisor'],
    requiereEquipo: false,
  },
  {
    codigo: 'tipo_operador',
    nombre: 'Tipo de operador',
    macro: 'en_proceso',
    roles: ['supervisor'],
    requiereEquipo: false,
  },
  { codigo: 'inspeccion', nombre: 'Inspección', macro: 'en_proceso', roles: ['operador_fcr'] },
  {
    codigo: 'aprobacion_supervisor_operaciones',
    nombre: 'Aprobación del Supervisor de Operaciones',
    macro: 'esperando_aprobacion',
    roles: ['supervisor_operaciones_fcr'],
    requiereEquipo: false,
  },
  {
    codigo: 'preparacion_herramientas',
    nombre: 'Preparación de herramientas',
    macro: 'en_proceso',
    roles: ['supervisor'],
  },
  { codigo: 'asignacion', nombre: 'Asignación', macro: 'en_proceso', roles: ['supervisor'] },
  {
    codigo: 'reunion_operativa',
    nombre: 'Reunión operativa',
    macro: 'en_proceso',
    roles: ['supervisor'],
  },
  {
    codigo: 'ejecucion_operativa',
    nombre: 'Ejecución operativa',
    macro: 'en_proceso',
    roles: ['operador_fcr'],
  },
  {
    codigo: 'revision_reportes',
    nombre: 'Revisión de reportes',
    macro: 'en_proceso',
    roles: ['supervisor'],
  },
  {
    codigo: 'control_retorno',
    nombre: 'Control de retorno',
    macro: 'en_proceso',
    roles: ['bodeguero'],
    requiereEquipo: false,
  },
  {
    codigo: 'cierre',
    nombre: 'Cierre',
    macro: 'esperando_aprobacion',
    roles: ['supervisor'],
  },
  {
    codigo: 'cerrado',
    nombre: 'Cerrado',
    macro: 'aprobado',
    roles: ['supervisor'],
    terminal: true,
  },
];

/** Paso en el que nace el ticket según el tipo de OT del pedido: lo único que separa los dos recorridos. */
export const ENTRADAS: Array<{ tipoOt: TipoOt; paso: string }> = [
  { tipoOt: 'venta', paso: 'revision_inicial' },
  { tipoOt: 'servicio', paso: 'tipo_operador' },
];

export const TRANSICIONES: Array<{
  de: string;
  a: string;
  motivo?: boolean;
  /** Falso en los rechazos: salir hacia atrás no exige los requisitos del paso. */
  exigeRequisitos?: boolean;
  /** Verdadero: la hace una acción propia (aprobar, rechazar, asignar), no el avance genérico. */
  porAccion?: boolean;
}> = [
  // Entrada VENTA: validación del programa
  { de: 'revision_inicial', a: 'preparacion_herramientas' },
  // Entrada SERVICIOS
  { de: 'tipo_operador', a: 'inspeccion' },
  { de: 'inspeccion', a: 'aprobacion_supervisor_operaciones' },
  { de: 'aprobacion_supervisor_operaciones', a: 'preparacion_herramientas', porAccion: true },
  {
    de: 'aprobacion_supervisor_operaciones',
    a: 'inspeccion',
    motivo: true,
    exigeRequisitos: false,
    porAccion: true,
  },
  // Tronco común. La asignación (`asignacion` → `reunion_operativa`) la hace el servicio de asignación (acción propia).
  { de: 'asignacion', a: 'reunion_operativa', porAccion: true },
  { de: 'preparacion_herramientas', a: 'asignacion' },
  { de: 'reunion_operativa', a: 'ejecucion_operativa' },
  { de: 'ejecucion_operativa', a: 'revision_reportes' },
  { de: 'revision_reportes', a: 'control_retorno' },
  { de: 'revision_reportes', a: 'ejecucion_operativa', motivo: true, exigeRequisitos: false },
  { de: 'control_retorno', a: 'cierre' },
  { de: 'cierre', a: 'cerrado' },
];

interface RequisitoDef {
  codigo: string;
  nombre: string;
  descripcion: string;
  ambito: AmbitoRequisito;
  modulo: ModuloDueno;
  tipoOt?: TipoOt;
  /** Paso del que se SALE cuando se cumple. */
  paso: string;
}

export const REQUISITOS: RequisitoDef[] = [
  {
    codigo: REQ.inspeccionesEnviadas,
    nombre: 'Inspecciones de herramientas enviadas',
    descripcion:
      'Cada herramienta del ticket tiene su inspección firmada y enviada (y al menos hay una herramienta).',
    ambito: 'ticket',
    modulo: 'fcr',
    tipoOt: 'servicio',
    paso: 'inspeccion',
  },
  {
    codigo: REQ.formularioInspeccionExterno,
    nombre: 'Formulario de inspección externo adjunto',
    descripcion: 'El operador adjuntó el formulario de inspección externo (consulta F-9).',
    ambito: 'ticket',
    modulo: 'fcr',
    tipoOt: 'servicio',
    paso: 'inspeccion',
  },
  {
    codigo: REQ.tipoOperadorDefinido,
    nombre: 'Tipo de operador definido',
    descripcion:
      'El Supervisor eligió el tipo de operador (mecánico o soldador) y el operador FCR que repara e inspecciona las herramientas.',
    ambito: 'ticket',
    modulo: 'fcr',
    tipoOt: 'servicio',
    paso: 'tipo_operador',
  },
  {
    codigo: REQ.listadoConfirmado,
    nombre: 'Listado de herramientas confirmado',
    descripcion:
      'El Supervisor confirmó que el listado de herramientas del ticket está completo (se puede deshacer mientras el ticket siga en la preparación).',
    ambito: 'ticket',
    modulo: 'fcr',
    paso: 'preparacion_herramientas',
  },
  {
    codigo: REQ.herramientasRecibidas,
    nombre: 'Herramientas recibidas',
    descripcion:
      'Cada herramienta del ticket fue preparada por Bodega y recibida por el Supervisor, sin novedades pendientes.',
    ambito: 'ticket',
    modulo: 'fcr',
    paso: 'preparacion_herramientas',
  },
];

/** Quién puede dejar cada firma de la inspección (roles de cuenta). */
const FIRMAS_PERMITIDAS = [
  ['reparado_por', 'operador_fcr'],
  ['revisado_por', 'supervisor'],
  ['liberado_qhse', 'tecnico_hse'],
  ['liberado_qhse', 'gerente_hse'],
] as const;

/** Unidades de cotización: las de tiempo piden un solo juego del kit. El código es el nombre sin tildes, en minúscula y en singular. */
const UNIDADES_COTIZACION = [
  ['dia', 'Día', true],
  ['hora', 'Hora', true],
  ['semana', 'Semana', true],
  ['mes', 'Mes', true],
  ['corrida', 'Corrida', false],
  ['unidad', 'Unidad', false],
  ['servicio', 'Servicio', false],
] as const;

const CATALOGOS = {
  tipoOperador: [
    ['mecanico', 'Mecánico'],
    ['soldador', 'Soldador'],
  ],
  tipoCompletacion: [
    ['selectiva', 'Selectiva'],
    ['inyeccion', 'Inyección'],
    ['power_oil', 'Power OIL'],
  ],
  tipoTrabajo: [
    ['fractura', 'Fractura'],
    ['estimulacion', 'Estimulación'],
    ['evaluacion', 'Evaluación'],
    ['cemento', 'Cemento'],
    ['picking', 'Picking'],
  ],
  tipoPicker: [
    ['7_8', '7/8"'],
    ['9_5_8', '9.5/8"'],
    ['5_5_8', '5.5/8"'],
    ['5_8', '5/8"'],
  ],
} as const satisfies Record<string, ReadonlyArray<readonly [string, string]>>;

/** Idempotente: lo que ya existe no se toca (un administrador puede haberlo editado). */
export async function sembrarPasos(db: Cliente): Promise<{
  pasos: number;
  transiciones: number;
  requisitos: number;
  catalogos: number;
}> {
  let pasos = 0;
  let transiciones = 0;
  let requisitos = 0;
  let catalogos = 0;
  for (const [i, p] of PASOS.entries()) {
    if (!(await db.paso.findUnique({ where: { codigo: p.codigo }, select: { codigo: true } }))) {
      await db.paso.create({
        data: {
          codigo: p.codigo,
          nombre: p.nombre,
          macro: p.macro,
          orden: (i + 1) * 10,
          terminal: p.terminal ?? false,
          requiereEquipo: p.requiereEquipo ?? true,
        },
      });
      for (const rol of p.roles)
        await db.pasoRol.create({ data: { pasoCodigo: p.codigo, rolCodigo: rol } });
      pasos++;
    }
  }
  for (const e of ENTRADAS) {
    await db.entradaOt.upsert({
      where: { tipoOt: e.tipoOt },
      update: {},
      create: { tipoOt: e.tipoOt, pasoCodigo: e.paso },
    });
  }
  for (const t of TRANSICIONES) {
    const existe = await db.transicion.findUnique({
      where: { origenCodigo_destinoCodigo: { origenCodigo: t.de, destinoCodigo: t.a } },
      select: { id: true },
    });
    if (!existe) {
      await db.transicion.create({
        data: {
          id: uuidv7(),
          origenCodigo: t.de,
          destinoCodigo: t.a,
          requiereMotivo: t.motivo ?? false,
          exigeRequisitos: t.exigeRequisitos ?? true,
          soloPorAccion: t.porAccion ?? false,
        },
      });
      transiciones++;
    }
  }
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
          tipoOt: r.tipoOt ?? null,
        },
      });
      await db.pasoRequisito.create({ data: { pasoCodigo: r.paso, requisitoCodigo: r.codigo } });
      requisitos++;
    }
  }
  catalogos += await sembrarCatalogo(db.tipoOperador, CATALOGOS.tipoOperador);
  catalogos += await sembrarCatalogo(db.tipoCompletacion, CATALOGOS.tipoCompletacion);
  catalogos += await sembrarCatalogo(db.tipoTrabajo, CATALOGOS.tipoTrabajo);
  catalogos += await sembrarCatalogo(db.tipoPicker, CATALOGOS.tipoPicker);
  for (const [i, [codigo, nombre, esTiempo]] of UNIDADES_COTIZACION.entries()) {
    if (await db.unidadCotizacion.findUnique({ where: { codigo }, select: { id: true } })) continue;
    await db.unidadCotizacion.create({
      data: { id: uuidv7(), codigo, nombre, esTiempo, orden: (i + 1) * 10 },
    });
    catalogos++;
  }
  for (const [rolFirma, rolCodigo] of FIRMAS_PERMITIDAS) {
    await db.firmaRolPermitido.upsert({
      where: { rolFirma_rolCodigo: { rolFirma, rolCodigo } },
      update: {},
      create: { rolFirma, rolCodigo },
    });
  }
  return { pasos, transiciones, requisitos, catalogos };
}

interface CatalogoDelegate {
  findUnique(a: {
    where: { codigo: string };
    select: { id: true };
  }): Promise<{ id: string } | null>;
  create(a: {
    data: { id: string; codigo: string; nombre: string; orden: number };
  }): Promise<unknown>;
}

async function sembrarCatalogo(
  tabla: CatalogoDelegate,
  filas: ReadonlyArray<readonly [string, string]>,
): Promise<number> {
  let n = 0;
  for (const [i, [codigo, nombre]] of filas.entries()) {
    if (await tabla.findUnique({ where: { codigo }, select: { id: true } })) continue;
    await tabla.create({ data: { id: uuidv7(), codigo, nombre, orden: (i + 1) * 10 } });
    n++;
  }
  return n;
}
