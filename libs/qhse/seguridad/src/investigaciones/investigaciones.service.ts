import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../generated/client';
import { currentTraceparent, type AuthUser } from '@dyn/common';
import { EventBus } from '@dyn/messaging';
import { uuidv7 } from '@dyn/utils';
import { texto, type Tx } from '../epi/epi-tipos';
import { EstadoInvestigacion } from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';
import { InvestigacionesConsultaService } from './investigaciones-consulta.service';
import { codigoInvestigacion } from './plazos';

const enActor = (a: AuthUser) => ({ userId: a.id, role: a.roleCode });

export interface AbrirInvestigacionEntrada {
  resultadoId: string;
  descripcionEvento: string;
  fechaIncidente: Date;
  ubicacion: string;
  /** Emergencia de Nivel 2/3 que originó la investigación (sin FK hasta que exista la tabla de emergencias). */
  origenEmergenciaId?: string | null;
}

export interface IniciarInvestigacionEntrada {
  liderId: string;
  /** Si no viene, ahora. */
  escenaAseguradaAt?: Date | null;
}

/**
 * Investigación de incidentes (DYN-SGI-RE-034). Esta rebanada cubre abrirla e iniciarla (líder y escena asegurada). Eventos
 * `qhse.investigacion.abierta|iniciada` con ids y el resultado, para reportería (TRIR, LTIR, ratio Near Miss:incidente) y avisos.
 */
@Injectable()
export class InvestigacionesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: EventBus,
    private readonly consulta: InvestigacionesConsultaService,
  ) {}

  async abrir(e: AbrirInvestigacionEntrada, actor: AuthUser) {
    const descripcion = texto(e.descripcionEvento);
    const ubicacion = texto(e.ubicacion);
    if (!descripcion) throw new BadRequestException('Describa el evento');
    if (!ubicacion) throw new BadRequestException('Indique la ubicación del incidente');
    if (e.fechaIncidente.getTime() > Date.now())
      throw new BadRequestException('La fecha del incidente no puede ser futura');
    const id = uuidv7();
    try {
      await this.prisma.$transaction(async (tx) => {
        const r = await tx.investigacionResultado.findUnique({ where: { id: e.resultadoId } });
        if (!r || !r.activo) throw new BadRequestException('El resultado del incidente no existe');
        await tx.investigacion.create({
          data: {
            id,
            resultadoId: e.resultadoId,
            descripcionEvento: descripcion,
            fechaIncidente: e.fechaIncidente,
            ubicacion,
            origenEmergenciaId: e.origenEmergenciaId ?? null,
            createdBy: actor.id,
          },
        });
        await this.historia(tx, id, null, EstadoInvestigacion.abierta, actor);
        await this.publicar(tx, 'qhse.investigacion.abierta', id, actor);
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')
        throw new ConflictException('Esa emergencia ya tiene una investigación');
      throw err;
    }
    return this.consulta.detalle(id);
  }

  /** Nombra al líder y registra el momento en que se aseguró la escena: la investigación pasa a «en investigación». */
  async iniciar(id: string, e: IniciarInvestigacionEntrada, actor: AuthUser) {
    await this.prisma.$transaction(async (tx) => {
      const i = await tx.investigacion.findUnique({ where: { id } });
      if (!i) throw new NotFoundException('La investigación no existe');
      if (i.estado !== EstadoInvestigacion.abierta)
        throw new ConflictException('La investigación ya fue iniciada');
      const escena = e.escenaAseguradaAt ?? new Date();
      if (escena.getTime() > Date.now())
        throw new BadRequestException('La escena no puede asegurarse en el futuro');
      if (escena.getTime() < i.fechaIncidente.getTime())
        throw new BadRequestException('La escena no puede asegurarse antes del incidente');
      const lider = await tx.idUsuario.findUnique({
        where: { id: e.liderId },
        select: { activo: true },
      });
      if (!lider?.activo)
        throw new BadRequestException('El líder de la investigación no existe o está inactivo');
      const cambio = await tx.investigacion.updateMany({
        where: { id, estado: EstadoInvestigacion.abierta },
        data: {
          estado: EstadoInvestigacion.en_investigacion,
          liderId: e.liderId,
          escenaAseguradaAt: escena,
          updatedBy: actor.id,
        },
      });
      if (cambio.count !== 1)
        throw new ConflictException('La investigación cambió; recargue e intente de nuevo');
      await this.historia(
        tx,
        id,
        EstadoInvestigacion.abierta,
        EstadoInvestigacion.en_investigacion,
        actor,
      );
      await this.publicar(tx, 'qhse.investigacion.iniciada', id, actor);
    });
    return this.consulta.detalle(id);
  }

  // ------------------------------------------------------------------------------------------------------- internos

  private async historia(
    tx: Tx,
    investigacionId: string,
    anterior: EstadoInvestigacion | null,
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

  private async publicar(tx: Tx, tipo: string, investigacionId: string, actor: AuthUser) {
    const i = await tx.investigacion.findUniqueOrThrow({
      where: { id: investigacionId },
      include: { resultado: { select: { codigo: true, involucraLesionado: true } } },
    });
    await this.bus.publish(
      tx,
      this.bus.create({
        type: tipo,
        subject: { type: 'investigacion', id: investigacionId },
        data: {
          investigacionId,
          numero: i.numero,
          codigo: codigoInvestigacion(i.numero),
          estado: i.estado,
          resultado: i.resultado.codigo,
          involucraLesionado: i.resultado.involucraLesionado,
          fechaIncidente: i.fechaIncidente.toISOString(),
          origenEmergenciaId: i.origenEmergenciaId,
          liderId: i.liderId,
          // texto para el aviso (no cambia: dónde ocurrió al momento de abrirla)
          ubicacion: i.ubicacion,
        },
        actor: enActor(actor),
        traceparent: currentTraceparent(),
      }),
    );
  }
}
