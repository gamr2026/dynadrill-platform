import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { currentTraceparent, type AuthUser } from '@dyn/common';
import { EventBus } from '@dyn/messaging';
import { PrismaService } from '../prisma/prisma.service';

export interface ActualizarBandaEntrada {
  nombre?: string;
  /** Barriles; el límite inferior de la banda (incluido). */
  desdeBarriles?: number;
  /** Barriles; el límite superior (excluido). `null` = sin tope. */
  hastaBarriles?: number | null;
  exigeNotificacionMae?: boolean;
  escalaAEmergencia?: boolean;
  /** `false` cuando Dynadrill confirma el umbral. */
  porConfirmar?: boolean;
  activo?: boolean;
}

/**
 * Configuración de las bandas de volumen de los derrames. Los valores sembrados son un supuesto de la demo y quedan «por confirmar con
 * Dynadrill»; el Gerente HSE los ajusta aquí. Cada cambio se publica con el valor anterior y el nuevo (`qhse.derrame.banda_configurada`).
 * La base impide rangos inválidos y bandas activas solapadas.
 */
@Injectable()
export class DerramesBandasService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: EventBus,
  ) {}

  /** Todas las bandas (también las inactivas), con su rango y si siguen por confirmar. */
  async listar() {
    const filas = await this.prisma.derrameBandaVolumen.findMany({ orderBy: { orden: 'asc' } });
    return filas.map((b) => this.vista(b));
  }

  async actualizar(id: string, e: ActualizarBandaEntrada, actor: AuthUser) {
    const nombre = e.nombre?.trim();
    if (e.nombre !== undefined && !nombre)
      throw new BadRequestException('La banda necesita un nombre');
    const antes = await this.prisma.derrameBandaVolumen.findUnique({ where: { id } });
    if (!antes) throw new NotFoundException('La banda no existe');
    const desde = e.desdeBarriles ?? Number(antes.desdeBarriles);
    const hasta =
      e.hastaBarriles === undefined
        ? antes.hastaBarriles === null
          ? null
          : Number(antes.hastaBarriles)
        : e.hastaBarriles;
    if (desde < 0 || (hasta !== null && hasta <= desde))
      throw new BadRequestException(
        'El rango de la banda no es válido: el volumen inicial no puede ser negativo y el final debe ser mayor que el inicial',
      );
    try {
      const despues = await this.prisma.$transaction(async (tx) => {
        const d = await tx.derrameBandaVolumen.update({
          where: { id },
          data: {
            ...(nombre ? { nombre } : {}),
            desdeBarriles: desde,
            hastaBarriles: hasta,
            ...(e.exigeNotificacionMae === undefined
              ? {}
              : { exigeNotificacionMae: e.exigeNotificacionMae }),
            ...(e.escalaAEmergencia === undefined
              ? {}
              : { escalaAEmergencia: e.escalaAEmergencia }),
            ...(e.porConfirmar === undefined ? {} : { porConfirmar: e.porConfirmar }),
            ...(e.activo === undefined ? {} : { activo: e.activo }),
            updatedBy: actor.id,
          },
        });
        await this.bus.publish(
          tx,
          this.bus.create({
            type: 'qhse.derrame.banda_configurada',
            subject: { type: 'derrame_banda', id },
            data: {
              bandaId: id,
              codigo: d.codigo,
              antes: this.vista(antes),
              despues: this.vista(d),
            },
            actor: { userId: actor.id, role: actor.roleCode },
            traceparent: currentTraceparent(),
          }),
        );
        return d;
      });
      return this.vista(despues);
    } catch (error) {
      const mensaje = error instanceof Error ? error.message : '';
      if (mensaje.includes('derrame_banda_volumen_sin_solape'))
        throw new ConflictException(
          'Ese rango se solapa con otra banda activa: ajuste primero la otra banda o desactívela',
        );
      throw error;
    }
  }

  private vista(b: {
    id: string;
    codigo: string;
    nombre: string;
    orden: number;
    desdeBarriles: { toString(): string };
    hastaBarriles: { toString(): string } | null;
    exigeNotificacionMae: boolean;
    escalaAEmergencia: boolean;
    porConfirmar: boolean;
    activo: boolean;
  }) {
    return {
      id: b.id,
      codigo: b.codigo,
      nombre: b.nombre,
      orden: b.orden,
      desdeBarriles: Number(b.desdeBarriles),
      hastaBarriles: b.hastaBarriles === null ? null : Number(b.hastaBarriles),
      exigeNotificacionMae: b.exigeNotificacionMae,
      escalaAEmergencia: b.escalaAEmergencia,
      /** Verdadero mientras Dynadrill no confirme el umbral. */
      porConfirmar: b.porConfirmar,
      activo: b.activo,
    };
  }
}
