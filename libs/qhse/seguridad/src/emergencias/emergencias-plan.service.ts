import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AuthUser } from '@dyn/common';
import { uuidv7 } from '@dyn/utils';
import type { Tx } from '../epi/epi-tipos';
import { EstadoEmergencia } from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';
import { EmergenciasConsultaService, minutosEntre } from './emergencias-consulta.service';
import { EmergenciasEventosService } from './emergencias-eventos.service';

export interface ConteoEntrada {
  totalEnLocacion: number;
  evacuados: number;
}

const NOMBRE_NIVEL: Record<number, string> = {
  1: 'Nivel 1 — Menor (controlable en sitio)',
  2: 'Nivel 2 — Moderada (requiere apoyo externo)',
  3: 'Nivel 3 — Mayor (amenaza vidas y operación)',
};

/**
 * Plan de la emergencia (HSE-TRIAGE-001): el equipo HSE declara el nivel, cuenta al personal y registra la cascada de notificación. Cada
 * acción deja su línea en el cronómetro y su evento; las reglas las garantiza además la base (CHECK y triggers).
 */
@Injectable()
export class EmergenciasPlanService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventos: EmergenciasEventosService,
    private readonly consulta: EmergenciasConsultaService,
  ) {}

  /** Declara (o cambia, mientras no esté cerrada) el nivel de la emergencia. */
  async declararNivel(id: string, nivel: 1 | 2 | 3, actor: AuthUser) {
    if (![1, 2, 3].includes(nivel)) throw new BadRequestException('El nivel debe ser 1, 2 o 3');
    await this.prisma.$transaction(async (tx) => {
      const e = await this.abierta(tx, id);
      if (e.nivel === nivel) throw new ConflictException('La emergencia ya tiene ese nivel');
      await tx.emergencia.update({
        where: { id },
        data: {
          nivel,
          nivelDeclaradoPor: actor.id,
          nivelDeclaradoAt: new Date(),
          updatedBy: actor.id,
        },
      });
      await tx.emergenciaNivelHistorial.create({
        data: { id: uuidv7(), emergenciaId: id, nivel, actorId: actor.id },
      });
      await this.eventos.linea(
        tx,
        id,
        e.nivel === null
          ? `Nivel declarado: ${NOMBRE_NIVEL[nivel]}`
          : `Nivel cambiado de ${e.nivel} a ${nivel}: ${NOMBRE_NIVEL[nivel]}`,
        actor,
      );
      await this.eventos.publicar(tx, 'qhse.emergencia.nivel_declarado', id, actor, {
        nivel,
        nivelAnterior: e.nivel,
      });
    });
    return this.consulta.detalle(id);
  }

  /** Conteo de personal (se puede repetir): en la locación y evacuados; los faltantes se calculan. */
  async registrarConteo(id: string, entrada: ConteoEntrada, actor: AuthUser) {
    const { totalEnLocacion, evacuados } = entrada;
    if (!Number.isInteger(totalEnLocacion) || !Number.isInteger(evacuados))
      throw new BadRequestException('El conteo debe ser en número de personas');
    if (totalEnLocacion < 0 || evacuados < 0)
      throw new BadRequestException('El conteo no puede ser negativo');
    if (evacuados > totalEnLocacion)
      throw new BadRequestException(
        'Los evacuados no pueden ser más que las personas que estaban en la locación',
      );
    await this.prisma.$transaction(async (tx) => {
      await this.abierta(tx, id);
      await tx.emergencia.update({
        where: { id },
        data: {
          totalEnLocacion,
          evacuados,
          conteoPor: actor.id,
          conteoAt: new Date(),
          updatedBy: actor.id,
        },
      });
      await tx.emergenciaConteoHistorial.create({
        data: { id: uuidv7(), emergenciaId: id, totalEnLocacion, evacuados, actorId: actor.id },
      });
      const faltantes = totalEnLocacion - evacuados;
      await this.eventos.linea(
        tx,
        id,
        `Conteo de personal: ${totalEnLocacion} en la locación, ${evacuados} evacuados, ${faltantes} faltantes`,
        actor,
      );
      await this.eventos.publicar(tx, 'qhse.emergencia.conteo_completado', id, actor, {
        totalEnLocacion,
        evacuados,
        faltantes,
      });
    });
    return this.consulta.detalle(id);
  }

  /** Registra un paso de la cascada de notificación; informa si se cumplió su plazo. */
  async notificarPaso(id: string, pasoId: string, actor: AuthUser) {
    await this.prisma.$transaction(async (tx) => {
      const e = await this.abierta(tx, id);
      const paso = await tx.emergenciaPasoNotificacion.findUnique({ where: { id: pasoId } });
      if (!paso?.activo)
        throw new BadRequestException('Ese paso no forma parte de la cascada de notificación');
      if (await tx.emergenciaNotificacion.count({ where: { emergenciaId: id, pasoId } }))
        throw new ConflictException('Ese paso ya está notificado');
      const ahora = new Date();
      await tx.emergenciaNotificacion.create({
        data: { emergenciaId: id, pasoId, notificadoPor: actor.id, notificadoAt: ahora },
      });
      const minutos = minutosEntre(e.activadoAt, ahora);
      const enPlazo = minutos <= paso.plazoMinutos;
      await this.eventos.linea(
        tx,
        id,
        `Notificación ${paso.orden}: ${paso.desde} → ${paso.hacia} (${minutos} min; plazo ${paso.plazoMinutos} min${enPlazo ? '' : ', fuera de plazo'})`,
        actor,
      );
      await this.eventos.publicar(tx, 'qhse.emergencia.notificacion_realizada', id, actor, {
        paso: paso.orden,
        desde: paso.desde,
        hacia: paso.hacia,
        plazoMinutos: paso.plazoMinutos,
        minutos,
        enPlazo,
      });
    });
    return this.consulta.detalle(id);
  }

  /** La emergencia existe y no está cerrada. */
  private async abierta(tx: Tx, id: string) {
    const e = await tx.emergencia.findUnique({
      where: { id },
      select: { estado: true, nivel: true, activadoAt: true },
    });
    if (!e) throw new NotFoundException('La emergencia no existe');
    if (e.estado === EstadoEmergencia.cerrada)
      throw new ConflictException('Una emergencia cerrada ya no se modifica');
    return e;
  }
}
