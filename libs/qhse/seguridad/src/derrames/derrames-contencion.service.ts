import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AuthUser } from '@dyn/common';
import { uuidv7 } from '@dyn/utils';
import type { Tx } from '../epi/epi-tipos';
import { EstadoDerrame } from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  DerramesConsultaService,
  PLAZO_CONTENCION_MINUTOS,
  bandaDeVolumen,
  plazoDeContencion,
  requiereNotificacionMae,
} from './derrames-consulta.service';
import { DerramesEventosService } from './derrames-eventos.service';

/** Mayor que el máximo de la columna NUMERIC(10,3): el servicio responde con un mensaje claro en vez de un error de base. */
const MAX_BARRILES = 9_999_999;

/**
 * Contención del derrame en los primeros 5 minutos (HSE-AMBIENTAL-002) y volumen real. El equipo HSE confirma cada paso del checklist, marca
 * el derrame como contenido (solo con todos los pasos) y, después, confirma el volumen real en barriles. El plazo de 5 minutos se informa;
 * no bloquea. Las reglas las garantiza además la base (trigger `derrame_validar` y CHECK).
 */
@Injectable()
export class DerramesContencionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventos: DerramesEventosService,
    private readonly consulta: DerramesConsultaService,
  ) {}

  /** Confirma un paso del checklist de contención (con el derrame activo). */
  async confirmarPaso(id: string, itemId: string, actor: AuthUser) {
    await this.prisma.$transaction(async (tx) => {
      const d = await this.encontrar(tx, id);
      if (d.estado !== EstadoDerrame.activo)
        throw new ConflictException('Los pasos de contención se confirman con el derrame activo');
      const item = await tx.derrameChecklistItem.findUnique({ where: { id: itemId } });
      if (!item?.activo)
        throw new BadRequestException('Ese paso no forma parte del checklist de contención');
      if (await tx.derrameChecklistConfirmacion.count({ where: { derrameId: id, itemId } }))
        throw new ConflictException('Ese paso ya está confirmado');
      await tx.derrameChecklistConfirmacion.create({
        data: { derrameId: id, itemId, confirmadoPor: actor.id },
      });
    });
    return this.consulta.detalle(id);
  }

  /** Marca el derrame como contenido; exige todos los pasos confirmados. Informa si se cumplió el plazo de 5 minutos. */
  async contener(id: string, actor: AuthUser) {
    await this.prisma.$transaction(async (tx) => {
      const d = await this.encontrar(tx, id);
      if (d.estado !== EstadoDerrame.activo)
        throw new ConflictException('Solo se contiene un derrame activo');
      const faltan = await tx.derrameChecklistItem.findMany({
        where: { activo: true, confirmaciones: { none: { derrameId: id } } },
        orderBy: { orden: 'asc' },
        select: { nombre: true },
      });
      if (faltan.length)
        throw new ConflictException(
          `Para marcar el derrame como contenido confirme todo el checklist de contención. Falta: ${faltan.map((f) => f.nombre).join('; ')}`,
        );
      const ahora = new Date();
      const cambio = await tx.derrame.updateMany({
        where: { id, estado: EstadoDerrame.activo },
        data: {
          estado: EstadoDerrame.contenido,
          contenidoAt: ahora,
          contenidoPor: actor.id,
          updatedBy: actor.id,
        },
      });
      if (cambio.count !== 1)
        throw new ConflictException('El derrame cambió; recargue e intente de nuevo');
      await tx.derrameHistorial.create({
        data: {
          id: uuidv7(),
          derrameId: id,
          estadoAnterior: EstadoDerrame.activo,
          estadoNuevo: EstadoDerrame.contenido,
          actorId: actor.id,
        },
      });
      const plazo = plazoDeContencion(d.activadoAt, ahora);
      await this.eventos.publicar(tx, 'qhse.derrame.contenido', id, actor, {
        contencionMinutos: plazo.minutos,
        contencionEnPlazo: plazo.enPlazo,
        plazoMinutos: PLAZO_CONTENCION_MINUTOS,
      });
    });
    return this.consulta.detalle(id);
  }

  /**
   * Confirma (o corrige, mientras no esté cerrado) el volumen real en barriles. Si cae en una banda más grave que la reportada, ahora exige
   * notificar al MAE y puede escalar a emergencia: el evento lo dice.
   */
  async confirmarVolumen(id: string, barriles: number, actor: AuthUser) {
    if (!Number.isFinite(barriles) || barriles < 0)
      throw new BadRequestException(
        'El volumen real debe ser un número de barriles mayor o igual a cero',
      );
    if (barriles > MAX_BARRILES)
      throw new BadRequestException('El volumen real es demasiado grande');
    await this.prisma.$transaction(async (tx) => {
      const d = await this.encontrar(tx, id);
      if (d.estado !== EstadoDerrame.contenido)
        throw new ConflictException(
          d.estado === EstadoDerrame.activo
            ? 'El volumen real se confirma después de contener el derrame'
            : 'Un derrame cerrado ya no cambia su volumen',
        );
      const redondeado = Math.round(barriles * 1000) / 1000;
      const bandas = await this.consulta.bandasActivas(tx);
      const antes = await tx.derrame.findUniqueOrThrow({
        where: { id },
        include: { ubicacion: true, banda: true },
      });
      const yaRequeria = requiereNotificacionMae(this.consulta.reglas(antes, bandas));
      await tx.derrame.update({
        where: { id },
        data: {
          volumenRealBarriles: redondeado,
          volumenConfirmadoPor: actor.id,
          volumenConfirmadoAt: new Date(),
          updatedBy: actor.id,
        },
      });
      await tx.derrameVolumenHistorial.create({
        data: { id: uuidv7(), derrameId: id, volumenBarriles: redondeado, actorId: actor.id },
      });
      const real = bandaDeVolumen(bandas, redondeado);
      await this.eventos.publicar(tx, 'qhse.derrame.volumen_confirmado', id, actor, {
        volumenConfirmadoBarriles: redondeado,
        bandaReal: real?.codigo ?? null,
      });
      // la banda real es más grave que la reportada y ahora exige notificar al MAE: aviso de inmediato
      const ahoraRequiere = requiereNotificacionMae({
        ubicacion: antes.ubicacion,
        banda: antes.banda,
        bandaReal: real,
      });
      if (!yaRequeria && ahoraRequiere)
        await this.eventos.publicar(tx, 'qhse.derrame.mae_pendiente', id, actor);
    });
    return this.consulta.detalle(id);
  }

  private async encontrar(tx: Tx, id: string) {
    const d = await tx.derrame.findUnique({
      where: { id },
      select: { estado: true, activadoAt: true },
    });
    if (!d) throw new NotFoundException('El derrame no existe');
    return d;
  }
}
