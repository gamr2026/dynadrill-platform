import { uuidv7 } from '@dyn/utils';
import { PrismaClient } from '../generated/client';

type Cliente = Pick<PrismaClient, 'servicioLinea' | 'servicioTipo' | 'servicioSubtipo'>;

const NOMBRE_LINEA: Record<string, string> = { fcr: 'FCR', pumping: 'Pumping' };

/** Tipos de servicio por línea y, bajo cada tipo, sus subtipos (origen: KPI Ventas Consolidado, hoja "datos1"). */
export const CATALOGO_SERVICIOS: Array<{
  linea: 'fcr' | 'pumping';
  tipos: Array<{ codigo: string; nombre: string; subtipos: string[] }>;
}> = [
  {
    linea: 'fcr',
    tipos: [
      {
        codigo: 'wellbore_cleanup_tools',
        nombre: 'Wellbore Clean Up Tools',
        subtipos: [
          'Milling',
          'Run Venturi Basket',
          'Sand Bailer',
          'Sand Bailer + Multiplier',
          'WBCU Tools',
          'WBCU-Milling',
        ],
      },
      {
        codigo: 'fishing_services',
        nombre: 'Fishing Services',
        subtipos: [
          'Casing Pulling Tool',
          'Centralizador',
          'Fishing CIBP',
          'Hydraulic Packers',
          'Milling',
          'Milling-Motor',
          'Pesca Cable Slick Line',
          'Pesca CTU',
          'Pesca Hanger',
          'Pesca Wireline Tools',
          'Protector Lizer',
          'Renta de Drillpipe 2 3/8',
        ],
      },
      {
        codigo: 'remedial_tools',
        nombre: 'Remedial Tools',
        subtipos: ['Run CIBP + HST', 'Run CR + HST', 'Services Packer', 'Squeeze Jobs'],
      },
      {
        codigo: 'completion_tools',
        nombre: 'Completion Tools',
        subtipos: [
          'Completion Specialist',
          'Flow Control Tools',
          'Hydraulic Packers',
          'Mechanical Packers',
          'Seal Bore Packer',
          'Services Packer',
        ],
      },
      {
        codigo: 'lower_completion',
        nombre: 'Lower Completion',
        subtipos: [
          'Cavidad Guiberson',
          'Completación Inteligente',
          'Max-R',
          'One Trip',
          'Seal Bore Packer',
          'Selective Completion',
          'SXAR-E',
        ],
      },
      {
        codigo: 'milling',
        nombre: 'Milling',
        subtipos: ['Mill Cement & CR', 'Milling', 'Milling CIBP', 'Milling-Motor'],
      },
      {
        codigo: 'casing_repair',
        nombre: 'Casing Repair',
        subtipos: ['Casing Repair'],
      },
      {
        codigo: 'thru_tubing',
        nombre: 'Thru Tubing',
        subtipos: ['Thru Tubing'],
      },
      {
        codigo: 'esp_equipment',
        nombre: 'ESP Equipment',
        subtipos: [
          'Camisa Refrigeración 5 1/2',
          "Camisa Refrigeración 7''",
          'Casing Pulling Tool',
          'Dual ESP',
          'ESP Equipment',
        ],
      },
      {
        codigo: 'flow_control_tools',
        nombre: 'Flow Control Tools',
        subtipos: ['Reparación FCT'],
      },
      {
        codigo: 'liner_hanger',
        nombre: 'Liner Hanger',
        subtipos: ["Top Packer 7 x 9 5/8''"],
      },
      {
        codigo: 'pesca_wireline_tools',
        nombre: 'Pesca Wireline Tools',
        subtipos: ['Pesca Wireline Tools'],
      },
      {
        codigo: 'pipe_recovery',
        nombre: 'Pipe Recovery',
        subtipos: ['External Cutter'],
      },
      {
        codigo: 'servicios_integrados',
        nombre: 'Servicios Integrados',
        subtipos: ['Squeeze Jobs'],
      },
      {
        codigo: 'slickline',
        nombre: 'Slickline',
        subtipos: ['Servicios de Slickline'],
      },
    ],
  },
  {
    linea: 'pumping',
    tipos: [
      {
        codigo: 'coiled_tubing',
        nombre: 'Coiled Tubing',
        subtipos: [],
      },
      {
        codigo: 'cementing',
        nombre: 'Cementing',
        subtipos: [],
      },
      { codigo: 'control_de_fluidos', nombre: 'Control de fluidos', subtipos: [] },
      { codigo: 'nitrogeno', nombre: 'Nitrógeno', subtipos: [] },
      { codigo: 'special_pills', nombre: 'Special pills', subtipos: [] },
      { codigo: 'pumping', nombre: 'Pumping', subtipos: [] },
    ],
  },
];

/**
 * Siembra el catálogo de líneas, tipos y subtipos de servicio. Idempotente: solo agrega lo que falta; no pisa
 * nombres, orden ni el estado activo que un administrador haya cambiado.
 *
 * @returns cuántas líneas, tipos y subtipos creó.
 */
export async function sembrarServicios(
  db: Cliente,
): Promise<{ lineas: number; tipos: number; subtipos: number }> {
  let lineas = 0;
  let tipos = 0;
  let subtipos = 0;
  for (const [n, grupo] of CATALOGO_SERVICIOS.entries()) {
    let linea = await db.servicioLinea.findUnique({ where: { codigo: grupo.linea } });
    if (!linea) {
      linea = await db.servicioLinea.create({
        data: {
          id: uuidv7(),
          codigo: grupo.linea,
          nombre: NOMBRE_LINEA[grupo.linea] ?? grupo.linea,
          orden: n,
        },
      });
      lineas++;
    }
    for (const [i, t] of grupo.tipos.entries()) {
      let tipo = await db.servicioTipo.findUnique({ where: { codigo: t.codigo } });
      if (!tipo) {
        tipo = await db.servicioTipo.create({
          data: { id: uuidv7(), lineaId: linea.id, codigo: t.codigo, nombre: t.nombre, orden: i },
        });
        tipos++;
      }
      for (const [j, nombre] of t.subtipos.entries()) {
        const hay = await db.servicioSubtipo.findUnique({
          where: { tipoId_nombre: { tipoId: tipo.id, nombre } },
          select: { id: true },
        });
        if (!hay) {
          await db.servicioSubtipo.create({
            data: { id: uuidv7(), tipoId: tipo.id, nombre, orden: j },
          });
          subtipos++;
        }
      }
    }
  }
  return { lineas, tipos, subtipos };
}
