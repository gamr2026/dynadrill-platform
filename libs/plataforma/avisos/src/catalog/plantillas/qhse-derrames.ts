import { FILA, type PlantillaDef } from './tipos';

const DATOS =
  '<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px;margin:8px 0 16px">' +
  FILA('Derrame', 'codigo') +
  FILA('Descripción', 'descripcion') +
  FILA('Ubicación', 'ubicacionNombre') +
  FILA('Sitio', 'ubicacionFisica') +
  FILA('Volumen reportado', 'bandaNombre') +
  FILA('Ticket', 'ticketNumero') +
  FILA('Pedido', 'pedidoCodigo') +
  FILA('Cliente', 'cliente') +
  FILA('Activado por', 'activadoPor') +
  '</table>';
const TEXTO =
  'Derrame: {{codigo}}\nDescripción: {{descripcion}}\nUbicación: {{ubicacionNombre}}\nSitio: {{ubicacionFisica}}\nVolumen reportado: {{bandaNombre}}\nTicket: {{ticketNumero}}\nPedido: {{pedidoCodigo}}\nCliente: {{cliente}}\nActivado por: {{activadoPor}}';

/** Un trabajador activó la alerta de derrame: el equipo HSE debe dirigir la contención de los primeros 5 minutos. */
const derrameActivado = (rol: 'tecnico_hse' | 'gerente_hse'): PlantillaDef => ({
  codigo: `qhse_derrame_activado_${rol}`,
  descripcion:
    'Un trabajador activó la alerta de un derrame (HSE-AMBIENTAL-002): el equipo HSE debe dirigir la contención.',
  asunto: 'Derrame activado: {{codigo}} — {{bandaNombre}}',
  cuerpoHtml:
    '<p>Hola {{nombre}},</p>' +
    '<p>Como <strong>{{cargo}}</strong>, debe saber que se activó la alerta del derrame <strong>{{codigo}}</strong>. Dirija la contención de los primeros 5 minutos y confirme el volumen real cuando termine.</p>' +
    DATOS,
  cuerpoTexto:
    'Hola {{nombre}},\n\nComo {{cargo}}, debe saber que se activó la alerta del derrame {{codigo}}. Dirija la contención de los primeros 5 minutos y confirme el volumen real cuando termine.\n\n' +
    TEXTO,
  tituloAviso: 'Derrame activado: {{codigo}}',
  detalleAviso: '{{ubicacionNombre}} · {{bandaNombre}}',
  enlaceAviso: '/dashboard/qhse/eventos',
  tono: 'error',
  evento: 'qhse.derrame.activado',
  rol,
});

export const PLANTILLAS_QHSE_DERRAMES: PlantillaDef[] = [
  derrameActivado('tecnico_hse'),
  derrameActivado('gerente_hse'),
];
