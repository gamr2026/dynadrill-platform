import type { CorreoDeEncuesta } from '../puertos/envio-correo.port';

/** Lo que el correo dice del servicio: todo opcional, porque un reenvío solo conoce el módulo. */
export interface ContextoDelCorreo {
  /** Número del ticket del servicio (FCR). */
  ticketNumero?: number | null;
  cliente?: string | null;
  pozo?: string | null;
}

const escapar = (t: string): string =>
  t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const cuando = (d: Date): string =>
  new Intl.DateTimeFormat('es-EC', {
    timeZone: 'America/Guayaquil',
    dateStyle: 'long',
    timeStyle: 'short',
  }).format(d);

/** Texto del servicio para la frase del correo: «el servicio N.º 4551 (pozo X)» o, sin datos, «su servicio». */
export function descripcionDelServicio(c: ContextoDelCorreo): string {
  const partes = [
    c.ticketNumero ? `N.º ${c.ticketNumero}` : null,
    c.pozo ? `pozo ${c.pozo}` : null,
  ].filter((x): x is string => !!x);
  return partes.length ? `el servicio ${partes.join(' · ')}` : 'su servicio';
}

/**
 * Correo con el enlace de la encuesta. Habla de «usted» y dice cuándo vence el enlace y que se usa una sola vez. Los datos del servicio
 * se escapan: un nombre con etiquetas no llega como código.
 */
export function armarCorreoDeEncuesta(entrada: {
  para: string;
  token: string;
  venceAt: Date;
  titulo: string;
  contexto?: ContextoDelCorreo;
}): CorreoDeEncuesta {
  const servicio = descripcionDelServicio(entrada.contexto ?? {});
  const vence = cuando(entrada.venceAt);
  const cliente = entrada.contexto?.cliente?.trim();
  const saludo = cliente ? `Estimados de ${cliente}:` : 'Estimado cliente:';
  const parrafos = [
    `Gracias por confiar en Dynadrill para ${servicio}.`,
    'Le pedimos unos minutos para responder una breve encuesta: su opinión nos ayuda a mejorar.',
    `El enlace es personal, se puede usar una sola vez y vence el ${vence}.`,
  ];
  return {
    para: entrada.para,
    asunto: 'Su opinión sobre el servicio de Dynadrill',
    html: `<p>${escapar(saludo)}</p>${parrafos.map((p) => `<p>${escapar(p)}</p>`).join('')}`,
    texto: [saludo, ...parrafos].join('\n\n'),
    enlace: `/encuesta/${entrada.token}`,
    textoBoton: 'Responder la encuesta',
  };
}
