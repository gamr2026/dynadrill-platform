import { uuidv7 } from '@dyn/utils';
import { type MacroEstado, PrismaClient } from '../generated/client';

type Cliente = Pick<PrismaClient, 'procesoEstado' | 'procesoTransicion'>;

interface EstadoDef {
  codigo: string;
  nombre: string;
  macro: MacroEstado;
  rol: string | null;
  terminal?: boolean;
}

/**
 * Estados del pedido. Los 17 del SQL v1 (`dynadrill_propuesta_v1.sql`); macro-estado y responsable parten de
 * `pedido-estados.maps.ts` de la demo, con un ajuste: `en_correccion` lo atiende Ventas (Facturación devuelve el pedido
 * a Ventas y esta lo corrige), no Facturación.
 */
const ESTADOS: EstadoDef[] = [
  { codigo: 'borrador', nombre: 'Por completar', macro: 'borrador', rol: 'ingenieria_ventas' },
  { codigo: 'abierto', nombre: 'Abierto', macro: 'pendiente', rol: 'ingenieria_ventas' },
  { codigo: 'en_operacion', nombre: 'En operación', macro: 'en_proceso', rol: null },
  {
    codigo: 'en_elaboracion_operativa',
    nombre: 'En elaboración operativa',
    macro: 'en_proceso',
    rol: null,
  },
  {
    codigo: 'documentos_completos',
    nombre: 'Documentos completos',
    macro: 'en_proceso',
    rol: 'facturacion',
  },
  {
    codigo: 'en_revision_prefacturacion',
    nombre: 'En revisión de prefacturación',
    macro: 'en_proceso',
    rol: 'facturacion',
  },
  {
    codigo: 'en_correccion',
    nombre: 'En corrección',
    macro: 'en_proceso',
    rol: 'ingenieria_ventas',
  },
  {
    codigo: 'prefactura_generada',
    nombre: 'Prefactura generada',
    macro: 'en_proceso',
    rol: 'facturacion',
  },
  {
    codigo: 'por_despachar_bodega',
    nombre: 'Por despachar (Bodega)',
    macro: 'esperando_aprobacion',
    rol: 'bodeguero',
  },
  {
    codigo: 'enviado_para_firmas',
    nombre: 'Enviado para firmas',
    macro: 'esperando_aprobacion',
    rol: 'cliente',
  },
  {
    codigo: 'rechazado_por_cliente',
    nombre: 'Rechazado por el cliente',
    macro: 'rechazado',
    rol: 'facturacion',
  },
  { codigo: 'ticket_firmado', nombre: 'Ticket firmado', macro: 'en_proceso', rol: 'facturacion' },
  { codigo: 'aot_generada', nombre: 'AOT generada', macro: 'en_proceso', rol: 'facturacion' },
  { codigo: 'facturado', nombre: 'Facturado', macro: 'aprobado', rol: null, terminal: true },
  { codigo: 'anulado', nombre: 'Anulado', macro: 'rechazado', rol: null, terminal: true },
];

const P = {
  crear: 'comercial.pedidos.crear',
  editar: 'comercial.pedidos.editar',
  anular: 'comercial.pedidos.anular',
  rechazar: 'comercial.pedidos.rechazar',
};

interface PasoDef {
  de: string | string[];
  a: string;
  permiso?: string;
  motivo?: boolean;
  automatica?: boolean;
  evento?: string;
  regla?: string;
}

/** Estados desde los que un pedido todavía puede anularse (todos menos los finales y el borrador). */
const ANULABLES = [
  'abierto',
  'en_operacion',
  'en_elaboracion_operativa',
  'documentos_completos',
  'en_revision_prefacturacion',
  'en_correccion',
  'prefactura_generada',
  'por_despachar_bodega',
  'enviado_para_firmas',
  'rechazado_por_cliente',
  'ticket_firmado',
  'aot_generada',
];

/**
 * Pasos válidos. Con `permiso`, alguien los puede dar a mano. Con `automatica`, además los produce un hecho (evento o
 * sincronización). Sin permiso, solo el sistema o un forzado (Superadmin con motivo). Mientras Operaciones no esté en el
 * portal, los pasos `en_operacion` y `documentos_completos` también se dan a mano con `comercial.pedidos.editar`.
 */
