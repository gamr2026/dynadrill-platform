import { uuidv7 } from '@dyn/utils';
import type { PrismaClient } from '../generated/client';

type Cliente = Pick<PrismaClient, 'transportista' | 'tipoVehiculo' | 'vehiculo' | 'chofer'>;

/**
 * Transporte propio de Dynadrill tal como está en AS2 (exportado de AS2 el 2026-10-15: un transportista, un vehículo y un
 * chofer). Los transportistas de terceros (p. ej. el que lleva una guía de un cliente) se cargan desde la pantalla de
 * la guía; AS2 no expone estas listas por API.
 */
export const TRANSPORTISTAS_AS2 = [
  {
    codigo: 'GRAL',
    nombreFiscal: 'DYNADRILL',
    tipoIdentificacion: 'ruc' as const,
    identificacion: '1792142350001',
  },
];
export const TIPOS_VEHICULO_AS2 = ['CAMION'];
export const VEHICULOS_AS2 = [
  {
    placa: 'GSI6538',
    marca: 'JAC',
    tipo: 'CAMION',
    modelo: 'HFC1040K2',
    anio: 2017,
    responsable: '1792142350001',
  },
];
export const CHOFERES_AS2 = [
  { licencia: '0705441582', nombre: 'DYNADRILL', transportista: '1792142350001' },
];

/** Idempotente: solo agrega lo que falta; no pisa lo que un administrador haya editado. */
export async function sembrarTransporte(
  db: Cliente,
): Promise<{ transportistas: number; tipos: number; vehiculos: number; choferes: number }> {
  const r = { transportistas: 0, tipos: 0, vehiculos: 0, choferes: 0 };
  const porRuc = new Map<string, string>();
  for (const t of TRANSPORTISTAS_AS2) {
    const existe = await db.transportista.findUnique({
      where: { identificacion: t.identificacion },
    });
    if (existe) {
      porRuc.set(t.identificacion, existe.id);
      continue;
    }
    const id = uuidv7();
    await db.transportista.create({ data: { id, ...t } });
    porRuc.set(t.identificacion, id);
    r.transportistas++;
  }
  const tipos = new Map<string, string>();
  for (const nombre of TIPOS_VEHICULO_AS2) {
    const existe = await db.tipoVehiculo.findUnique({ where: { nombre } });
    if (existe) {
      tipos.set(nombre, existe.id);
      continue;
    }
    const id = uuidv7();
    await db.tipoVehiculo.create({ data: { id, nombre } });
    tipos.set(nombre, id);
    r.tipos++;
  }
  for (const v of VEHICULOS_AS2) {
    if (await db.vehiculo.findUnique({ where: { placa: v.placa }, select: { id: true } })) continue;
    await db.vehiculo.create({
      data: {
        id: uuidv7(),
        placa: v.placa,
        marca: v.marca,
        modelo: v.modelo,
        anio: v.anio,
        tipoVehiculoId: tipos.get(v.tipo) ?? null,
        transportistaId: porRuc.get(v.responsable) ?? null,
      },
    });
    r.vehiculos++;
  }
  for (const c of CHOFERES_AS2) {
    const transportistaId = porRuc.get(c.transportista);
    if (!transportistaId) continue;
    if (
      await db.chofer.findUnique({
        where: { transportistaId_licencia: { transportistaId, licencia: c.licencia } },
        select: { id: true },
      })
    )
      continue;
    await db.chofer.create({
      data: { id: uuidv7(), transportistaId, licencia: c.licencia, nombre: c.nombre },
    });
    r.choferes++;
  }
  return r;
}
