import { uuidv7 } from '@dyn/utils';
import type { PrismaClient } from '../generated/client';

type Cliente = Pick<
  PrismaClient,
  'tipoSuborden' | 'estadoSuborden' | 'transicionSuborden' | 'contador'
>;

/** Códigos de los estados de la sub-orden (los mismos que siembra este archivo). */
export const ESTADO = {
  pendiente: 'pendiente',
  enDiagnostico: 'en_diagnostico',
  enEjecucion: 'en_ejecucion',
  enRevisionCierre: 'en_revision_cierre',
  cerrado: 'cerrado',
  correccionSolicitada: 'correccion_solicitada',
  derivadoAPumping: 'derivado_a_pumping',
} as const;

/** Códigos de los tipos de sub-orden. */
export const TIPO = {
  mecanico: 'mecanico',
  instrumental: 'instrumental',
  operativo: 'operativo',
} as const;

/** Clave del contador del número de reporte. */
export const CONTADOR_REPORTE = 'reporte';

const TIPOS = [
  { codigo: TIPO.mecanico, nombre: 'Mecánico', sufijo: 'M', asignable: true, orden: 1 },
  { codigo: TIPO.instrumental, nombre: 'Instrumental', sufijo: 'I', asignable: true, orden: 2 },
  // El Operativo no se asigna a un mecánico: lo atiende el operador de Pumping/FCR y lo revisa el Supervisor.
  { codigo: TIPO.operativo, nombre: 'Operativo', sufijo: 'O', asignable: false, orden: 3 },
];

const ESTADOS = [
  { codigo: ESTADO.pendiente, nombre: 'Pendiente', orden: 1, resuelta: false },
  { codigo: ESTADO.enDiagnostico, nombre: 'En diagnóstico', orden: 2, resuelta: false },
  { codigo: ESTADO.enEjecucion, nombre: 'En ejecución', orden: 3, resuelta: false },
  { codigo: ESTADO.enRevisionCierre, nombre: 'En revisión de cierre', orden: 4, resuelta: false },
  { codigo: ESTADO.correccionSolicitada, nombre: 'Corrección solicitada', orden: 5, resuelta: false },
  { codigo: ESTADO.cerrado, nombre: 'Cerrado', orden: 6, resuelta: true },
  // Derivada a Pumping cuenta como resuelta para aceptar la orden (regla de la demo): ya no depende de Mantenimiento.
  { codigo: ESTADO.derivadoAPumping, nombre: 'Derivado a Pumping', orden: 7, resuelta: true },
];

interface TransicionDef {
  origen: string;
  destino: string;
  tipo?: string;
  requiereNota?: boolean;
}

/**
 * Transiciones de la sub-orden (la máquina de estados vive en la base, como los pasos de Pumping). Se derivan de la demo:
 * guardar avance (→ en ejecución), enviar a revisión, aprobar el cierre, solicitar corrección (con nota) y derivar a Pumping
 * (solo el Operativo, con nota).
 */
const TRANSICIONES: TransicionDef[] = [
  { origen: ESTADO.pendiente, destino: ESTADO.enDiagnostico },
  { origen: ESTADO.pendiente, destino: ESTADO.enEjecucion },
  { origen: ESTADO.enDiagnostico, destino: ESTADO.enEjecucion },
  { origen: ESTADO.enEjecucion, destino: ESTADO.enRevisionCierre },
  { origen: ESTADO.enRevisionCierre, destino: ESTADO.cerrado },
  { origen: ESTADO.enRevisionCierre, destino: ESTADO.correccionSolicitada, requiereNota: true },
  { origen: ESTADO.correccionSolicitada, destino: ESTADO.enEjecucion },
  { origen: ESTADO.correccionSolicitada, destino: ESTADO.enRevisionCierre },
  { origen: ESTADO.pendiente, destino: ESTADO.derivadoAPumping, tipo: TIPO.operativo, requiereNota: true },
  { origen: ESTADO.derivadoAPumping, destino: ESTADO.enEjecucion, tipo: TIPO.operativo },
  { origen: ESTADO.derivadoAPumping, destino: ESTADO.enRevisionCierre, tipo: TIPO.operativo },
];

/** Siembra idempotente de los catálogos del módulo. Devuelve cuántos registros nuevos creó. */
export async function sembrarCatalogos(prisma: Cliente) {
  let tipos = 0;
  for (const t of TIPOS) {
    const existe = await prisma.tipoSuborden.findUnique({ where: { codigo: t.codigo } });
    if (!existe) {
      await prisma.tipoSuborden.create({ data: { id: uuidv7(), ...t } });
      tipos++;
    }
  }
  let estados = 0;
  for (const e of ESTADOS) {
    const existe = await prisma.estadoSuborden.findUnique({ where: { codigo: e.codigo } });
    if (!existe) {
      await prisma.estadoSuborden.create({ data: { id: uuidv7(), ...e } });
      estados++;
    }
  }
  const estadoId = new Map((await prisma.estadoSuborden.findMany()).map((e) => [e.codigo, e.id]));
  const tipoId = new Map((await prisma.tipoSuborden.findMany()).map((t) => [t.codigo, t.id]));
  let transiciones = 0;
  for (const t of TRANSICIONES) {
    const origenId = estadoId.get(t.origen);
    const destinoId = estadoId.get(t.destino);
    const tId = t.tipo ? tipoId.get(t.tipo) : null;
    if (!origenId || !destinoId || tId === undefined) {
      throw new Error(`Transición con un código que no existe: ${t.origen} → ${t.destino}`);
    }
    const existe = await prisma.transicionSuborden.findFirst({
      where: { origenId, destinoId, tipoId: tId },
    });
    if (!existe) {
      await prisma.transicionSuborden.create({
        data: { id: uuidv7(), origenId, destinoId, tipoId: tId, requiereNota: t.requiereNota ?? false },
      });
      transiciones++;
    }
  }
  // El número del reporte empieza en 0 (el primero es R0001). ¿Continúa la numeración del formulario físico? Ver CONSULTAS-PARA-DYNADRILL.md.
  await prisma.contador.upsert({
    where: { clave: CONTADOR_REPORTE },
    update: {},
    create: { clave: CONTADOR_REPORTE, valor: 0 },
  });
  return { tipos, estados, transiciones };
}
