import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { currentTraceparent, type AuthUser } from '@dyn/common';
import { EventBus } from '@dyn/messaging';
import { uuidv7 } from '@dyn/utils';
import { aDia, aFecha, hoyEcuador } from '../comun/fechas';
import { texto, type Tx } from '../epi/epi-tipos';
import {
  ClasificacionAspecto,
  CondicionOperacionAspecto,
  EstadoAspecto,
  EstadoControlAspecto,
  Prisma,
  TipoImpactoAspecto,
  TipoResponsabilidadAspecto,
} from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  AspectosAmbientalesConsultaService,
  codigoAspecto,
  nivelRiesgoAspecto,
} from './aspectos-ambientales-consulta.service';

const enActor = (a: AuthUser) => ({ userId: a.id, role: a.roleCode });

export interface AspectoEntrada {
  /** AAAA-MM-DD; si no viene, hoy. */
  fecha?: string | null;
  etapaId: string;
  procesoId: string;
  actividad: string;
  produccionDelAspecto?: string | null;
  riesgoGestion?: string | null;
  aspecto: string;
  impacto: string;
  factorId?: string | null;
  condicionOperacion?: CondicionOperacionAspecto | null;
  tipoResponsabilidad?: TipoResponsabilidadAspecto | null;
  tipoImpacto?: TipoImpactoAspecto | null;
  fechaValoracion?: string | null;
  probabilidad: number;
  consecuencia: number;
  clasificacion: ClasificacionAspecto;
  ncar?: string | null;
  planAccionExistente?: string | null;
  planTratamiento?: string | null;
  responsableId?: string | null;
  presupuesto?: number | null;
  plazo?: string | null;
  estadoControl?: EstadoControlAspecto;
  seguimientoIndicador?: string | null;
  seguimientoResponsableId?: string | null;
  seguimientoFrecuenciaId?: string | null;
}

export type AspectoCambios = Partial<AspectoEntrada>;

/**
 * Matriz de aspectos e impactos ambientales. Cada fila se registra y se edita mientras está vigente; se le da seguimiento con registros fechados
 * (eficacia de los controles) y se da de baja con motivo (no se borra). Eventos `qhse.aspecto_ambiental.registrado|actualizado|
 * seguimiento_registrado|dado_de_baja` con la clasificación y el nivel de riesgo, para reportería y avisos.
 */
