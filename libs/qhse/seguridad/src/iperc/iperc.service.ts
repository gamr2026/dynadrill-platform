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
import { EstadoIperc } from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';
import type { ContenidoMatrizDto } from './iperc.dto';
import { insertarContenido } from './iperc-contenido';
import { IpercConsultaService, codigoIperc } from './iperc-consulta.service';

const MODULO_ARCHIVO_IPERC = 'qhse_iperc_documento';
const EDITABLES: EstadoIperc[] = [EstadoIperc.borrador, EstadoIperc.en_evaluacion];
const enActor = (a: AuthUser) => ({ userId: a.id, role: a.roleCode });

/** Hoy en Ecuador (AAAA-MM-DD): la vigencia se cuenta por día de calendario local. */
export const hoyEcuador = (): string =>
  new Date().toLocaleDateString('en-CA', { timeZone: 'America/Guayaquil' });

/** Un año después, igual que `fecha + INTERVAL '1 year'` en PostgreSQL (el 29 de febrero pasa al 28). */
export function masUnAnio(dia: string): string {
  const [a, m, d] = dia.split('-').map(Number);
  const f = new Date(Date.UTC(a + 1, m - 1, d));
  if (f.getUTCMonth() !== m - 1) f.setUTCDate(0);
  return f.toISOString().slice(0, 10);
}

const aFecha = (dia: string): Date => new Date(`${dia}T00:00:00.000Z`);

/**
 * Matriz IPERC maestra (DYN-SGI-RE-087, GTC 45). Ciclo de una versión: borrador → en evaluación → en revisión → aprobada (o rechazada, que
 * se retoma). Aprobarla exige el procedimiento y el ATS base adjuntos y le da 12 meses de vigencia; editar una aprobada crea una versión
 * nueva que debe aprobarse otra vez mientras sigue valiendo la anterior (al aprobarse la nueva, la anterior queda reemplazada). Las
 * reglas las garantiza además la base (trigger `iperc_matriz_validar` y los de contenido).
 */
