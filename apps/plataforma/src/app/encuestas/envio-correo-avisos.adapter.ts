import { Injectable } from '@nestjs/common';
import { AvisosService } from '@dyn/avisos';
import { type CorreoDeEncuesta, EnvioCorreoPort } from '@dyn/encuestas';

/**
 * Cómo salen los correos de las encuestas: por la misma puerta segura de los avisos (en pruebas llegan solo a la dirección de
 * redirección y dicen a quién habrían llegado). Si el transporte falla, el error sube para que la invitación lo anote.
 */
@Injectable()
export class EnvioCorreoAvisosAdapter extends EnvioCorreoPort {
  constructor(private readonly avisos: AvisosService) {
    super();
  }

  async enviar(c: CorreoDeEncuesta): Promise<void> {
    await this.avisos.enviarCorreoExterno({
      destinatarioNombre: null,
      destinatarioCorreo: c.para,
      asunto: c.asunto,
      contenidoHtml: c.html,
      contenidoTexto: c.texto,
      enlace: c.enlace,
      textoBoton: c.textoBoton,
    });
  }
}
