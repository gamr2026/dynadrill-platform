import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { currentTraceparent, type AuthUser } from '@dyn/common';
import { EventBus } from '@dyn/messaging';
import { uuidv7 } from '@dyn/utils';
import { texto, type Tx } from '../epi/epi-tipos';
import {
  ConclusionInvestigacion,
  EstadoAccionInvestigacion,
  EstadoInvestigacion,
} from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';
import { faltaParaCierre, faltaParaRevision } from './cierre';
import { InvestigacionesConsultaService } from './investigaciones-consulta.service';
import { codigoInvestigacion, limitesParaAviso } from './plazos';

const enActor = (a: AuthUser) => ({ userId: a.id, role: a.roleCode });

export interface ConclusionEntrada {
  conclusion?: ConclusionInvestigacion | null;
  leccionesAprendidas?: string | null;
  /** Actividad de la matriz IPERC a la que aplica la lección aprendida (solo el vínculo). */
  ipercActividadId?: string | null;
}

export interface NotificacionLegalEntrada {
  requerida: boolean;
  ministerioTrabajoNotificadoAt?: Date | null;
  iessNotificadoAt?: Date | null;
}

/**
 * Conclusión, notificación legal, lección aprendida, revisión y cierre de la investigación. Enviarla a revisión es de quien la gestiona; devolverla
 * o cerrarla (aprobar el informe) es del Gerente HSE. Eventos `qhse.investigacion.enviada_a_revision|devuelta|cerrada`.
 */
