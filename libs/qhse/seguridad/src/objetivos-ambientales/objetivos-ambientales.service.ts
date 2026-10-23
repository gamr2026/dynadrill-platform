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
import { EstadoObjetivoAmbiental } from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  ObjetivosAmbientalesConsultaService,
  codigoObjetivo,
} from './objetivos-ambientales-consulta.service';

const enActor = (a: AuthUser) => ({ userId: a.id, role: a.roleCode });

export interface AccionPlanEntrada {
  accionEspecifica: string;
  responsableId?: string | null;
  indicador?: string | null;
  evidenciaEsperada?: string | null;
  frecuenciaId?: string | null;
}

export interface ObjetivoEntrada {
  titulo: string;
  objetivo: string;
  meta: string;
  indicador: string;
  beneficioEmpresarial?: string | null;
  /** AAAA-MM-DD; opcional. */
  plazo?: string | null;
  planAccion?: AccionPlanEntrada[];
}

export type ObjetivoCambios = Partial<Omit<ObjetivoEntrada, 'planAccion'>>;

/**
 * Objetivos ambientales (OBJETIVOS AMBIENTALES.xlsx, revisión anual): se registran con su meta, indicador, plazo y plan de acción; se les da
 * seguimiento con registros fechados (que no se reescriben) y se cierran como cumplidos o no cumplidos. Eventos
 * `qhse.objetivo_ambiental.creado|seguimiento_registrado|cerrado`.
 */
