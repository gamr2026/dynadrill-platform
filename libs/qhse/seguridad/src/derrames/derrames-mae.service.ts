import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { AuthUser } from '@dyn/common';
import { uuidv7 } from '@dyn/utils';
import { texto, type Tx } from '../epi/epi-tipos';
import { EstadoDerrame } from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';
import { DerramesConsultaService, requiereNotificacionMae } from './derrames-consulta.service';
import { DerramesEventosService } from './derrames-eventos.service';

/**
 * Notificación al MAE y cierre del derrame (HSE-AMBIENTAL-002). La notificación es obligatoria cuando la ubicación o la banda de volumen
 * (la más grave entre la reportada y la real) la exigen; un derrame que la exige no se cierra sin registrarla. Una notificación registrada no
 * se cambia. Las reglas las garantiza además la base (trigger `derrame_validar`).
 */
@Injectable()
export class DerramesMaeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventos: DerramesEventosService,
    private readonly consulta: DerramesConsultaService,
  ) {}

  /** Registra que se notificó al MAE (con la referencia del oficio, si la hay). Solo si el derrame la requiere. */
  async notificarMae(id: string, entrada: { referencia?: string | null }, actor: AuthUser) {
    await this.prisma.$transaction(async (tx) => {
      const d = await this.encontrar(tx, id);
      if (d.estado === EstadoDerrame.cerrado)
        throw new ConflictException('Un derrame cerrado ya no cambia');
      if (!(await this.requiere(tx, id)))
        throw new ConflictException(
          'Este derrame no requiere notificar al MAE (por su ubicación y su volumen)',
        );
      if (d.notificadoMaeAt)
        throw new ConflictException('La notificación al MAE ya está registrada');
      await tx.derrame.update({
        where: { id },
        data: {
          notificadoMaeAt: new Date(),
          notificadoMaePor: actor.id,
          maeReferencia: texto(entrada.referencia),
          updatedBy: actor.id,
        },
      });
      await this.eventos.publicar(tx, 'qhse.derrame.mae_notificado', id, actor, {
        maeReferencia: texto(entrada.referencia),
      });
    });
    return this.consulta.detalle(id);
  }

  /** Cierra el derrame contenido; exige la notificación al MAE si el derrame la requiere. */
  async cerrar(id: string, actor: AuthUser) {
    await this.prisma.$transaction(async (tx) => {
      const d = await this.encontrar(tx, id);
      if (d.estado !== EstadoDerrame.contenido)
        throw new ConflictException(
          d.estado === EstadoDerrame.activo
            ? 'Primero contenga el derrame: solo se cierra uno contenido'
            : 'El derrame ya está cerrado',
        );
      if ((await this.requiere(tx, id)) && !d.notificadoMaeAt)
        throw new ConflictException(
          'Para cerrar el derrame registre antes la notificación al MAE: es obligatoria por su ubicación o su volumen',
        );
      const cambio = await tx.derrame.updateMany({
        where: { id, estado: EstadoDerrame.contenido },
        data: {
          estado: EstadoDerrame.cerrado,
          cerradoAt: new Date(),
          cerradoPor: actor.id,
          updatedBy: actor.id,
        },
      });
      if (cambio.count !== 1)
        throw new ConflictException('El derrame cambió; recargue e intente de nuevo');
      await tx.derrameHistorial.create({
        data: {
          id: uuidv7(),
          derrameId: id,
          estadoAnterior: EstadoDerrame.contenido,
          estadoNuevo: EstadoDerrame.cerrado,
          actorId: actor.id,
        },
      });
      await this.eventos.publicar(tx, 'qhse.derrame.cerrado', id, actor);
    });
    return this.consulta.detalle(id);
  }

  /** ¿Este derrame debe notificar al MAE? Ubicación, banda reportada o banda del volumen real. */
  private async requiere(tx: Tx, id: string): Promise<boolean> {
    const d = await tx.derrame.findUniqueOrThrow({
      where: { id },
      include: { ubicacion: true, banda: true },
    });
    const bandas = await this.consulta.bandasActivas(tx);
    return requiereNotificacionMae(this.consulta.reglas(d, bandas));
  }

  private async encontrar(tx: Tx, id: string) {
    const d = await tx.derrame.findUnique({
      where: { id },
      select: { estado: true, notificadoMaeAt: true },
    });
    if (!d) throw new NotFoundException('El derrame no existe');
    return d;
  }
}