@Injectable()
export class InvestigacionesCierreService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: EventBus,
    private readonly consulta: InvestigacionesConsultaService,
  ) {}

  async guardarConclusion(id: string, e: ConclusionEntrada, actor: AuthUser) {
    await this.editable(id, async (tx) => {
      if (
        e.ipercActividadId &&
        !(await tx.ipercActividad.count({ where: { id: e.ipercActividadId } }))
      )
        throw new BadRequestException('La actividad de la matriz IPERC no existe');
      await tx.investigacion.update({
        where: { id },
        data: {
          conclusion: e.conclusion ?? null,
          leccionesAprendidas: texto(e.leccionesAprendidas),
          ipercActividadId: e.ipercActividadId ?? null,
          updatedBy: actor.id,
        },
      });
    });
    return this.consulta.detalle(id);
  }

  async guardarNotificacionLegal(id: string, e: NotificacionLegalEntrada, actor: AuthUser) {
    const mt = e.ministerioTrabajoNotificadoAt ?? null;
    const iess = e.iessNotificadoAt ?? null;
    if (!e.requerida && (mt || iess))
      throw new BadRequestException(
        'Marque la notificación legal como obligatoria para registrar sus fechas',
      );
    await this.editable(id, async (tx, i) => {
      for (const f of [mt, iess]) {
        if (!f) continue;
        if (f.getTime() > Date.now())
          throw new BadRequestException('La fecha de notificación no puede ser futura');
        if (f.getTime() < i.fechaIncidente.getTime())
          throw new BadRequestException('La notificación no puede ser anterior al incidente');
      }
      await tx.investigacion.update({
        where: { id },
        data: {
          notificacionLegalRequerida: e.requerida,
          ministerioTrabajoNotificadoAt: mt,
          iessNotificadoAt: iess,
          updatedBy: actor.id,
        },
      });
    });
    return this.consulta.detalle(id);
  }

  /** Envía la investigación a revisión del Gerente HSE: exige 5 Porqués, conclusión y al menos una acción. */
  async enviarARevision(id: string, actor: AuthUser) {
    await this.prisma.$transaction(async (tx) => {
      const i = await this.encontrar(tx, id);
      if (i.estado !== EstadoInvestigacion.en_investigacion)
        throw new ConflictException('Solo se envía a revisión una investigación en curso');
      const falta = faltaParaRevision({
        porques: await tx.investigacionPorque.count({ where: { investigacionId: id } }),
        conclusion: i.conclusion,
        accionesVigentes: await tx.investigacionAccion.count({
          where: { investigacionId: id, estado: { not: EstadoAccionInvestigacion.cancelada } },
        }),
      });
      if (falta.length) throw new BadRequestException(falta.join('. '));
      await this.cambiarEstado(tx, id, EstadoInvestigacion.en_investigacion, {
        estado: EstadoInvestigacion.en_revision,
        revisionEnviadaAt: new Date(),
        revisionEnviadaPor: actor.id,
        updatedBy: actor.id,
      });
      await this.historia(
        tx,
        id,
        EstadoInvestigacion.en_investigacion,
        EstadoInvestigacion.en_revision,
        actor,
      );
      await this.publicar(tx, 'qhse.investigacion.enviada_a_revision', id, actor);
    });
    return this.consulta.detalle(id);
  }

  /** El Gerente HSE devuelve el informe al equipo con su observación: vuelve a «en investigación». */
  async devolver(id: string, observacion: string, actor: AuthUser) {
    const obs = texto(observacion);
    if (!obs) throw new BadRequestException('Escriba qué debe corregirse');
    await this.prisma.$transaction(async (tx) => {
      const i = await this.encontrar(tx, id);
      if (i.estado !== EstadoInvestigacion.en_revision)
        throw new ConflictException('Solo se devuelve una investigación que está en revisión');
      await this.cambiarEstado(tx, id, EstadoInvestigacion.en_revision, {
        estado: EstadoInvestigacion.en_investigacion,
        revisionEnviadaAt: null,
        revisionEnviadaPor: null,
        updatedBy: actor.id,
      });
      await this.historia(
        tx,
        id,
        EstadoInvestigacion.en_revision,
        EstadoInvestigacion.en_investigacion,
        actor,
        obs,
      );
      await this.publicar(tx, 'qhse.investigacion.devuelta', id, actor, obs);
    });
    return this.consulta.detalle(id);
  }

  /** El Gerente HSE aprueba el informe y cierra la investigación (queda congelada; sigue el seguimiento de sus acciones). */
  async cerrar(id: string, actor: AuthUser) {
    await this.prisma.$transaction(async (tx) => {
      const i = await this.encontrar(tx, id);
      if (i.estado !== EstadoInvestigacion.en_revision)
        throw new ConflictException('Solo se cierra una investigación que está en revisión');
      const falta = faltaParaCierre(i);
      if (falta.length) throw new BadRequestException(falta.join('. '));
      await this.cambiarEstado(tx, id, EstadoInvestigacion.en_revision, {
        estado: EstadoInvestigacion.cerrada,
        cerradaAt: new Date(),
        cerradaPor: actor.id,
        updatedBy: actor.id,
      });
      await this.historia(
        tx,
        id,
        EstadoInvestigacion.en_revision,
        EstadoInvestigacion.cerrada,
        actor,
      );
      await this.publicar(tx, 'qhse.investigacion.cerrada', id, actor);
    });
    return this.consulta.detalle(id);
  }

  // ------------------------------------------------------------------------------------------------------- internos

  private async encontrar(tx: Tx, id: string) {
    const i = await tx.investigacion.findUnique({ where: { id } });
    if (!i) throw new NotFoundException('La investigación no existe');
    return i;
  }

  /** Cambio condicionado al estado de partida: si otra persona actuó a la vez, no se duplica el evento. */
  private async cambiarEstado(
    tx: Tx,
    id: string,
    desde: EstadoInvestigacion,
    data: Parameters<Tx['investigacion']['updateMany']>[0]['data'],
  ) {
    const cambio = await tx.investigacion.updateMany({ where: { id, estado: desde }, data });
    if (cambio.count !== 1)
      throw new ConflictException('La investigación cambió; recargue e intente de nuevo');
  }

  /** Corre el cambio solo si la investigación existe y todavía se puede editar (abierta o en investigación). */
  private async editable(
    id: string,
    cambio: (tx: Tx, i: { fechaIncidente: Date }) => Promise<void>,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const i = await this.encontrar(tx, id);
      if (
        i.estado !== EstadoInvestigacion.abierta &&
        i.estado !== EstadoInvestigacion.en_investigacion
      )
        throw new ConflictException('La investigación ya no admite cambios');
      await cambio(tx, i);
    });
  }

  private async historia(
    tx: Tx,
    investigacionId: string,
    anterior: EstadoInvestigacion,
    nuevo: EstadoInvestigacion,
    actor: AuthUser,
    observacion?: string,
  ) {
    await tx.investigacionHistorial.create({
      data: {
        id: uuidv7(),
        investigacionId,
        estadoAnterior: anterior,
        estadoNuevo: nuevo,
        actorId: actor.id,
        observacion: observacion ?? null,
      },
    });
  }

  private async publicar(tx: Tx, tipo: string, id: string, actor: AuthUser, observacion?: string) {
    const i = await tx.investigacion.findUniqueOrThrow({
      where: { id },
      include: {
        resultado: {
          select: {
            codigo: true,
            nombre: true,
            involucraLesionado: true,
            inicioHoras: true,
            preliminarHoras: true,
            finalDias: true,
          },
        },
        detalle: { select: { totalDiasIncapacidad: true } },
      },
    });
    await this.bus.publish(
      tx,
      this.bus.create({
        type: tipo,
        subject: { type: 'investigacion', id },
        data: {
          investigacionId: id,
          numero: i.numero,
          codigo: codigoInvestigacion(i.numero),
          estado: i.estado,
          resultado: i.resultado.codigo,
          resultadoNombre: i.resultado.nombre,
          ...limitesParaAviso(i.fechaIncidente, i.resultado),
          involucraLesionado: i.resultado.involucraLesionado,
          fechaIncidente: i.fechaIncidente.toISOString(),
          conclusion: i.conclusion,
          // insumos de HSE-MASTER-001 (TRIR, LTIR, ratio Near Miss:incidente)
          totalDiasIncapacidad: i.detalle?.totalDiasIncapacidad ?? null,
          liderId: i.liderId,
          ubicacion: i.ubicacion,
          ...(observacion ? { observacion } : {}),
        },
        actor: enActor(actor),
        traceparent: currentTraceparent(),
      }),
    );
  }
}
