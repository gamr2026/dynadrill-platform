import { uuidv7 } from '@dyn/utils';
import type { PrismaClient } from '../generated/client';

type Cliente = Pick<PrismaClient, 'moduloArchivo'>;

const DOCUMENTOS = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
];

/** Módulos que guardan archivos. Cada módulo nuevo agrega su fila aquí (o desde la administración). */
export const MODULOS_ARCHIVO = [
  {
    codigo: 'pedido_documento',
    nombre: 'Documentos de un pedido (referencial)',
    permisoSubir: 'comercial.pedidos.editar',
    permisoVer: 'comercial.pedidos.ver',
    tiposMime: DOCUMENTOS,
    tamanoMaxMb: 25,
  },
  {
    codigo: 'prefactura_documento',
    nombre: 'Prefactura firmada (y su respaldo)',
    permisoSubir: 'comercial.prefacturas.firmar',
    permisoVer: 'comercial.prefacturas.ver',
    tiposMime: ['application/pdf', 'image/png', 'image/jpeg'],
    tamanoMaxMb: 25,
  },
  {
    codigo: 'guia_documento',
    nombre: 'Guía de remisión firmada',
    permisoSubir: 'comercial.guias.firmar',
    permisoVer: 'comercial.guias.ver',
    tiposMime: ['application/pdf', 'image/png', 'image/jpeg'],
    tamanoMaxMb: 25,
  },
  {
    codigo: 'orden_trabajo_documento',
    nombre: 'Orden de trabajo firmada',
    permisoSubir: 'comercial.ordenes_trabajo.firmar',
    permisoVer: 'comercial.ordenes_trabajo.ver',
    tiposMime: ['application/pdf', 'image/png', 'image/jpeg'],
    tamanoMaxMb: 25,
  },
  {
    codigo: 'prefactura_company_man',
    nombre: 'Prefactura firmada por el Company Man (subida desde el ticket)',
    permisoSubir: 'comercial.prefacturas.firma_company_man',
    permisoVer: 'comercial.prefacturas.vista_ticket',
    tiposMime: ['application/pdf', 'image/png', 'image/jpeg'],
    tamanoMaxMb: 25,
  },
  {
    codigo: 'despacho_documento',
    nombre: 'Documento de respaldo y hoja MSDS del despacho a Bodega',
    permisoSubir: 'inventario.despachos.gestionar',
    permisoVer: 'comercial.pedidos.ver',
    tiposMime: ['application/pdf', 'image/png', 'image/jpeg'],
    tamanoMaxMb: 25,
  },
  {
    codigo: 'ticket_mezcla_documento',
    nombre: 'Documento de mezcla de químicos de un ticket de Pumping',
    permisoSubir: 'pumping.tickets.operar',
    permisoVer: 'pumping.tickets.operar',
    tiposMime: DOCUMENTOS,
    tamanoMaxMb: 25,
  },
  {
    codigo: 'ticket_monitoreo_documento',
    nombre: 'Monitoreo de un día de operación de un ticket de Pumping',
    permisoSubir: 'pumping.tickets.operar',
    permisoVer: 'pumping.tickets.operar',
    tiposMime: DOCUMENTOS,
    tamanoMaxMb: 25,
  },
];

/** Idempotente: solo agrega los que faltan; no pisa lo que un administrador haya ajustado. */
export async function sembrarModulosArchivo(db: Cliente): Promise<number> {
  let nuevos = 0;
  for (const m of MODULOS_ARCHIVO) {
    const existe = await db.moduloArchivo.findUnique({
      where: { codigo: m.codigo },
      select: { id: true },
    });
    if (!existe) {
      await db.moduloArchivo.create({ data: { id: uuidv7(), ...m } });
      nuevos++;
    }
  }
  return nuevos;
}