@Injectable()
export class AspectosAmbientalesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: EventBus,
    private readonly consulta: AspectosAmbientalesConsultaService,
  ) {}

  async crear(e: AspectoEntrada, actor: AuthUser) {
    const id = uuidv7();
    await this.prisma.$transaction(async (tx) => {
      const datos = await this.validar(tx, e);
      await tx.aspectoAmbiental.create({ data: { id, ...datos, createdBy: actor.id } });
      await this.publicar(tx, 'qhse.aspecto_ambiental.registrado', id, actor);
    });
    return this.consulta.detalle(id);
  }

  /** Cambia lo indicado (el resto queda como estaba) mientras el aspecto está vigente. */
  async editar(id: string, c: AspectoCambios, actor: AuthUser) {
    await this.vigente(id, async (tx) => {
      const a = await tx.aspectoAmbiental.findUniqueOrThrow({ where: { id } });
      const actual: AspectoEntrada = {
        fecha: aDia(a.fecha),
        etapaId: a.etapaId,
        procesoId: a.procesoId,
        actividad: a.actividad,
        produccionDelAspecto: a.produccionDelAspecto,
        riesgoGestion: a.riesgoGestion,
        aspecto: a.aspecto,
        impacto: a.impacto,
        factorId: a.factorId,
        condicionOperacion: a.condicionOperacion,
        tipoResponsabilidad: a.tipoResponsabilidad,
        tipoImpacto: a.tipoImpacto,
        fechaValoracion: a.fechaValoracion ? aDia(a.fechaValoracion) : null,
        probabilidad: a.probabilidad,
        consecuencia: a.consecuencia,
        clasificacion: a.clasificacion,
        ncar: a.ncar,
        planAccionExistente: a.planAccionExistente,
        planTratamiento: a.planTratamiento,
        responsableId: a.responsableId,
        presupuesto: a.presupuesto === null ? null : Number(a.presupuesto),
        plazo: a.plazo ? aDia(a.plazo) : null,
        estadoControl: a.estadoControl,
        seguimientoIndicador: a.seguimientoIndicador,
        seguimientoResponsableId: a.seguimientoResponsableId,
        seguimientoFrecuenciaId: a.seguimientoFrecuenciaId,
      };
      // los campos que no se enviaron llegan como `undefined` y no deben pisar los valores actuales
      const enviados = Object.fromEntries(Object.entries(c).filter(([, v]) => v !== undefined));
      const datos = await this.validar(tx, { ...actual, ...enviados });
      await tx.aspectoAmbiental.update({ where: { id }, data: { ...datos, updatedBy: actor.id } });
      await this.publicar(tx, 'qhse.aspecto_ambiental.actualizado', id, actor);
    });
    return this.consulta.detalle(id);
  }

  /** Registro de seguimiento: si los controles fueron eficaces y la observación. No se reescribe. */
  async registrarSeguimiento(
    id: string,
    s: { fecha?: string | null; eficaz: boolean; observacion: string },
    actor: AuthUser,
  ) {
    const observacion = texto(s.observacion);
    if (!observacion) throw new BadRequestException('Escriba la observación del seguimiento');
    const fecha = s.fecha ?? hoyEcuador();
    if (fecha > hoyEcuador())
      throw new BadRequestException('La fecha del seguimiento no puede ser futura');
    await this.vigente(id, async (tx) => {
      await tx.aspectoAmbientalSeguimiento.create({
        data: {
          id: uuidv7(),
          aspectoId: id,
          fecha: aFecha(fecha),
          eficaz: s.eficaz,
          observacion,
          createdBy: actor.id,
        },
      });
      await this.publicar(tx, 'qhse.aspecto_ambiental.seguimiento_registrado', id, actor, {
        eficaz: s.eficaz,
      });
    });
    return this.consulta.detalle(id);
  }

  /** Da de baja el aspecto con su motivo (no se borra). Queda congelado. */
  async darDeBaja(id: string, motivo: string, actor: AuthUser) {
    const m = texto(motivo);
    if (!m) throw new BadRequestException('Indique el motivo de la baja');
    await this.vigente(id, async (tx) => {
      const cambio = await tx.aspectoAmbiental.updateMany({
        where: { id, estado: EstadoAspecto.vigente },
        data: {
          estado: EstadoAspecto.dado_de_baja,
          bajaAt: new Date(),
          bajaPor: actor.id,
          bajaMotivo: m,
          updatedBy: actor.id,
        },
      });
      if (cambio.count !== 1)
        throw new ConflictException('El aspecto cambió; recargue e intente de nuevo');
      await this.publicar(tx, 'qhse.aspecto_ambiental.dado_de_baja', id, actor);
    });
    return this.consulta.detalle(id);
  }

  /** Agrega una etapa del ciclo de vida al catálogo (QHSE lo ajusta a su matriz). */
  async crearEtapa(nombre: string, actor: AuthUser) {
    return this.crearEnCatalogo('etapa', nombre, actor);
  }

  /** Agrega un factor ambiental al catálogo. */
  async crearFactor(nombre: string, actor: AuthUser) {
    return this.crearEnCatalogo('factor', nombre, actor);
  }

  // ------------------------------------------------------------------------------------------------------- internos

  /** Valida la fila completa y la deja lista para guardar. Lanza un 400 con el motivo si algo no corresponde. */
  private async validar(tx: Tx, e: AspectoEntrada) {
    const actividad = texto(e.actividad);
    const aspecto = texto(e.aspecto);
    const impacto = texto(e.impacto);
    if (!actividad || !aspecto || !impacto)
      throw new BadRequestException('Indique la actividad, el aspecto y el impacto ambiental');
    const fecha = e.fecha ?? hoyEcuador();
    if (fecha > hoyEcuador()) throw new BadRequestException('La fecha no puede ser futura');
    if (e.fechaValoracion && e.fechaValoracion > hoyEcuador())
      throw new BadRequestException('La fecha de valoración no puede ser futura');
    for (const [nombre, v] of [
      ['probabilidad', e.probabilidad],
      ['consecuencia', e.consecuencia],
    ] as const)
      if (!Number.isInteger(v) || v < 1 || v > 5)
        throw new BadRequestException(`La ${nombre} va de 1 a 5`);
    if (e.presupuesto !== null && e.presupuesto !== undefined && e.presupuesto < 0)
      throw new BadRequestException('El presupuesto no puede ser negativo');
    if (!(await tx.aspectoEtapaCicloVida.count({ where: { id: e.etapaId, activo: true } })))
      throw new BadRequestException('La etapa del ciclo de vida no existe');
    if (!(await tx.ipercProceso.count({ where: { id: e.procesoId, activo: true } })))
      throw new BadRequestException('El proceso no existe');
    if (
      e.factorId &&
      !(await tx.aspectoFactorAmbiental.count({ where: { id: e.factorId, activo: true } }))
    )
      throw new BadRequestException('El factor ambiental no existe');
    if (
      e.seguimientoFrecuenciaId &&
      !(await tx.frecuenciaSeguimiento.count({
        where: { id: e.seguimientoFrecuenciaId, activo: true },
      }))
    )
      throw new BadRequestException('La frecuencia de seguimiento no existe');
    const responsables = [
      ...new Set([e.responsableId, e.seguimientoResponsableId].filter((x): x is string => !!x)),
    ];
    if (
      (await tx.idUsuario.count({ where: { id: { in: responsables }, activo: true } })) !==
      responsables.length
    )
      throw new BadRequestException('Un responsable no existe o está inactivo');
    return {
      fecha: aFecha(fecha),
      etapaId: e.etapaId,
      procesoId: e.procesoId,
      actividad,
      produccionDelAspecto: texto(e.produccionDelAspecto),
      riesgoGestion: texto(e.riesgoGestion),
      aspecto,
      impacto,
      factorId: e.factorId ?? null,
      condicionOperacion: e.condicionOperacion ?? null,
      tipoResponsabilidad: e.tipoResponsabilidad ?? null,
      tipoImpacto: e.tipoImpacto ?? null,
      fechaValoracion: e.fechaValoracion ? aFecha(e.fechaValoracion) : null,
      probabilidad: e.probabilidad,
      consecuencia: e.consecuencia,
      clasificacion: e.clasificacion,
      ncar: texto(e.ncar),
      planAccionExistente: texto(e.planAccionExistente),
      planTratamiento: texto(e.planTratamiento),
      responsableId: e.responsableId ?? null,
      presupuesto: e.presupuesto ?? null,
      plazo: e.plazo ? aFecha(e.plazo) : null,
      estadoControl: e.estadoControl ?? EstadoControlAspecto.pendiente,
      seguimientoIndicador: texto(e.seguimientoIndicador),
      seguimientoResponsableId: e.seguimientoResponsableId ?? null,
      seguimientoFrecuenciaId: e.seguimientoFrecuenciaId ?? null,
    };
  }

  /** Corre el cambio solo si el aspecto existe y sigue vigente. */
  private async vigente(id: string, cambio: (tx: Tx) => Promise<void>): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const a = await tx.aspectoAmbiental.findUnique({ where: { id }, select: { estado: true } });
      if (!a) throw new NotFoundException('El aspecto ambiental no existe');
      if (a.estado !== EstadoAspecto.vigente)
        throw new ConflictException('El aspecto ambiental está dado de baja y no admite cambios');
      await cambio(tx);
    });
  }

  private async crearEnCatalogo(cual: 'etapa' | 'factor', nombre: string, actor: AuthUser) {
    const n = texto(nombre);
    if (!n) throw new BadRequestException('Indique el nombre');
    // código estable: el nombre en minúsculas, sin acentos ni signos
    const codigo = n
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 60);
    if (!codigo) throw new BadRequestException('El nombre debe llevar letras o números');
    try {
      return await this.prisma.$transaction(async (tx) => {
        if (cual === 'etapa') {
          const max = await tx.aspectoEtapaCicloVida.aggregate({ _max: { orden: true } });
          return tx.aspectoEtapaCicloVida.create({
            data: {
              id: uuidv7(),
              codigo,
              nombre: n,
              orden: (max._max.orden ?? 0) + 1,
              createdBy: actor.id,
            },
            select: { id: true, codigo: true, nombre: true },
          });
        }
        const max = await tx.aspectoFactorAmbiental.aggregate({ _max: { orden: true } });
        return tx.aspectoFactorAmbiental.create({
          data: {
            id: uuidv7(),
            codigo,
            nombre: n,
            orden: (max._max.orden ?? 0) + 1,
            createdBy: actor.id,
          },
          select: { id: true, codigo: true, nombre: true },
        });
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')
        throw new ConflictException(`Ya existe «${n}» en el catálogo`);
      throw err;
    }
  }

  private async publicar(
    tx: Tx,
    tipo: string,
    id: string,
    actor: AuthUser,
    extra: Record<string, unknown> = {},
  ) {
    const a = await tx.aspectoAmbiental.findUniqueOrThrow({ where: { id } });
    await this.bus.publish(
      tx,
      this.bus.create({
        type: tipo,
        subject: { type: 'aspecto_ambiental', id },
        data: {
          aspectoId: id,
          numero: a.numero,
          codigo: codigoAspecto(a.numero),
          estado: a.estado,
          procesoId: a.procesoId,
          clasificacion: a.clasificacion,
          nivelRiesgo: nivelRiesgoAspecto(a.probabilidad, a.consecuencia),
          estadoControl: a.estadoControl,
          plazo: a.plazo ? aDia(a.plazo) : null,
          ...extra,
        },
        actor: enActor(actor),
        traceparent: currentTraceparent(),
      }),
    );
  }
}
