import { Inject, Injectable } from '@nestjs/common';
import { envolverCorreo } from '../plantillas';
import { CorreoSaliente, MailPort } from './mail.port';

export const AVISOS_OPCIONES = Symbol('AVISOS_OPCIONES');

export interface AvisosOpciones {
  /** Dirección a la que llegan TODOS los correos mientras el proyecto esté en pruebas. Obligatoria. */
  redirigirA: string;
  /** Dirección del portal para armar los enlaces de los correos (p. ej. http://localhost:4200). */
  appUrl: string;
}

export interface CorreoPorEnviar {
  /** Quién LO HABRÍA recibido (se muestra en el correo; no se le envía nada). */
  destinatarioNombre?: string | null;
  destinatarioCorreo?: string | null;
  asunto: string;
  contenidoHtml: string;
  contenidoTexto: string;
  enlace?: string | null;
  /** Texto del botón del enlace; por defecto «Abrir en el portal» (el de una persona de la casa). */
  textoBoton?: string | null;
}

/**
 * Única puerta de salida de correos. MIENTRAS EL PROYECTO ESTÉ EN PRUEBAS cada correo se entrega a una sola dirección
 * (`redirigirA`), sin importar a quién iba dirigido: la dirección real no se pasa nunca al transporte, no hay copias ni
 * copias ocultas. El correo dice a quién habría llegado y el asunto lleva "[PRUEBA]".
 */
@Injectable()
export class CorreoSeguroService {
  constructor(
    private readonly mail: MailPort,
    @Inject(AVISOS_OPCIONES) private readonly opciones: AvisosOpciones,
  ) {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(opciones.redirigirA)) {
      throw new Error(
        'MAIL_REDIRECT_TO debe ser un correo válido: sin él no se envía ningún correo',
      );
    }
  }

  /** La única dirección a la que salen los correos. */
  get destinoReal(): string {
    return this.opciones.redirigirA;
  }

  async enviar(c: CorreoPorEnviar): Promise<CorreoSaliente> {
    const quien = c.destinatarioCorreo
      ? `Habría llegado a ${c.destinatarioNombre ? `${c.destinatarioNombre} <${c.destinatarioCorreo}>` : c.destinatarioCorreo}.`
      : 'No había ninguna persona activa con ese rol: se envía solo para que usted lo vea.';
    const enlaceUrl = c.enlace ? `${this.opciones.appUrl.replace(/\/+$/, '')}${c.enlace}` : null;
    const saliente: CorreoSaliente = {
      para: this.opciones.redirigirA,
      asunto: `[PRUEBA] ${c.asunto}`,
      html: envolverCorreo({
        contenidoHtml: c.contenidoHtml,
        enlaceUrl,
        ...(c.textoBoton ? { textoBoton: c.textoBoton } : {}),
        avisoPruebas: quien,
      }),
      texto: `CORREO DE PRUEBA. ${quien}\n\n${c.contenidoTexto}${enlaceUrl ? `\n\n${c.textoBoton ?? 'Abrir en el portal'}: ${enlaceUrl}` : ''}`,
    };
    await this.mail.enviar(saliente);
    return saliente;
  }
}
