import { uuidv7 } from '@dyn/utils';
import type { PrismaClient } from '../generated/client';

/**
 * Catálogos de la inspección de vehículos (DYN-SGI-RE-068, Plan de Mantenimiento 2026, 5.4) y de los documentos del conductor.
 * Los ítems son los del formato físico (24 del vehículo y 6 del equipo). Idempotente: no pisa lo que el negocio ya haya editado.
 */

export const TIPOS_PERMISO_CONDUCTOR = [
  { codigo: 'licencia', nombre: 'Licencia de conducción', conVigencia: true, orden: 1 },
  { codigo: 'manejo_defensivo', nombre: 'Manejo defensivo', conVigencia: true, orden: 2 },
  { codigo: 'examen_medico', nombre: 'Examen médico', conVigencia: true, orden: 3 },
  {
    codigo: 'examen_psicosensometrico',
    nombre: 'Examen psicosensométrico',
    conVigencia: true,
    orden: 4,
  },
  { codigo: 'documentos_clientes', nombre: 'Documentos de clientes', conVigencia: false, orden: 5 },
  { codigo: 'vacunas', nombre: 'Certificado de vacunas', conVigencia: true, orden: 6 },
] as const;

interface ItemSemilla {
  codigo: string;
  etiqueta: string;
  bloquea?: boolean;
}

const VEHICULO: ItemSemilla[] = [
  {
    codigo: 'vidrios',
    etiqueta: 'Vidrios — buenas condiciones, no rotos, limpios, sin obstrucciones',
  },
  { codigo: 'alarma_retroceso', etiqueta: 'Alarma de retroceso — trabajando apropiadamente' },
  {
    codigo: 'suspension',
    etiqueta: 'Suspensión — volante alineado, terminales, amortiguadores y paquetes',
  },
  { codigo: 'linterna', etiqueta: 'Linterna — operativa y baterías de respaldo' },
  {
    codigo: 'espejo_retrovisor',
    etiqueta: 'Espejo retrovisor — adecuado, ajustado para clara visión',
  },
  { codigo: 'limpiaparabrisas', etiqueta: 'Limpiador de parabrisas y lavadores' },
  { codigo: 'corneta', etiqueta: 'Corneta / pito — sonido alto y claro' },
  {
    codigo: 'faros_delanteros',
    etiqueta: 'Faros delanteros — trabajando, alineados para evitar encandilar',
  },
  { codigo: 'luces_traseras', etiqueta: 'Luces traseras — stop, direccionales, luz de reversa' },
  {
    codigo: 'luces_interiores',
    etiqueta: 'Luces interiores — techo, puertas, instrumentos, señales',
  },
  {
    codigo: 'frenos',
    etiqueta: 'Frenos — ajustados, el emergente sostiene el vehículo en desnivel',
  },
  {
    codigo: 'llantas',
    etiqueta: 'Llantas — presión de aire, buen dibujo, libre de burbujas, de emergencia/repuesto',
  },
  { codigo: 'fugas', etiqueta: 'Fugas — ausencia de fugas o liqueos' },
  { codigo: 'motor', etiqueta: 'Motor — no ruidos inusuales, buen entonamiento, no sobrecalienta' },
  { codigo: 'bateria', etiqueta: 'Batería — soportes, nivel de agua, protectores de bornes' },
  {
    codigo: 'cinturones',
    etiqueta: 'Cinturones de seguridad — operativos para todos los asientos',
    bloquea: true, // Nota 1 del formato
  },
  { codigo: 'instrumentos', etiqueta: 'Instrumentos — trabajando bien, leen normalmente' },
  {
    codigo: 'escape',
    etiqueta: 'Sistema de escape — bien soportado, silencioso, atrapa chispas (para campo)',
  },
  { codigo: 'aire_acondicionado', etiqueta: 'Aire acondicionado — trabajando apropiadamente' },
  { codigo: 'transmision', etiqueta: 'Transmisión — sin fugas, ni ruidos' },
  {
    codigo: 'fluidos',
    etiqueta: 'Fluidos — nivel de aceite, agua de batería, agua radiador, hidráulico',
  },
  { codigo: 'carroceria', etiqueta: 'Carrocería — no tiene daños, en buen estado' },
  { codigo: 'monitor_velocidad', etiqueta: 'Monitor de velocidad — instalado y funcionando' },
  {
    codigo: 'mantenimiento_preventivo',
    etiqueta: 'Mantenimiento preventivo — alineación y balanceo, cambio de aceite, frenos',
  },
];

const EQUIPO: ItemSemilla[] = [
  { codigo: 'contactos', etiqueta: 'Contactos — teléfonos / plan de emergencia actualizados' },
  {
    codigo: 'material_arrastre',
    etiqueta: 'Material de arrastre — cabo/soga (5m, 1/2" diámetro mínimo) u otro',
  },
  {
    codigo: 'herramientas',
    etiqueta:
      'Herramientas — llaves, destornilladores, pinzas, cables batería, gata, llave de ruedas',
  },
  {
    codigo: 'botiquin',
    etiqueta: 'Botiquín — guantes quirúrgicos, alcohol/agua oxigenada, vendajes, gasas',
  },
  { codigo: 'extintor', etiqueta: 'Extintor tipo ABC, polvo químico' },
  {
    codigo: 'kit_contingencia',
    etiqueta: 'Kit de contingencia ambiental — fajas/cadenas, carpa/protección',
  },
];

export const ITEMS_INSPECCION = [
  ...VEHICULO.map((i, k) => ({ ...i, seccion: 'vehiculo' as const, orden: k + 1 })),
  ...EQUIPO.map((i, k) => ({ ...i, seccion: 'equipo' as const, orden: k + 1 })),
];

export async function sembrarInspeccion(prisma: PrismaClient) {
  let tipos = 0;
  for (const t of TIPOS_PERMISO_CONDUCTOR) {
    if (await prisma.tipoPermisoConductor.findUnique({ where: { codigo: t.codigo } })) continue;
    await prisma.tipoPermisoConductor.create({ data: { id: uuidv7(), ...t } });
    tipos++;
  }
  let items = 0;
  for (const i of ITEMS_INSPECCION) {
    if (await prisma.itemInspeccionVehiculo.findUnique({ where: { codigo: i.codigo } })) continue;
    await prisma.itemInspeccionVehiculo.create({
      data: {
        id: uuidv7(),
        codigo: i.codigo,
        seccion: i.seccion,
        orden: i.orden,
        etiqueta: i.etiqueta,
        bloqueaSiNoCumple: i.bloquea ?? false,
      },
    });
    items++;
  }
  return { tipos, items };
}
