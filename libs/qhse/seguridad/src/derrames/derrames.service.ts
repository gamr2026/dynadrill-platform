import { BadRequestException, Injectable } from '@nestjs/common';
import type { AuthUser } from '@dyn/common';
import { uuidv7 } from '@dyn/utils';
import { texto } from '../epi/epi-tipos';
import { EstadoDerrame } from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';
import { codigoDerrame } from './derrames-consulta.service';
import { DerramesEventosService } from './derrames-eventos.service';

export interface ActivarDerrameEntrada {
  ubicacionId: string;
  /** Banda de volumen REPORTADA; el volumen real lo confirma QHSE después de contener. */
  bandaId: string;
  descripcion: string;
  ubicacionFisica?: string | null;
  /** Servicio durante el que ocurrió (debe ser un ticket que QHSE conoce). */
  ticketId?: string | null;
}

/**
 * Derrames (HSE-AMBIENTAL-002). «Personal que detecta el derrame activa el botón de alerta»: cualquier trabajador activa; el equipo HSE
 * contiene, notifica al MAE y cierra. Las reglas del ciclo las garantiza además la base (trigger `derrame_validar`).
 */
@Injectable()
export class DerramesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventos: DerramesEventosService,
  ) {}

  /** Activa la alerta. Devuelve lo mínimo: quien la activa puede no tener permiso de ver. */
  async activar(entrada: ActivarDerrameEntrada, actor: AuthUser) {
    const descripcion = texto(entrada.descripcion);
    if (!descripcion) throw new BadRequestException('Describa qué se derramó y dónde');
    const id = uuidv7();
    let numero = 0;
    let requiereMae = false;
    await this.prisma.$transaction(async (tx) => {
      const ubicacion = await tx.derrameUbicacion.findUnique({
        where: { id: entrada.ubicacionId },
      });
      if (!ubicacion?.activo)
        throw new BadRequestException('La ubicación del derrame no existe o está inactiva');
      const banda = await tx.derrameBandaVolumen.findUnique({ where: { id: entrada.bandaId } });
      if (!banda?.activo)
        throw new BadRequestException('La banda de volumen no existe o está inactiva');
      if (
        entrada.ticketId &&
        !(await tx.ticketRef.count({ where: { ticketId: entrada.ticketId } }))
      )
        throw new BadRequestException('QHSE no conoce ese ticket (aún no se creó o no se asignó)');
      const creado = await tx.derrame.create({
        data: {
          id,
          ubicacionId: ubicacion.id,
          bandaId: banda.id,
          descripcion,
          ubicacionFisica: texto(entrada.ubicacionFisica),
          ticketId: entrada.ticketId ?? null,
          activadoPor: actor.id,
          createdBy: actor.id,
        },
        select: { numero: true },
      });
      numero = creado.numero;
      requiereMae = ubicacion.exigeNotificacionMae || banda.exigeNotificacionMae;
      await tx.derrameHistorial.create({
        data: { id: uuidv7(), derrameId: id, estadoNuevo: EstadoDerrame.activo, actorId: actor.id },
      });
      await this.eventos.publicar(tx, 'qhse.derrame.activado', id, actor);
      // la notificación al MAE es obligatoria desde el primer momento: se avisa de inmediato
      if (requiereMae) await this.eventos.publicar(tx, 'qhse.derrame.mae_pendiente', id, actor);
    });
    return {
      id,
      codigo: codigoDerrame(numero),
      estado: 'activo',
      requiereNotificacionMae: requiereMae,
    };
  }
}