const PASOS: PasoDef[] = [
  { de: 'borrador', a: 'abierto', permiso: P.crear, regla: 'pedido_completo' },
  { de: 'borrador', a: 'anulado', permiso: P.editar, motivo: true },
  { de: 'en_correccion', a: 'abierto', permiso: P.editar, regla: 'pedido_completo' },
  {
    de: [
      'abierto',
      'en_operacion',
      'en_elaboracion_operativa',
      'documentos_completos',
      'en_revision_prefacturacion',
    ],
    a: 'en_correccion',
    permiso: P.rechazar,
    motivo: true,
  },
  { de: ANULABLES, a: 'anulado', permiso: P.anular, motivo: true },
  // los produce Operaciones (ticket iniciado / reporte recibido / ticket cerrado por el supervisor)
  {
    de: 'abierto',
    a: 'en_operacion',
    permiso: P.editar,
    automatica: true,
    evento: 'operaciones.ticket.iniciado',
  },
  {
    de: 'en_operacion',
    a: 'en_elaboracion_operativa',
    permiso: P.editar,
    automatica: true,
    evento: 'operaciones.reporte.recibido',
  },
  {
    de: ['abierto', 'en_operacion', 'en_elaboracion_operativa'],
    a: 'documentos_completos',
    permiso: P.editar,
    automatica: true,
    evento: 'operaciones.ticket.cerrado',
  },
  // los produce Facturación y los módulos que vienen (prefactura, guía, AOT, despacho de Bodega)
  {
    de: 'documentos_completos',
    a: 'en_revision_prefacturacion',
    automatica: true,
    evento: 'comercial.prefactura.en_revision',
  },
  {
    de: ['documentos_completos', 'en_revision_prefacturacion'],
    a: 'prefactura_generada',
    automatica: true,
    evento: 'comercial.prefactura.generada',
  },
  {
    de: 'prefactura_generada',
    a: 'por_despachar_bodega',
    automatica: true,
    evento: 'comercial.despacho.solicitado',
  },
  {
    de: 'por_despachar_bodega',
    a: 'prefactura_generada',
    automatica: true,
    evento: 'comercial.despacho.resuelto',
  },
  {
    de: 'prefactura_generada',
    a: 'enviado_para_firmas',
    automatica: true,
    evento: 'comercial.prefactura.enviada',
  },
  {
    de: 'enviado_para_firmas',
    a: 'ticket_firmado',
    automatica: true,
    evento: 'comercial.prefactura.firmada',
  },
  {
    de: 'enviado_para_firmas',
    a: 'rechazado_por_cliente',
    automatica: true,
    evento: 'comercial.prefactura.rechazada',
  },
  {
    de: 'rechazado_por_cliente',
    a: 'en_correccion',
    automatica: true,
    evento: 'comercial.prefactura.rechazada',
  },
  {
    de: 'ticket_firmado',
    a: 'aot_generada',
    automatica: true,
    evento: 'comercial.orden_trabajo.generada',
  },
];

/** Estados y transiciones iniciales del proceso `pedido`. Idempotente: lo que ya existe no se toca. */
export async function sembrarWorkflowPedido(
  db: Cliente,
): Promise<{ estados: number; pasos: number }> {
  let estados = 0;
  let pasos = 0;
  for (const [i, e] of ESTADOS.entries()) {
    const existe = await db.procesoEstado.findUnique({
      where: { proceso_codigo: { proceso: 'pedido', codigo: e.codigo } },
      select: { id: true },
    });
    if (existe) continue;
    await db.procesoEstado.create({
      data: {
        id: uuidv7(),
        proceso: 'pedido',
        codigo: e.codigo,
        nombre: e.nombre,
        macroEstado: e.macro,
        orden: (i + 1) * 10,
        rolResponsable: e.rol,
        terminal: e.terminal ?? false,
      },
    });
    estados++;
  }
  for (const paso of PASOS) {
    for (const de of Array.isArray(paso.de) ? paso.de : [paso.de]) {
      const existe = await db.procesoTransicion.findUnique({
        where: {
          proceso_estadoOrigen_estadoDestino: {
            proceso: 'pedido',
            estadoOrigen: de,
            estadoDestino: paso.a,
          },
        },
        select: { id: true },
      });
      if (existe) continue;
      await db.procesoTransicion.create({
        data: {
          id: uuidv7(),
          proceso: 'pedido',
          estadoOrigen: de,
          estadoDestino: paso.a,
          permiso: paso.permiso ?? null,
          requiereMotivo: paso.motivo ?? false,
          automatica: paso.automatica ?? false,
          eventoDisparador: paso.evento ?? null,
          regla: paso.regla ?? null,
        },
      });
      pasos++;
    }
  }
  return { estados, pasos };
}
