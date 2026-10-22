import { FILA, type PlantillaDef } from './tipos';

const DATOS =
  '<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px;margin:8px 0 16px">' +
  FILA('Emergencia', 'codigo') +
  FILA('Tipo', 'tipoNombre') +
  FILA('Descripción', 'descripcion') +
  FILA('Ubicación', 'ubicacion') +
  FILA('Ticket', 'ticketNumero') +
  FILA('Pedido', 'pedidoCodigo') +
  FILA('Cliente', 'cliente') +
  FILA('Activada por', 'activadoPor') +
  '</table>';
const TEXTO =
  'Emergencia: {{codigo}}\nTipo: {{tipoNombre}}\nDescripción: {{descripcion}}\nUbicación: {{ubicacion}}\nTicket: {{ticketNumero}}\nPedido: {{pedidoCodigo}}\nCliente: {{cliente}}\nActivada por: {{activadoPor}}';

/** Se activó una emergencia (HSE-TRIAGE-001): el equipo HSE debe declarar el nivel, contar al personal y avisar en cascada. */
const emergenciaActivada = (rol: 'tecnico_hse' | 'gerente_hse'): PlantillaDef => ({
  codigo: `qhse_emergencia_activada_${rol}`,
  descripcion:
    'Un trabajador activó una emergencia (HSE-TRIAGE-001): el equipo HSE debe declarar el nivel, contar al personal y notificar en cascada.',
  asunto: 'EMERGENCIA activada: {{codigo}} — {{tipoNombre}}',
  cuerpoHtml:
    '<p>Hola {{nombre}},</p>' +
    '<p>Como <strong>{{cargo}}</strong>, debe saber que se activó la emergencia <strong>{{codigo}}</strong>. Declare el nivel, haga el conteo de personal y complete la notificación en cascada dentro de los plazos del protocolo.</p>' +
    DATOS,
  cuerpoTexto:
    'Hola {{nombre}},\n\nComo {{cargo}}, debe saber que se activó la emergencia {{codigo}}. Declare el nivel, haga el conteo de personal y complete la notificación en cascada dentro de los plazos del protocolo.\n\n' +
    TEXTO,
  tituloAviso: 'EMERGENCIA activada: {{codigo}}',
  detalleAviso: '{{tipoNombre}} · {{ubicacion}}',
  enlaceAviso: '/dashboard/qhse/eventos',
  tono: 'error',
  evento: 'qhse.emergencia.activada',
  rol,
});

export const PLANTILLAS_QHSE_EMERGENCIAS: PlantillaDef[] = [
  emergenciaActivada('tecnico_hse'),
  emergenciaActivada('gerente_hse'),
];
