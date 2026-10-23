/** Un correo de encuesta listo para salir. */
export interface CorreoDeEncuesta {
  /** Dirección del cliente. */
  para: string;
  asunto: string;
  html: string;
  texto: string;
  /** Ruta del formulario dentro del portal (con el token), p. ej. `/encuesta/<token>`. */
  enlace: string;
  textoBoton: string;
}

/**
 * Salida de correo de las encuestas. Lo implementa el contenedor con el módulo de avisos (la única puerta de salida de correos, que en
 * pruebas redirige todo a una sola dirección); así `encuestas` no conoce a `avisos`.
 */
export abstract class EnvioCorreoPort {
  abstract enviar(correo: CorreoDeEncuesta): Promise<void>;
}
