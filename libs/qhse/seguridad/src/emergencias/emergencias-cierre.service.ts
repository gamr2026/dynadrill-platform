import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AuthUser } from '@dyn/common';
import { uuidv7 } from '@dyn/utils';
import { texto, type Tx } from '../epi/epi-tipos';
import { EstadoEmergencia } from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  EmergenciasConsultaService,
  PLAZO_REPORTE_FLASH_MINUTOS,
  minutosEntre,
} from './emergencias-consulta.service';
import { EmergenciasEventosService } from './emergencias-eventos.service';

export interface ReporteFlashEntrada {
  resumenEjecutivo: string;
  personalAfectado: string;
  accionesTomadas: string;
  estadoActual: string;
  proximosPasos: string;
}

/**
 * Reporte Flash, paso a controlada y cierre (HSE-TRIAGE-001). El Reporte Flash se emite una sola vez, completo; su plazo de 2 horas se informa
 * pero no bloquea. Cerrar exige el Reporte Flash, el nivel declarado y, en nivel 2 o 3, la investigación de incidentes (HSE-TRIAGE-002) si esa
 * tabla existe. Las reglas las garantiza además la base (CHECK y trigger `emergencia_validar`).
 */
@Injectable()
export class EmergenciasCierreService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventos: EmergenciasEventosService,
    private readonly consulta: EmergenciasConsultaService,
  ) {}

  /** Emite el Reporte Flash (una vez); informa si se emitió fuera del plazo de 2 horas. */
  async emitirReporteFlash(id: string, entrada: ReporteFlashEntrada, actor: AuthUser) {
    const campos = {
      resumenEjecutivo: texto(entrada.resumenEjecutivo),
      personalAfectado: texto(entrada.personalAfectado),
      accionesTomadas: texto(entrada.accionesTomadas),
      estadoActual: texto(entrada.estadoActual),
      proximosPasos: texto(entrada.proximosPasos),
    };
    const falta = Object.entries(campos).find(([, v]) => !v);
    if (falta)
      throw new BadRequestException(
        'El Reporte Flash se emite completo: resumen ejecutivo, personal afectado, acciones tomadas, estado actual y próximos pasos',
      );
    await this.prisma.$transaction(async (tx) => {
      const e = await this.abierta(tx, id);
      if (await tx.emergenciaReporteFlash.count({ where: { emergenciaId: id } }))
        throw new ConflictException('El Reporte Flash de esta emergencia ya fue emitido');
      const ahora = new Date();
      await tx.emergenciaReporteFlash.create({
        data: {
          emergenciaId: id,
          resumenEjecutivo: campos.resumenEjecutivo ?? '',
          personalAfectado: campos.personalAfectado ?? '',
          accionesTomadas: campos.accionesTomadas ?? '',
          estadoActual: campos.estadoActual ?? '',
          proximosPasos: campos.proximosPasos ?? '',
          emitidoAt: ahora,
          emitidoPor: actor.id,
        },
      });
      const minutos = minutosEntre(e.activadoAt, ahora);
      const fueraDePlazo = minutos > PLAZO_REPORTE_FLASH_MINUTOS;
      await this.eventos.linea(
        tx,
        id,
        `Reporte Flash emitido (${minutos} min desde la activación${fueraDePlazo ? ', fuera del plazo de 2 horas' : ''})`,
        actor,
      );
      await this.eventos.publicar(tx, 'qhse.emergencia.reporte_flash_emitido', id, actor, {
        minutos,
        fueraDePlazo,
        plazoMinutos: PLAZO_REPORTE_FLASH_MINUTOS,
      });
    });
    return this.consulta.detalle(id);
  }

  /** Marca la emergencia como controlada. */
  async controlar(id: string, actor: AuthUser) {
    await this.prisma.$transaction(async (tx) => {
      const e = await this.abierta(tx, id);
      if (e.estado !== EstadoEmergencia.activa)
        throw new ConflictException('Solo se marca como controlada una emergencia activa');
      const cambio = await tx.emergencia.updateMany({
        where: { id, estado: EstadoEmergencia.activa },
        data: {
          estado: EstadoEmergencia.controlada,
          controladaAt: new Date(),
          controladaPor: actor.id,
          updatedBy: actor.id,
        },
      });
      if (cambio.count !== 1)
        throw new ConflictException('La emergencia cambió; recargue e intente de nuevo');
      await tx.emergenciaHistorial.create({
        data: {
          id: uuidv7(),
          emergenciaId: id,
          estadoAnterior: EstadoEmergencia.activa,
          estadoNuevo: EstadoEmergencia.controlada,
          actorId: actor.id,
        },
      });
      await this.eventos.linea(tx, id, 'Emergencia controlada', actor);
      await this.eventos.publicar(tx, 'qhse.emergencia.controlada', id, actor);
    });
    return this.consulta.detalle(id);
  }

  /** Cierra la emergencia controlada: exige el Reporte Flash, el nivel declarado y, en nivel 2 o 3, la investigación. */
  async cerrar(id: string, actor: AuthUser) {
    await this.prisma.$transaction(async (tx) => {
      const e = await this.abierta(tx, id);
      if (e.estado !== EstadoEmergencia.controlada)
        throw new ConflictException(
          'Primero marque la emergencia como controlada: solo se cierra una controlada',
        );
      if (!(await tx.emergenciaReporteFlash.count({ where: { emergenciaId: id } })))
        throw new ConflictException('Para cerrar la emergencia emita antes el Reporte Flash');
      if (e.nivel === null)
        throw new ConflictException('Para cerrar la emergencia declare antes su nivel');
      // manda el nivel MÁS ALTO declarado: bajarlo antes de cerrar no evita la investigación
      const maximo = await tx.emergenciaNivelHistorial.aggregate({
        where: { emergenciaId: id },
        _max: { nivel: true },
      });
      const requiere = Math.max(e.nivel, maximo._max.nivel ?? 0) >= 2;
      if (requiere && !(await this.consulta.tieneInvestigacion(tx, id)))
        throw new ConflictException(
          'Una emergencia de nivel 2 o 3 no se cierra sin su investigación de incidentes (HSE-TRIAGE-002): ábrala antes de cerrar',
        );
      const cambio = await tx.emergencia.updateMany({
        where: { id, estado: EstadoEmergencia.controlada },
        data: {
          estado: EstadoEmergencia.cerrada,
          cerradaAt: new Date(),
          cerradaPor: actor.id,
          updatedBy: actor.id,
        },
      });
      if (cambio.count !== 1)
        throw new ConflictException('La emergencia cambió; recargue e intente de nuevo');
      await tx.emergenciaHistorial.create({
        data: {
          id: uuidv7(),
          emergenciaId: id,
          estadoAnterior: EstadoEmergencia.controlada,
          estadoNuevo: EstadoEmergencia.cerrada,
          actorId: actor.id,
        },
      });
      await this.eventos.linea(tx, id, 'Emergencia cerrada', actor);
      await this.eventos.publicar(tx, 'qhse.emergencia.cerrada', id, actor, {
        nivel: e.nivel,
        requiereInvestigacion: requiere,
      });
    });
    return this.consulta.detalle(id);
  }

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
