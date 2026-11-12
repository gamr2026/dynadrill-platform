import type { TonoAviso } from '../../generated/client';

/** Una plantilla de aviso y la regla que la liga con un evento y un rol (o, si el evento trae `asignados`, con el rol de la asignación). */
export interface PlantillaDef {
  codigo: string;
  descripcion: string;
  asunto: string;
  cuerpoHtml: string;
  cuerpoTexto: string;
  tituloAviso: string;
  detalleAviso: string;
  enlaceAviso: string;
  tono: TonoAviso;
  /** A quién se envía: evento y rol. */
  evento: string;
  rol: string;
  /**
   * Si se indica, el rol de quien recibe sale del campo `data.<rolDesdeCampo>` del evento (y `rol` es `ROL_DEL_EVENTO`); si el evento
   * trae `asignados`, el aviso es para esas cuentas.
   */
  rolDesdeCampo?: string;
}

/** Marca de `rol` en las reglas cuyo rol sale de un campo del evento. */
export const ROL_DEL_EVENTO = '(del evento)';

export const FILA = (etiqueta: string, valor: string) =>
  `<tr><td style="padding:4px 12px 4px 0;color:#5c5870">${etiqueta}</td><td style="padding:4px 0"><strong>{{${valor}}}</strong></td></tr>`;
