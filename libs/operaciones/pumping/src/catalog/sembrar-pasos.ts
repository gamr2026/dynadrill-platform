import { uuidv7 } from '@dyn/utils';
import type { MacroEstado, PrismaClient } from '../generated/client';

type Cliente = Pick<PrismaClient, 'paso' | 'pasoRol' | 'transicion'>;

interface PasoDef {
  codigo: string;
  nombre: string;
  macro: MacroEstado;
  roles: string[];
  terminal?: boolean;
}

const SUPERVISORES = ['supervisor', 'supervisor_pumping'];

/**
 * Los 10 pasos del servicio de Pumping (el mantenimiento salió del flujo: ahora es una tarjeta aparte y no bloquea) y quién actúa en cada uno (de `PUMPING_STEP_ROLE` y `PUMPING_STEP_MACRO` de la
 * demo). La asignación completa (supervisor, operadores, unidades y químicos) es del Jefe de Base.
 */
export const PASOS: PasoDef[] = [
  {
    codigo: 'revision_inicial',
    nombre: 'Revisión inicial',
    macro: 'pendiente',
    roles: ['jefe_base'],
  },
  { codigo: 'asignacion', nombre: 'Asignación', macro: 'en_proceso', roles: ['jefe_base'] },
  {
    codigo: 'traslado_salida',
    nombre: 'Traslado de salida',
    macro: 'en_proceso',
    roles: ['operador'],
  },
  {
    codigo: 'revision_reportes_salida',
    nombre: 'Revisión de reportes de salida',
    macro: 'en_proceso',
    roles: SUPERVISORES,
  },
  {
    codigo: 'ejecucion_operativa',
    nombre: 'Ejecución operativa',
    macro: 'en_proceso',
    roles: ['operador'],
  },
  {
    codigo: 'control_retorno',
    nombre: 'Control de retorno',
    macro: 'en_proceso',
    roles: SUPERVISORES,
  },
  {
    codigo: 'traslado_llegada',
    nombre: 'Traslado de llegada',
    macro: 'en_proceso',
    roles: ['operador'],
  },
  {
    codigo: 'revision_reportes_llegada',
    nombre: 'Revisión de reportes de llegada',
    macro: 'en_proceso',
    roles: SUPERVISORES,
  },
  {
    codigo: 'revision_final',
    nombre: 'Revisión final',
    macro: 'esperando_aprobacion',
    roles: SUPERVISORES,
  },
  { codigo: 'cierre', nombre: 'Cierre', macro: 'aprobado', roles: SUPERVISORES, terminal: true },
];

/**
 * Pasos que el módulo ya sabe validar. Se agregan por fases, cada uno con sus condiciones (asignación completa, checklist
 * de QHSE, entrega de EPI, reportes...): por eso hoy solo existe el de la revisión inicial.
 */
export const TRANSICIONES: Array<{ de: string; a: string; motivo?: boolean }> = [
  { de: 'revision_inicial', a: 'asignacion' },
  // Salir de Traslado de salida exige los requisitos del paso (ver `paso_requisito`)
  { de: 'traslado_salida', a: 'revision_reportes_salida' },
];

/** Idempotente: lo que ya existe no se toca. */
export async function sembrarPasos(db: Cliente): Promise<{ pasos: number; transiciones: number }> {
  let pasos = 0;
  let transiciones = 0;
  for (const [i, p] of PASOS.entries()) {
    if (!(await db.paso.findUnique({ where: { codigo: p.codigo }, select: { codigo: true } }))) {
      await db.paso.create({
        data: {
          codigo: p.codigo,
          nombre: p.nombre,
          macro: p.macro,
          orden: (i + 1) * 10,
          terminal: p.terminal ?? false,
        },
      });
      for (const rol of p.roles)
        await db.pasoRol.create({ data: { pasoCodigo: p.codigo, rolCodigo: rol } });
      pasos++;
    }
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
        },
      });
      transiciones++;
    }
  }
  return { pasos, transiciones };
}
