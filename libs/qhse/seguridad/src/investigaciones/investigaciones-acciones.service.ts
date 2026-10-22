import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { currentTraceparent, type AuthUser } from '@dyn/common';
import { EventBus } from '@dyn/messaging';
import { uuidv7 } from '@dyn/utils';
import { aFecha, hoyEcuador } from '../comun/fechas';
import { texto, type Tx } from '../epi/epi-tipos';
import {
  EstadoAccionInvestigacion,
  EstadoInvestigacion,
  NivelControlAccion,
  Prisma,
  TipoAccionInvestigacion,
} from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';
import { InvestigacionesConsultaService } from './investigaciones-consulta.service';
import { codigoInvestigacion } from './plazos';

const enActor = (a: AuthUser) => ({ userId: a.id, role: a.roleCode });

export interface AccionEntrada {
  descripcion: string;
  tipo: TipoAccionInvestigacion;
  responsableId: string;
  /** AAAA-MM-DD */
  plazo: string;
  controles?: NivelControlAccion[];
}

export type AccionCambios = Partial<AccionEntrada>;

/**
 * Acciones correctivas y preventivas de una investigación. Se registran y editan con la investigación en curso; implementarlas, verificar su
 * eficacia o cancelarlas es posible también después del cierre (el seguimiento continúa). Eventos `qhse.investigacion.accion_registrada|
 * implementada|verificada|cancelada` con ids, para reportería y avisos.
 */
