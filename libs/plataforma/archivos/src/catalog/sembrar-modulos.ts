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
    tamanoMaxMb: 10,
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
    codigo: 'documento_respaldo_firmado',
    nombre: 'Monitoreo o mezcla química del ticket, firmados',
    permisoSubir: 'comercial.prefacturas.firmar',
    permisoVer: 'comercial.documentos_operativos.ver',
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
    permisoVer: 'pumping.documentos.ver',
    tiposMime: DOCUMENTOS,
    tamanoMaxMb: 25,
  },
  {
    codigo: 'ticket_monitoreo_documento',
    nombre: 'Monitoreo de un día de operación de un ticket de Pumping',
    permisoSubir: 'pumping.tickets.operar',
    permisoVer: 'pumping.documentos.ver',
    tiposMime: DOCUMENTOS,
    tamanoMaxMb: 25,
  },
  {
    codigo: 'ticket_fcr_documento',
    nombre: 'Documento adjunto de un ticket de FCR (inspección, dimensionamiento, dureza y QAQC)',
    permisoSubir: 'fcr.tickets.operar',
    permisoVer: 'fcr.tickets.operar',
    tiposMime: DOCUMENTOS,
    tamanoMaxMb: 25,
  },
  {
    codigo: 'qhse_acta_entrega',
    nombre: 'Acta de Entrega de Locación (DYN-PMP-RE-027) de un pedido',
    permisoSubir: 'qhse.acta_entrega.cargar',
    permisoVer: 'qhse.acta_entrega.ver',
    tiposMime: ['application/pdf', 'image/png', 'image/jpeg'],
    tamanoMaxMb: 25,
  },
  {
    codigo: 'qhse_iperc_documento',
    nombre: 'Procedimiento y ATS base de una matriz IPERC',
    permisoSubir: 'qhse.iperc.gestionar',
    permisoVer: 'qhse.iperc.ver',
    tiposMime: DOCUMENTOS,
    tamanoMaxMb: 25,
  },
  {
    codigo: 'qhse_stop_foto',
    nombre: 'Foto de una tarjeta STOP',
    permisoSubir: 'qhse.eventos.reportar',
    permisoVer: 'qhse.stop.ver',
    tiposMime: ['image/png', 'image/jpeg'],
    tamanoMaxMb: 10,
  },
  {
    codigo: 'qhse_documento_pedido',
    nombre: 'Documentos de seguridad de un pedido (formato de recepción, ART, PT, SFI)',
    permisoSubir: 'qhse.documentos.gestionar',
    permisoVer: 'qhse.documentos.ver',
    tiposMime: DOCUMENTOS,
    tamanoMaxMb: 25,
  },
  {
    codigo: 'qhse_desecho_documento',
    nombre: 'Manifiesto firmado y certificado de disposición final de un desecho',
    permisoSubir: 'qhse.desechos.gestionar',
    permisoVer: 'qhse.desechos.ver',
    tiposMime: DOCUMENTOS,
    tamanoMaxMb: 25,
  },
  {
    codigo: 'qhse_requisito_legal',
    nombre:
      'Matriz de requisitos legales de QHSE (Gestión Ambiental o Seguridad y Salud en el Trabajo)',
    permisoSubir: 'qhse.legal.gestionar',
    permisoVer: 'qhse.legal.ver',
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