@Injectable()
export class ObjetivosAmbientalesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: EventBus,
    private readonly consulta: ObjetivosAmbientalesConsultaService,
  ) {}

  async crear(e: ObjetivoEntrada, actor: AuthUser) {
    const base = this.textosObligatorios(e);
    if (e.plazo) this.exigirPlazoVigente(e.plazo);
    const id = uuidv7();
    await this.prisma.$transaction(async (tx) => {
      await tx.objetivoAmbiental.create({
        data: {
          id,
          ...base,
          beneficioEmpresarial: texto(e.beneficioEmpresarial),
          plazo: e.plazo ? aFecha(e.plazo) : null,
          createdBy: actor.id,
        },
      });
      await this.guardarAcciones(tx, id, e.planAccion ?? [], actor);
      await this.publicar(tx, 'qhse.objetivo_ambiental.creado', id, actor);
    });
    return this.consulta.detalle(id);
  }

  /** Cambia los datos del objetivo (mientras está en curso). */
  async editar(id: string, c: ObjetivoCambios, actor: AuthUser) {
    const data: Record<string, string | Date | null> = {};
    for (const campo of ['titulo', 'objetivo', 'meta', 'indicador'] as const) {
      if (c[campo] === undefined) continue;
      const v = texto(c[campo]);
      if (!v) throw new BadRequestException(`Complete el campo «${campo}»`);
      data[campo] = v;
    }
    if (c.beneficioEmpresarial !== undefined)
      data['beneficioEmpresarial'] = texto(c.beneficioEmpresarial);
    if (c.plazo !== undefined) {
      if (c.plazo) this.exigirPlazoVigente(c.plazo);
      data['plazo'] = c.plazo ? aFecha(c.plazo) : null;
    }
    await this.enCurso(id, async (tx) => {
      await tx.objetivoAmbiental.update({ where: { id }, data: { ...data, updatedBy: actor.id } });
    });
    return this.consulta.detalle(id);
  }

  /** Reemplaza el plan de acción completo (mientras el objetivo está en curso). */
  async guardarPlanAccion(id: string, acciones: AccionPlanEntrada[], actor: AuthUser) {
    await this.enCurso(id, async (tx) => {
      await tx.objetivoAmbientalAccion.deleteMany({ where: { objetivoId: id } });
      await this.guardarAcciones(tx, id, acciones, actor);
    });
    return this.consulta.detalle(id);
  }

  /** Agrega un registro de seguimiento (fecha, avance y observación). No se reescribe: un error se corrige con otro registro. */
  async registrarSeguimiento(
    id: string,
    s: { fecha?: string | null; avancePorcentaje: number; observacion: string },
    actor: AuthUser,
  ) {
    const observacion = texto(s.observacion);
    if (!observacion) throw new BadRequestException('Escriba la observación del seguimiento');
    const fecha = s.fecha ?? hoyEcuador();
    if (fecha > hoyEcuador())
      throw new BadRequestException('La fecha del seguimiento no puede ser futura');
    await this.enCurso(id, async (tx) => {
      await tx.objetivoAmbientalSeguimiento.create({
        data: {
          id: uuidv7(),
          objetivoId: id,
          fecha: aFecha(fecha),
          avancePorcentaje: s.avancePorcentaje,
          observacion,
          createdBy: actor.id,
        },
      });
      await this.publicar(tx, 'qhse.objetivo_ambiental.seguimiento_registrado', id, actor, {
        avancePorcentaje: s.avancePorcentaje,
      });
    });
    return this.consulta.detalle(id);
  }

  /** Cierra el objetivo como cumplido o no cumplido, con su resultado. Queda congelado. */
  async cerrar(
    id: string,
    c: { estado: EstadoObjetivoAmbiental; resultado: string; evidencia?: string | null },
    actor: AuthUser,
  ) {
    if (c.estado === EstadoObjetivoAmbiental.en_curso)
      throw new BadRequestException('Cierre el objetivo como cumplido o no cumplido');
    const resultado = texto(c.resultado);
    if (!resultado) throw new BadRequestException('Describa el resultado del objetivo');
    await this.enCurso(id, async (tx) => {
      const cambio = await tx.objetivoAmbiental.updateMany({
        where: { id, estado: EstadoObjetivoAmbiental.en_curso },
        data: {
          estado: c.estado,
          resultado,
          evidencia: texto(c.evidencia),
          cerradoAt: new Date(),
          cerradoPor: actor.id,
          updatedBy: actor.id,
        },
      });
      if (cambio.count !== 1)
        throw new ConflictException('El objetivo cambió; recargue e intente de nuevo');
      await this.publicar(tx, 'qhse.objetivo_ambiental.cerrado', id, actor);
    });
    return this.consulta.detalle(id);
  }

  // ------------------------------------------------------------------------------------------------------- internos

  private textosObligatorios(e: ObjetivoEntrada) {
    const titulo = texto(e.titulo);
    const objetivo = texto(e.objetivo);
    const meta = texto(e.meta);
    const indicador = texto(e.indicador);
    if (!titulo || !objetivo || !meta || !indicador)
      throw new BadRequestException('El objetivo necesita título, objetivo, meta e indicador');
    return { titulo, objetivo, meta, indicador };
  }

  private exigirPlazoVigente(plazo: string) {
    if (plazo < hoyEcuador())
      throw new BadRequestException('El plazo no puede ser una fecha pasada');
  }

  /** Corre el cambio solo si el objetivo existe y sigue en curso. */
  private async enCurso(id: string, cambio: (tx: Tx) => Promise<void>): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const o = await tx.objetivoAmbiental.findUnique({ where: { id }, select: { estado: true } });
      if (!o) throw new NotFoundException('El objetivo ambiental no existe');
      if (o.estado !== EstadoObjetivoAmbiental.en_curso)
        throw new ConflictException('El objetivo ya está cerrado y no admite cambios');
      await cambio(tx);
    });
  }

  private async guardarAcciones(
    tx: Tx,
    objetivoId: string,
    acciones: AccionPlanEntrada[],
    actor: AuthUser,
  ) {
    const filas = acciones.map((a, i) => ({
      orden: i + 1,
      accionEspecifica: texto(a.accionEspecifica),
      responsableId: a.responsableId ?? null,
      indicador: texto(a.indicador),
      evidenciaEsperada: texto(a.evidenciaEsperada),
      frecuenciaId: a.frecuenciaId ?? null,
    }));
    if (filas.some((f) => !f.accionEspecifica))
      throw new BadRequestException('Cada acción del plan lleva su descripción');
    const responsables = [
      ...new Set(filas.flatMap((f) => (f.responsableId ? [f.responsableId] : []))),
    ];
    if (
      (await tx.idUsuario.count({ where: { id: { in: responsables }, activo: true } })) !==
      responsables.length
    )
      throw new BadRequestException('Un responsable del plan no existe o está inactivo');
    const frecuencias = [
      ...new Set(filas.flatMap((f) => (f.frecuenciaId ? [f.frecuenciaId] : []))),
    ];
    if (
      (await tx.frecuenciaSeguimiento.count({
        where: { id: { in: frecuencias }, activo: true },
      })) !== frecuencias.length
    )
      throw new BadRequestException('Una frecuencia del plan no existe');
    await tx.objetivoAmbientalAccion.createMany({
      data: filas.map((f) => ({
        id: uuidv7(),
        objetivoId,
        orden: f.orden,
        accionEspecifica: f.accionEspecifica as string,
        responsableId: f.responsableId,
        indicador: f.indicador,
        evidenciaEsperada: f.evidenciaEsperada,
        frecuenciaId: f.frecuenciaId,
        createdBy: actor.id,
      })),
    });
  }

  private async publicar(
    tx: Tx,
    tipo: string,
    id: string,
    actor: AuthUser,
    extra: Record<string, unknown> = {},
  ) {
    const o = await tx.objetivoAmbiental.findUniqueOrThrow({ where: { id } });
    await this.bus.publish(
      tx,
      this.bus.create({
        type: tipo,
        subject: { type: 'objetivo_ambiental', id },
        data: {
          objetivoId: id,
          numero: o.numero,
          codigo: codigoObjetivo(o.numero),
          titulo: o.titulo,
          estado: o.estado,
          plazo: o.plazo ? o.plazo.toISOString().slice(0, 10) : null,
          ...extra,
        },
        actor: enActor(actor),
        traceparent: currentTraceparent(),
      }),
    );
  }
}