@Injectable()
export class InvestigacionesAccionesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: EventBus,
    private readonly consulta: InvestigacionesConsultaService,
  ) {}

  async registrar(investigacionId: string, e: AccionEntrada, actor: AuthUser) {
    const descripcion = texto(e.descripcion);
    if (!descripcion) throw new BadRequestException('Describa la acción');
    this.exigirPlazoVigente(e.plazo);
    const niveles = [...new Set(e.controles ?? [])];
    const id = uuidv7();
    try {
      await this.prisma.$transaction(async (tx) => {
        const i = await tx.investigacion.findUnique({
          where: { id: investigacionId },
          select: { estado: true },
        });
        if (!i) throw new NotFoundException('La investigación no existe');
        if (i.estado !== EstadoInvestigacion.en_investigacion)
          throw new ConflictException('Solo se registran acciones con la investigación en curso');
        await this.exigirResponsable(tx, e.responsableId);
        const ultimo = await tx.investigacionAccion.aggregate({
          where: { investigacionId },
          _max: { orden: true },
        });
        await tx.investigacionAccion.create({
          data: {
            id,
            investigacionId,
            orden: (ultimo._max.orden ?? 0) + 1,
            descripcion,
            tipo: e.tipo,
            responsableId: e.responsableId,
            plazo: aFecha(e.plazo),
            createdBy: actor.id,
          },
        });
        await this.guardarControles(tx, id, niveles, actor);
        await this.historia(tx, id, null, EstadoAccionInvestigacion.pendiente, actor);
        await this.publicar(tx, 'qhse.investigacion.accion_registrada', id, actor);
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')
        throw new ConflictException('Otra persona registró una acción a la vez; intente de nuevo');
      throw err;
    }
    return this.consulta.detalle(investigacionId);
  }

  /** Cambia el contenido de una acción pendiente (investigación en curso). */
  async editar(investigacionId: string, accionId: string, c: AccionCambios, actor: AuthUser) {
    const descripcion = c.descripcion === undefined ? undefined : texto(c.descripcion);
    if (c.descripcion !== undefined && !descripcion)
      throw new BadRequestException('Describa la acción');
    if (c.plazo) this.exigirPlazoVigente(c.plazo);
    await this.prisma.$transaction(async (tx) => {
      const a = await this.encontrar(tx, investigacionId, accionId);
      if (
        a.estado !== EstadoAccionInvestigacion.pendiente ||
        a.investigacion.estado !== EstadoInvestigacion.en_investigacion
      )
        throw new ConflictException(
          'La acción ya no se edita: solo una acción pendiente de una investigación en curso',
        );
      if (c.responsableId) await this.exigirResponsable(tx, c.responsableId);
      const cambio = await tx.investigacionAccion.updateMany({
        where: { id: accionId, estado: EstadoAccionInvestigacion.pendiente },
        data: {
          ...(descripcion ? { descripcion } : {}),
          ...(c.tipo ? { tipo: c.tipo } : {}),
          ...(c.responsableId ? { responsableId: c.responsableId } : {}),
          ...(c.plazo ? { plazo: aFecha(c.plazo) } : {}),
          updatedBy: actor.id,
        },
      });
      if (cambio.count !== 1)
        throw new ConflictException('La acción cambió; recargue e intente de nuevo');
      if (c.controles) await this.guardarControles(tx, accionId, [...new Set(c.controles)], actor);
    });
    return this.consulta.detalle(investigacionId);
  }

  async implementar(
    investigacionId: string,
    accionId: string,
    observacion: string | undefined,
    actor: AuthUser,
  ) {
    await this.avanzar(
      investigacionId,
      accionId,
      EstadoAccionInvestigacion.pendiente,
      actor,
      async (tx) => {
        await tx.investigacionAccion.updateMany({
          where: { id: accionId, estado: EstadoAccionInvestigacion.pendiente },
          data: {
            estado: EstadoAccionInvestigacion.implementada,
            implementadaAt: new Date(),
            implementadaPor: actor.id,
            updatedBy: actor.id,
          },
        });
      },
      EstadoAccionInvestigacion.implementada,
      'qhse.investigacion.accion_implementada',
      texto(observacion),
    );
    return this.consulta.detalle(investigacionId);
  }

  /** Verificación de eficacia de una acción implementada. Si no resultó eficaz, la observación es obligatoria. */
  async verificar(
    investigacionId: string,
    accionId: string,
    v: { fueEficaz: boolean; observacion?: string },
    actor: AuthUser,
  ) {
    const obs = texto(v.observacion);
    if (!v.fueEficaz && !obs)
      throw new BadRequestException('Si la acción no resultó eficaz, explique por qué');
    await this.avanzar(
      investigacionId,
      accionId,
      EstadoAccionInvestigacion.implementada,
      actor,
      async (tx) => {
        await tx.investigacionAccion.updateMany({
          where: { id: accionId, estado: EstadoAccionInvestigacion.implementada },
          data: {
            estado: EstadoAccionInvestigacion.verificada,
            fueEficaz: v.fueEficaz,
            verificacionObservacion: obs,
            verificadaAt: new Date(),
            verificadaPor: actor.id,
            updatedBy: actor.id,
          },
        });
      },
      EstadoAccionInvestigacion.verificada,
      'qhse.investigacion.accion_verificada',
      obs,
    );
    return this.consulta.detalle(investigacionId);
  }

  /** Cancela una acción pendiente, con motivo (no se borra). */
  async cancelar(investigacionId: string, accionId: string, motivo: string, actor: AuthUser) {
    const m = texto(motivo);
    if (!m) throw new BadRequestException('Indique el motivo de la cancelación');
    await this.avanzar(
      investigacionId,
      accionId,
      EstadoAccionInvestigacion.pendiente,
      actor,
      async (tx) => {
        await tx.investigacionAccion.updateMany({
          where: { id: accionId, estado: EstadoAccionInvestigacion.pendiente },
          data: {
            estado: EstadoAccionInvestigacion.cancelada,
            canceladaAt: new Date(),
            canceladaPor: actor.id,
            cancelacionMotivo: m,
            updatedBy: actor.id,
          },
        });
      },
      EstadoAccionInvestigacion.cancelada,
      'qhse.investigacion.accion_cancelada',
      m,
    );
    return this.consulta.detalle(investigacionId);
  }

  // ------------------------------------------------------------------------------------------------------- internos

  /** Transición de estado de una acción: valida el estado de partida, aplica el cambio, deja la historia y publica el evento. */
  private async avanzar(
    investigacionId: string,
    accionId: string,
    desde: EstadoAccionInvestigacion,
    actor: AuthUser,
    aplicar: (tx: Tx) => Promise<void>,
    hacia: EstadoAccionInvestigacion,
    evento: string,
    observacion: string | null,
  ) {
    await this.prisma.$transaction(async (tx) => {
      const a = await this.encontrar(tx, investigacionId, accionId);
      if (a.estado !== desde)
        throw new ConflictException(`La acción está ${a.estado}: no se puede pasar a ${hacia}`);
      await aplicar(tx);
      const ahora = await tx.investigacionAccion.findUniqueOrThrow({
        where: { id: accionId },
        select: { estado: true },
      });
      if (ahora.estado !== hacia)
        throw new ConflictException('La acción cambió; recargue e intente de nuevo');
      await this.historia(tx, accionId, desde, hacia, actor, observacion ?? undefined);
      await this.publicar(tx, evento, accionId, actor);
    });
  }

  private async encontrar(tx: Tx, investigacionId: string, accionId: string) {
    const a = await tx.investigacionAccion.findFirst({
      where: { id: accionId, investigacionId },
      include: { investigacion: { select: { estado: true } } },
    });
    if (!a) throw new NotFoundException('La acción no existe en esta investigación');
    return a;
  }

  private exigirPlazoVigente(plazo: string) {
    if (plazo < hoyEcuador())
      throw new BadRequestException('El plazo no puede ser una fecha pasada');
  }

  private async exigirResponsable(tx: Tx, usuarioId: string) {
    const u = await tx.idUsuario.findUnique({ where: { id: usuarioId }, select: { activo: true } });
    if (!u?.activo) throw new BadRequestException('El responsable no existe o está inactivo');
  }

  private async guardarControles(
    tx: Tx,
    accionId: string,
    niveles: NivelControlAccion[],
    actor: AuthUser,
  ) {
    await tx.investigacionAccionControl.deleteMany({ where: { accionId } });
    if (niveles.length)
      await tx.investigacionAccionControl.createMany({
        data: niveles.map((nivel) => ({ accionId, nivel, createdBy: actor.id })),
      });
  }

  private async historia(
    tx: Tx,
    accionId: string,
    anterior: EstadoAccionInvestigacion | null,
    nuevo: EstadoAccionInvestigacion,
    actor: AuthUser,
    observacion?: string,
  ) {
    await tx.investigacionAccionHistorial.create({
      data: {
        id: uuidv7(),
        accionId,
        estadoAnterior: anterior,
        estadoNuevo: nuevo,
        actorId: actor.id,
        observacion: observacion ?? null,
      },
    });
  }

  private async publicar(tx: Tx, tipo: string, accionId: string, actor: AuthUser) {
    const a = await tx.investigacionAccion.findUniqueOrThrow({
      where: { id: accionId },
      include: { investigacion: { select: { id: true, numero: true } } },
    });
    await this.bus.publish(
      tx,
      this.bus.create({
        type: tipo,
        subject: { type: 'investigacion_accion', id: accionId },
        data: {
          investigacionId: a.investigacionId,
          investigacionCodigo: codigoInvestigacion(a.investigacion.numero),
          accionId,
          orden: a.orden,
          tipo: a.tipo,
          estado: a.estado,
          responsableId: a.responsableId,
          plazo: a.plazo.toISOString().slice(0, 10),
          fueEficaz: a.fueEficaz,
        },
        actor: enActor(actor),
        traceparent: currentTraceparent(),
      }),
    );
  }
}
