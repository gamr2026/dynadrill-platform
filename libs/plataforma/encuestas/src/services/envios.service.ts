import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EnvioCorreoPort } from '../puertos/envio-correo.port';
import { armarCorreoDeEncuesta, type ContextoDelCorreo } from './correo-encuesta';
import { InvitacionesService } from './invitaciones.service';

export interface InvitacionPorEnviar {
  id: string;
  token: string;
  venceAt: Date;
  correoDestino: string;
  titulo: string;
}

/**
 * Envía el correo de una invitación y anota el resultado en ella (enviada, o el error). Que el correo falle no es un error de quien lo pide:
 * el enlace ya existe y la administración puede reenviarlo; por eso no se lanza.
 */
@Injectable()
export class EnviosService {
  private readonly logger = new Logger(EnviosService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly invitaciones: InvitacionesService,
    private readonly correo: EnvioCorreoPort,
  ) {}

  async enviar(inv: InvitacionPorEnviar, contexto?: ContextoDelCorreo): Promise<boolean> {
    try {
      await this.correo.enviar(
        armarCorreoDeEncuesta({
          para: inv.correoDestino,
          token: inv.token,
          venceAt: inv.venceAt,
          titulo: inv.titulo,
          contexto,
        }),
      );
    } catch (e) {
      const motivo = e instanceof Error ? e.message : String(e);
      this.logger.warn(`El correo de la encuesta ${inv.id} no salió: ${motivo}`);
      await this.invitaciones.marcarError(inv.id, motivo);
      return false;
    }
    await this.invitaciones.marcarEnviada(inv.id);
    return true;
  }

  /**
   * Reenvía una encuesta que no se respondió (por ejemplo, el enlace venció o el correo no salió): crea una invitación nueva con la
   * versión vigente y le manda el enlace nuevo al mismo correo. Del enlace anterior no se recupera nada: el token en claro no se guarda.
   */
  async reenviar(invitacionId: string, actorId: string) {
    const vieja = await this.prisma.invitacion.findUnique({
      where: { id: invitacionId },
      include: {
        respuesta: { select: { id: true } },
        version: { select: { encuesta: { select: { codigo: true } } } },
      },
    });
    if (!vieja) throw new NotFoundException('La invitación no existe');
    if (vieja.respuesta) {
      throw new ConflictException('Esta encuesta ya fue respondida: no hace falta reenviarla');
    }
    const nueva = await this.invitaciones.crear({
      encuestaCodigo: vieja.version.encuesta.codigo,
      referenciaId: vieja.referenciaId,
      correoDestino: vieja.correoDestino,
      actorId,
    });
    const enviada = await this.enviar(nueva);
    return { id: nueva.id, venceAt: nueva.venceAt, correoDestino: nueva.correoDestino, enviada };
  }
}
