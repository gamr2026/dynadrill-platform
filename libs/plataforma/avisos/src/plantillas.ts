const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
export const escaparHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);

export type Variables = Record<string, string>;

/**
 * Reemplaza `{{clave}}` por su valor. Una clave desconocida queda vacía (nunca se imprime la llave ni se rompe el
 * mensaje). Con `html = true` los valores se escapan: un dato con `<script>` jamás llega como código.
 */
export function renderizar(texto: string, variables: Variables, html = false): string {
  return texto.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, clave: string) => {
    const v = variables[clave] ?? '';
    return html ? escaparHtml(v) : v;
  });
}

/** Aplana los datos de un evento a texto: listas separadas por coma, objetos anidados con punto, vacíos omitidos. */
export function variablesDeEvento(datos: Record<string, unknown>, prefijo = ''): Variables {
  const salida: Variables = {};
  for (const [k, v] of Object.entries(datos)) {
    if (v === null || v === undefined || v === '') continue;
    const clave = `${prefijo}${k}`;
    if (Array.isArray(v)) salida[clave] = v.map((x) => String(x)).join(', ');
    else if (typeof v === 'object')
      Object.assign(salida, variablesDeEvento(v as Record<string, unknown>, `${clave}_`));
    else salida[clave] = String(v);
  }
  return salida;
}

/**
 * Marco común de los correos: cabecera de Dynadrill, el contenido de la plantilla, el botón al enlace y el pie.
 * En modo de pruebas se agrega un aviso arriba con quién habría recibido el correo.
 */
export function envolverCorreo(p: {
  contenidoHtml: string;
  enlaceUrl?: string | null;
  textoBoton?: string;
  avisoPruebas?: string | null;
}): string {
  const boton = p.enlaceUrl
    ? `<p style="margin:24px 0 8px"><a href="${escaparHtml(p.enlaceUrl)}" style="background:#662e9b;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600;display:inline-block">${escaparHtml(p.textoBoton ?? 'Abrir en el portal')}</a></p>`
    : '';
  const pruebas = p.avisoPruebas
    ? `<div style="background:#fff7e6;border:1px solid #ffd591;color:#613400;padding:10px 12px;border-radius:8px;margin-bottom:16px;font-size:13px"><strong>Correo de prueba.</strong> ${escaparHtml(p.avisoPruebas)}</div>`
    : '';
  return `<!doctype html><html lang="es"><body style="margin:0;background:#f4f3f8;font-family:Arial,Helvetica,sans-serif;color:#2c2b35">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden">
<tr><td style="background:#662e9b;color:#ffffff;padding:16px 24px;font-size:18px;font-weight:700">Dynadrill</td></tr>
<tr><td style="padding:24px;font-size:14px;line-height:1.5">${pruebas}${p.contenidoHtml}${boton}</td></tr>
<tr><td style="padding:12px 24px;background:#faf9fc;color:#8a8799;font-size:12px">Mensaje automático del portal de Dynadrill. No responda a este correo.</td></tr>
</table></td></tr></table></body></html>`;
}
