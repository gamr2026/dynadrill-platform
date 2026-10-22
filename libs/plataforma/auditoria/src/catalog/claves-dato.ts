/**
 * Claves de negocio que la proyección extrae de `data` del evento (solo valores de primer nivel, texto o número). Es una lista
 * blanca: cualquier otro campo del evento NO se guarda. `campo` es el nombre en el evento; `codigo` el de `auditoria.clave_dato`.
 * Una clave nueva se agrega aquí y se siembra (`npm run db:seed:auditoria`).
 */
export interface ClaveDatoDef {
  codigo: string;
  campo: string;
  descripcion: string;
}

export const CLAVES_DATO: readonly ClaveDatoDef[] = [
  { codigo: 'pedido_id', campo: 'pedidoId', descripcion: 'Pedido al que pertenece el hecho' },
  { codigo: 'pedido_codigo', campo: 'pedidoCodigo', descripcion: 'Código del pedido' },
  { codigo: 'ticket_id', campo: 'ticketId', descripcion: 'Ticket de Pumping o FCR' },
  { codigo: 'ticket_numero', campo: 'ticketNumero', descripcion: 'Número del ticket' },
  { codigo: 'unidad_id', campo: 'unidadId', descripcion: 'Unidad de Flota' },
  { codigo: 'reporte_id', campo: 'reporteId', descripcion: 'Reporte de unidad de Mantenimiento' },
  { codigo: 'articulo_id', campo: 'articuloId', descripcion: 'Artículo de Inventario' },
  { codigo: 'inspeccion_id', campo: 'inspeccionId', descripcion: 'Inspección' },
  { codigo: 'ptw_id', campo: 'ptwId', descripcion: 'Permiso de trabajo (PTW)' },
  { codigo: 'swa_id', campo: 'swaId', descripcion: 'Stop Work Authority (SWA)' },
  {
    codigo: 'usuario_id',
    campo: 'usuarioId',
    descripcion: 'Cuenta de usuario a la que se refiere el hecho',
  },
];
