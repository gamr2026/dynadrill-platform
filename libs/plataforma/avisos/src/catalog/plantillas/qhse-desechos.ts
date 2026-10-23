import { FILA, type PlantillaDef } from './tipos';

const DATOS =
  '<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px;margin:8px 0 16px">' +
  FILA('Desecho', 'codigo') +
  FILA('Descripción', 'descripcion') +
  FILA('Límite de almacenamiento', 'limiteAlmacenamientoHasta') +
  '</table>';
const TEXTO =
  'Desecho: {{codigo}}\nDescripción: {{descripcion}}\nLímite de almacenamiento: {{limiteAlmacenamientoHasta}}';

/** Se acerca el límite de 12 meses de almacenamiento (AM 142): los eventos los emite la revisión de vencimientos de Desechos. */
const limiteProximo = (rol: 'tecnico_hse' | 'gerente_hse'): PlantillaDef => ({
  codigo: `qhse_desecho_limite_proximo_${rol}`,
  descripcion:
    'Un desecho se acerca al límite de 12 meses de almacenamiento (AM 142) y aún no se dispone.',
  asunto: 'Desecho por vencer: {{codigo}} — faltan {{diasParaLimite}} día(s)',
  cuerpoHtml:
    '<p>Hola {{nombre}},</p>' +
    '<p>Como <strong>{{cargo}}</strong>, tenga presente que al desecho <strong>{{codigo}}</strong> le faltan <strong>{{diasParaLimite}}</strong> día(s) para cumplir el límite de 12 meses de almacenamiento (AM 142):</p>' +
    DATOS +
    '<p>Genere el manifiesto y gestione su disposición final antes de esa fecha.</p>',
  cuerpoTexto:
    'Hola {{nombre}},\n\nComo {{cargo}}, tenga presente que al desecho {{codigo}} le faltan {{diasParaLimite}} día(s) para cumplir el límite de 12 meses de almacenamiento (AM 142):\n\n' +
    TEXTO +
    '\n\nGenere el manifiesto y gestione su disposición final antes de esa fecha.',
  tituloAviso: 'Desecho por vencer: {{codigo}}',
  detalleAviso: 'Faltan {{diasParaLimite}} día(s) · límite {{limiteAlmacenamientoHasta}}',
  enlaceAviso: '/dashboard/qhse/desechos',
  tono: 'warning',
  evento: 'qhse.desecho.limite_proximo',
  rol,
});

const limiteVencido = (rol: 'tecnico_hse' | 'gerente_hse'): PlantillaDef => ({
  codigo: `qhse_desecho_limite_vencido_${rol}`,
  descripcion: 'Un desecho pasó el límite de 12 meses de almacenamiento (AM 142) sin disponerse.',
  asunto: 'Desecho vencido: {{codigo}} — superó el límite de almacenamiento',
  cuerpoHtml:
    '<p>Hola {{nombre}},</p>' +
    '<p>Como <strong>{{cargo}}</strong>, el desecho <strong>{{codigo}}</strong> superó el límite de 12 meses de almacenamiento (AM 142) hace <strong>{{diasVencido}}</strong> día(s) y aún no se dispone:</p>' +
    DATOS +
    '<p>Gestione su disposición final cuanto antes.</p>',
  cuerpoTexto:
    'Hola {{nombre}},\n\nComo {{cargo}}, el desecho {{codigo}} superó el límite de 12 meses de almacenamiento (AM 142) hace {{diasVencido}} día(s) y aún no se dispone:\n\n' +
    TEXTO +
    '\n\nGestione su disposición final cuanto antes.',
  tituloAviso: 'Desecho vencido: {{codigo}}',
  detalleAviso: 'Pasó el límite hace {{diasVencido}} día(s) · {{limiteAlmacenamientoHasta}}',
  enlaceAviso: '/dashboard/qhse/desechos',
  tono: 'error',
  evento: 'qhse.desecho.limite_vencido',
  rol,
});

/** El certificado de disposición final no llegó dentro de los 30 días desde el manifiesto. */
const certificadoVencido = (rol: 'tecnico_hse' | 'gerente_hse'): PlantillaDef => ({
  codigo: `qhse_desecho_certificado_vencido_${rol}`,
  descripcion:
    'Pasaron 30 días desde el manifiesto de un desecho y todavía no se registra el certificado de disposición final.',
  asunto: 'Certificado de disposición pendiente: {{codigo}} (manifiesto {{manifiestoNumero}})',
  cuerpoHtml:
    '<p>Hola {{nombre}},</p>' +
    '<p>Como <strong>{{cargo}}</strong>, el certificado de disposición final del desecho <strong>{{codigo}}</strong> (manifiesto <strong>{{manifiestoNumero}}</strong>) debía registrarse hasta el <strong>{{certificadoVenceEl}}</strong> y aún no está:</p>' +
    DATOS +
    '<p>Pídale el certificado al gestor ambiental y regístrelo para cerrar el desecho.</p>',
  cuerpoTexto:
    'Hola {{nombre}},\n\nComo {{cargo}}, el certificado de disposición final del desecho {{codigo}} (manifiesto {{manifiestoNumero}}) debía registrarse hasta el {{certificadoVenceEl}} y aún no está:\n\n' +
    TEXTO +
    '\n\nPídale el certificado al gestor ambiental y regístrelo para cerrar el desecho.',
  tituloAviso: 'Certificado pendiente: {{codigo}}',
  detalleAviso: 'Manifiesto {{manifiestoNumero}} · debía estar el {{certificadoVenceEl}}',
  enlaceAviso: '/dashboard/qhse/desechos',
  tono: 'warning',
  evento: 'qhse.desecho.certificado_vencido',
  rol,
});

export const PLANTILLAS_QHSE_DESECHOS: PlantillaDef[] = [
  limiteProximo('tecnico_hse'),
  limiteProximo('gerente_hse'),
  limiteVencido('tecnico_hse'),
  limiteVencido('gerente_hse'),
  certificadoVencido('tecnico_hse'),
  certificadoVencido('gerente_hse'),
];
