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

/**
 * Clave de negocio con la que otros hechos nombran a una entidad: la línea de tiempo del pedido incluye también los hechos de
 * sus tickets porque estos llevan `pedido_id`. Los ids son uuid, así que una clave compartida (`ticket_id` de Pumping y de FCR)
 * no mezcla entidades.
 */
export const CLAVE_DE_SUJETO: Readonly<Record<string, string>> = {
  pedido: 'pedido_id',
  pumping_ticket: 'ticket_id',
  fcr_ticket: 'ticket_id',
  flota_unidad: 'unidad_id',
  mantenimiento_reporte: 'reporte_id',
  inventario_articulo: 'articulo_id',
  inspeccion: 'inspeccion_id',
  ptw: 'ptw_id',
  swa: 'swa_id',
  identidad_usuario: 'usuario_id',
};
