export interface CorreoSaliente {
  /** Siempre la dirección de redirección: nadie más recibe correos mientras el proyecto esté en pruebas. */
  para: string;
  asunto: string;
  html: string;
  texto: string;
}

/** Salida de correo (SMTP hoy; en Azure, Communication Services). */
export abstract class MailPort {
  abstract enviar(correo: CorreoSaliente): Promise<void>;
}