@Injectable()
export class IpercService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: EventBus,
    private readonly consulta: IpercConsultaService,
  ) {}

  /** Una actividad nueva de la matriz maestra, con su primera versión en borrador. */
  async crearActividad(
    entrada: { procesoId: string; zonaId: string; nombre: string },
    actor: AuthUser,
  ) {
    const nombre = texto(entrada.nombre);
    if (!nombre) throw new BadRequestException('Escriba el nombre de la actividad');
    const matrizId = uuidv7();
    await this.prisma.$transaction(async (tx) => {
      if (!(await tx.ipercProceso.count({ where: { id: entrada.procesoId, activo: true } })))
        throw new BadRequestException('El proceso no existe o está inactivo');
      if (!(await tx.ipercZona.count({ where: { id: entrada.zonaId, activo: true } })))
        throw new BadRequestException('La zona no existe o está inactiva');
      const ya = await tx.ipercActividad.findFirst({
        where: {
          procesoId: entrada.procesoId,
          zonaId: entrada.zonaId,
          nombre: { equals: nombre, mode: 'insensitive' },
        },
      });
      if (ya)
        throw new ConflictException(
          'Esa actividad ya existe en ese proceso y zona: abra su matriz',
        );
      const actividadId = uuidv7();
      await tx.ipercActividad.create({
        data: {
          id: actividadId,
          procesoId: entrada.procesoId,
          zonaId: entrada.zonaId,
          nombre,
          createdBy: actor.id,
        },
      });
      await tx.ipercMatriz.create({
        data: { id: matrizId, actividadId, version: 1, createdBy: actor.id },
      });
      await this.historia(tx, matrizId, null, EstadoIperc.borrador, actor);
    });
    return this.consulta.matriz(matrizId);
  }

  /** Guarda todo el contenido (tareas, peligros, controles, cargos y equipo evaluador), reemplazando el anterior. */
  async guardarContenido(id: string, dto: ContenidoMatrizDto, actor: AuthUser) {
    await this.prisma.$transaction(async (tx) => {
      const m = await this.encontrar(tx, id);
      if (!EDITABLES.includes(m.estado))
        throw new ConflictException(
          m.estado === EstadoIperc.aprobada || m.estado === EstadoIperc.reemplazada
            ? 'Una matriz aprobada no se edita: cree una versión nueva'
            : `La matriz está ${m.estado.replace('_', ' ')}; solo se edita en borrador o en evaluación`,
        );
      await this.validarReferencias(tx, dto);
      await tx.ipercTarea.deleteMany({ where: { matrizId: id } });
      await tx.ipercMatrizEvaluador.deleteMany({ where: { matrizId: id } });
      await insertarContenido(tx, id, dto.tareas);
      const evaluadores = [...new Set(dto.evaluadorIds ?? [])];
      if (evaluadores.length)
        await tx.ipercMatrizEvaluador.createMany({
          data: evaluadores.map((usuarioId) => ({ matrizId: id, usuarioId })),
        });
      await tx.ipercMatriz.update({ where: { id }, data: { updatedBy: actor.id } });
    });
    return this.consulta.matriz(id);
  }

  /** Empieza la evaluación (desde borrador) o la retoma (desde rechazada). */
  async iniciarEvaluacion(id: string, actor: AuthUser) {
    await this.prisma.$transaction(async (tx) => {
      const m = await this.encontrar(tx, id);
      if (m.estado !== EstadoIperc.borrador && m.estado !== EstadoIperc.rechazada)
        throw new ConflictException(
          'Solo se inicia la evaluación de una matriz en borrador o rechazada',
        );
      await tx.ipercMatriz.update({
        where: { id },
        data: {
          estado: EstadoIperc.en_evaluacion,
          rechazadaPor: null,
          rechazadaAt: null,
          motivoRechazo: null,
          updatedBy: actor.id,
        },
      });
      await this.historia(tx, id, m.estado, EstadoIperc.en_evaluacion, actor);
    });
    return this.consulta.matriz(id);
  }

  /** Adjunta el procedimiento o el ATS base (se exigen para aprobar). */
  async adjuntar(id: string, tipo: 'procedimiento' | 'ats', archivoId: string, actor: AuthUser) {
    await this.prisma.$transaction(async (tx) => {
      const m = await this.encontrar(tx, id);
      if (m.estado !== EstadoIperc.en_evaluacion && m.estado !== EstadoIperc.en_revision)
        throw new ConflictException(
          'Los adjuntos se cargan con la matriz en evaluación o en revisión',
        );
      const a = await tx.archivoRef.findUnique({
        where: { id: archivoId },
        select: { eliminadoAt: true, modulo: { select: { codigo: true } } },
      });
      if (!a || a.eliminadoAt) throw new BadRequestException('El archivo no existe');
      if (a.modulo.codigo !== MODULO_ARCHIVO_IPERC)
        throw new BadRequestException(
          'El archivo no se subió como documento de la matriz IPERC: súbalo de nuevo desde esta pantalla',
        );
      await tx.ipercMatriz.update({
        where: { id },
        data: {
          ...(tipo === 'procedimiento'
            ? { procedimientoArchivoId: archivoId }
            : { atsArchivoId: archivoId }),
          updatedBy: actor.id,
        },
      });
    });
    return this.consulta.matriz(id);
  }

  /** Envía a revisión: la valoración (inicial y residual) debe estar completa en todos los peligros. */
  async enviarARevision(id: string, actor: AuthUser) {
    await this.prisma.$transaction(async (tx) => {
      const m = await this.encontrar(tx, id);
      if (m.estado !== EstadoIperc.en_evaluacion)
        throw new ConflictException('Solo se envía a revisión una matriz en evaluación');
      const problemas = await this.pendientesDeEvaluacion(tx, id);
      if (problemas.length)
        throw new ConflictException(`No se puede enviar a revisión: ${problemas.join('; ')}`);
      await tx.ipercMatriz.update({
        where: { id },
        data: { estado: EstadoIperc.en_revision, updatedBy: actor.id },
      });
      await this.historia(tx, id, EstadoIperc.en_evaluacion, EstadoIperc.en_revision, actor);
    });
    return this.consulta.matriz(id);
  }

  /** Aprueba (Gerente HSE): da 12 meses de vigencia y deja reemplazada a la versión aprobada anterior de la misma actividad. */
  async aprobar(id: string, actor: AuthUser) {
    await this.prisma.$transaction(async (tx) => {
      const m = await this.encontrar(tx, id);
      if (m.estado !== EstadoIperc.en_revision)
        throw new ConflictException('Solo se aprueba una matriz en revisión');
      const faltan = [
        ...(m.procedimientoArchivoId ? [] : ['el procedimiento']),
        ...(m.atsArchivoId ? [] : ['el ATS base']),
      ];
      if (faltan.length) throw new ConflictException(`Para aprobar adjunte ${faltan.join(' y ')}`);
      // la versión aprobada anterior pasa a reemplazada en la misma transacción (solo puede haber una aprobada por actividad)
      await tx.ipercMatriz.updateMany({
        where: { actividadId: m.actividadId, estado: EstadoIperc.aprobada },
        data: { estado: EstadoIperc.reemplazada, reemplazadaAt: new Date(), updatedBy: actor.id },
      });
      const hoy = hoyEcuador();
      await tx.ipercMatriz.update({
        where: { id },
        data: {
          estado: EstadoIperc.aprobada,
          aprobadaPor: actor.id,
          aprobadaAt: new Date(),
          aprobadaEl: aFecha(hoy),
          vigenteHasta: aFecha(masUnAnio(hoy)),
          updatedBy: actor.id,
        },
      });
      await this.historia(tx, id, EstadoIperc.en_revision, EstadoIperc.aprobada, actor);
      await this.publicar(tx, 'qhse.iperc.aprobada', id, actor);
    });
    return this.consulta.matriz(id);
  }

  async rechazar(id: string, motivo: string, actor: AuthUser) {
    const m = texto(motivo);
    if (!m) throw new BadRequestException('Indique el motivo del rechazo');
    await this.prisma.$transaction(async (tx) => {
      const actual = await this.encontrar(tx, id);
      if (actual.estado !== EstadoIperc.en_revision)
        throw new ConflictException('Solo se rechaza una matriz en revisión');
      await tx.ipercMatriz.update({
        where: { id },
        data: {
          estado: EstadoIperc.rechazada,
          rechazadaPor: actor.id,
          rechazadaAt: new Date(),
          motivoRechazo: m,
          updatedBy: actor.id,
        },
      });
      await this.historia(tx, id, EstadoIperc.en_revision, EstadoIperc.rechazada, actor, m);
      await this.publicar(tx, 'qhse.iperc.rechazada', id, actor, m);
    });
    return this.consulta.matriz(id);
  }

  /** Revisión anual (o cambio): una versión nueva en borrador copiada de la aprobada; la aprobada sigue valiendo mientras tanto. */
  async nuevaVersion(actividadId: string, actor: AuthUser) {
    const nuevaId = uuidv7();
    await this.prisma.$transaction(async (tx) => {
      const versiones = await tx.ipercMatriz.findMany({
        where: { actividadId },
        orderBy: { version: 'desc' },
      });
      if (!versiones.length) throw new NotFoundException('La actividad no existe');
      const enTrabajo = versiones.find((v) =>
        (['borrador', 'en_evaluacion', 'en_revision', 'rechazada'] as EstadoIperc[]).includes(
          v.estado,
        ),
      );
      if (enTrabajo)
        throw new ConflictException(
          `La actividad ya tiene una versión en trabajo (versión ${enTrabajo.version}, ${enTrabajo.estado.replace('_', ' ')})`,
        );
      const base = versiones.find((v) => v.estado === EstadoIperc.aprobada);
      if (!base)
        throw new ConflictException('La actividad no tiene una matriz aprobada de la que partir');
      await tx.ipercMatriz.create({
        data: { id: nuevaId, actividadId, version: versiones[0].version + 1, createdBy: actor.id },
      });
      await this.historia(
        tx,
        nuevaId,
        null,
        EstadoIperc.borrador,
        actor,
        `Revisión de la versión ${base.version}`,
      );
      await this.copiarContenido(tx, base.id, nuevaId);
    });
    return this.consulta.matriz(nuevaId);
  }

  // ------------------------------------------------------------------------------------------------------- internos

  private async encontrar(tx: Tx, id: string) {
    const m = await tx.ipercMatriz.findUnique({ where: { id } });
    if (!m) throw new NotFoundException('La matriz no existe');
    return m;
  }

  private async historia(
    tx: Tx,
    matrizId: string,
    anterior: EstadoIperc | null,
    nuevo: EstadoIperc,
    actor: AuthUser,
    motivo?: string,
  ) {
    await tx.ipercHistorial.create({
      data: {
        id: uuidv7(),
        matrizId,
        estadoAnterior: anterior,
        estadoNuevo: nuevo,
        actorId: actor.id,
        motivo: motivo ?? null,
      },
    });
  }

  /** Lo que falta para enviar a revisión, en frases claras (la base lo exige igual). */
  private async pendientesDeEvaluacion(tx: Tx, id: string): Promise<string[]> {
    const tareas = await tx.ipercTarea.findMany({
      where: { matrizId: id },
      orderBy: { orden: 'asc' },
      include: { peligros: true },
    });
    if (!tareas.length) return ['la matriz no tiene tareas'];
    const out: string[] = [];
    for (const t of tareas) {
      if (!t.peligros.length)
        out.push(`la tarea «${t.descripcion}» no tiene peligros identificados`);
      const sin = t.peligros.filter((p) => p.inicialNd === null || p.residualNd === null).length;
      if (sin)
        out.push(
          `en la tarea «${t.descripcion}» faltan la valoración inicial o la residual de ${sin} peligro(s)`,
        );
    }
    return out;
  }

  /** Las referencias a catálogos y personas deben existir (mensaje claro en lugar de un error de llave foránea). */
  private async validarReferencias(tx: Tx, dto: ContenidoMatrizDto): Promise<void> {
    const unicos = (xs: Array<string | undefined>) => [
      ...new Set(xs.filter((x): x is string => !!x)),
    ];
    const clasif = unicos(dto.tareas.flatMap((t) => t.peligros.map((p) => p.clasificacionId)));
    const generado = unicos(dto.tareas.flatMap((t) => t.peligros.map((p) => p.generadoEnId)));
    const cargos = unicos(dto.tareas.flatMap((t) => t.cargoIds ?? []));
    const evaluadores = unicos(dto.evaluadorIds ?? []);
    if (
      clasif.length &&
      (await tx.ipercClasificacionPeligro.count({ where: { id: { in: clasif } } })) !==
        clasif.length
    )
      throw new BadRequestException('Una clasificación de peligro no existe');
    if (
      generado.length &&
      (await tx.ipercGeneradoEn.count({ where: { id: { in: generado } } })) !== generado.length
    )
      throw new BadRequestException('Un valor de «generado en» no existe');
    if (
      cargos.length &&
      (await tx.ipercCargo.count({ where: { id: { in: cargos } } })) !== cargos.length
    )
      throw new BadRequestException('Un cargo expuesto no existe');
    if (
      evaluadores.length &&
      (await tx.idUsuario.count({ where: { id: { in: evaluadores } } })) !== evaluadores.length
    )
      throw new BadRequestException('Una persona del equipo evaluador no existe');
    for (const t of dto.tareas) {
      if (!texto(t.descripcion))
        throw new BadRequestException('Toda tarea necesita una descripción');
      for (const p of t.peligros)
        if (!texto(p.descripcion))
          throw new BadRequestException('Todo peligro necesita una descripción');
    }
  }

  /** Copia tareas, cargos, peligros, controles y equipo de una versión a otra (para la revisión anual). */
  private async copiarContenido(tx: Tx, origenId: string, destinoId: string): Promise<void> {
    const tareas = await tx.ipercTarea.findMany({
      where: { matrizId: origenId },
      orderBy: { orden: 'asc' },
      include: {
        cargos: true,
        peligros: { orderBy: { orden: 'asc' }, include: { controles: true } },
      },
    });
    for (const t of tareas) {
      const tareaId = uuidv7();
      await tx.ipercTarea.create({
        data: {
          id: tareaId,
          matrizId: destinoId,
          orden: t.orden,
          descripcion: t.descripcion,
          rutinaria: t.rutinaria,
          areaPuesto: t.areaPuesto,
        },
      });
      if (t.cargos.length)
        await tx.ipercTareaCargo.createMany({
          data: t.cargos.map((c) => ({ tareaId, cargoId: c.cargoId })),
        });
      for (const p of t.peligros) {
        const peligroId = uuidv7();
        const { id: _id, tareaId: _t, controles, ...resto } = p;
        void _id;
        void _t;
        await tx.ipercPeligro.create({ data: { ...resto, id: peligroId, tareaId } });
        if (controles.length)
          await tx.ipercControl.createMany({
            data: controles.map((c) => ({
              id: uuidv7(),
              peligroId,
              momento: c.momento,
              tipo: c.tipo,
              descripcion: c.descripcion,
            })),
          });
      }
    }
    const equipo = await tx.ipercMatrizEvaluador.findMany({ where: { matrizId: origenId } });
    if (equipo.length)
      await tx.ipercMatrizEvaluador.createMany({
        data: equipo.map((e) => ({ matrizId: destinoId, usuarioId: e.usuarioId })),
      });
  }

  private async publicar(tx: Tx, tipo: string, matrizId: string, actor: AuthUser, motivo?: string) {
    const m = await tx.ipercMatriz.findUniqueOrThrow({
      where: { id: matrizId },
      include: { actividad: { select: { id: true, nombre: true } } },
    });
    await this.bus.publish(
      tx,
      this.bus.create({
        type: tipo,
        subject: { type: 'iperc_matriz', id: matrizId },
        data: {
          matrizId,
          numero: m.numero,
          codigo: codigoIperc(m.numero),
          actividadId: m.actividadId,
          // texto para el aviso (es el nombre de la actividad cuando se aprobó)
          actividad: m.actividad.nombre,
          version: m.version,
          estado: m.estado,
          ...(m.vigenteHasta ? { vigenteHasta: m.vigenteHasta.toISOString().slice(0, 10) } : {}),
          ...(motivo ? { motivo } : {}),
        },
        actor: enActor(actor),
        traceparent: currentTraceparent(),
      }),
    );
  }
}
