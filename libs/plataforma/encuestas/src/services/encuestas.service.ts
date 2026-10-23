import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AuthUser } from '@dyn/common';
import { uuidv7 } from '@dyn/utils';
import { EstadoVersion, TipoRespuesta } from '../generated/client';
import type { Prisma } from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';

export interface PreguntaEntrada {
  texto: string;
  tipo: TipoRespuesta;
  obligatoria: boolean;
  /** Obligatoria en las preguntas de escala; no va en las demás. */
  escalaId?: string;
  /** Etiquetas de las opciones (al menos dos) en las preguntas de opción única o múltiple; no van en las demás. */
  opciones?: string[];
}

const TIPOS_CON_OPCIONES: TipoRespuesta[] = [
  TipoRespuesta.opcion_unica,
  TipoRespuesta.opcion_multiple,
];

const DETALLE_VERSION = {
  encuesta: { select: { id: true, codigo: true, nombre: true, moduloCodigo: true } },
  preguntas: {
    orderBy: { orden: 'asc' },
    include: {
      opciones: { orderBy: { orden: 'asc' } },
      escala: { include: { valores: { orderBy: { valor: 'asc' } } } },
    },
  },
} satisfies Prisma.EncuestaVersionInclude;

/**
 * Administración de las encuestas (solo Superadmin): plantillas por módulo, versiones con sus preguntas y tipos de respuesta.
 * Una versión publicada no se edita: se crea un borrador a partir de ella, se corrige y se publica; la anterior queda archivada y
 * conserva lo que ya se envió y respondió con ella.
 */
@Injectable()
export class EncuestasService {
  constructor(private readonly prisma: PrismaService) {}

  /** Módulos del sistema que pueden tener encuestas. */
  modulos() {
    return this.prisma.moduloEncuesta.findMany({
      where: { activo: true },
      select: { codigo: true, nombre: true },
      orderBy: { nombre: 'asc' },
    });
  }

  /** Escalas de calificación disponibles, con sus valores. */
  async escalas() {
    const filas = await this.prisma.escala.findMany({
      orderBy: { nombre: 'asc' },
      include: { valores: { orderBy: { valor: 'asc' } } },
    });
    return filas.map((e) => ({
      id: e.id,
      codigo: e.codigo,
      nombre: e.nombre,
      valores: e.valores.map((v) => ({ valor: v.valor, etiqueta: v.etiqueta })),
    }));
  }

  async listar(moduloCodigo?: string) {
    const filas = await this.prisma.encuesta.findMany({
      where: moduloCodigo ? { moduloCodigo } : {},
      orderBy: [{ moduloCodigo: 'asc' }, { nombre: 'asc' }],
      include: {
        modulo: { select: { nombre: true } },
        versiones: {
          where: { estado: { in: [EstadoVersion.publicada, EstadoVersion.borrador] } },
          select: { id: true, numero: true, estado: true, titulo: true, publicadaAt: true },
        },
      },
    });
    return filas.map((e) => {
      const vigente = e.versiones.find((v) => v.estado === EstadoVersion.publicada);
      const borrador = e.versiones.find((v) => v.estado === EstadoVersion.borrador);
      return {
        id: e.id,
        codigo: e.codigo,
        nombre: e.nombre,
        activa: e.activa,
        moduloCodigo: e.moduloCodigo,
        moduloNombre: e.modulo.nombre,
        vigente: vigente
          ? {
              id: vigente.id,
              numero: vigente.numero,
              titulo: vigente.titulo,
              publicadaAt: vigente.publicadaAt,
            }
          : null,
        borrador: borrador ? { id: borrador.id, numero: borrador.numero } : null,
      };
    });
  }

  async obtener(id: string) {
    const e = await this.prisma.encuesta.findUnique({
      where: { id },
      include: {
        modulo: { select: { nombre: true } },
        versiones: {
          orderBy: { numero: 'desc' },
          include: { _count: { select: { preguntas: true, invitaciones: true } } },
        },
      },
    });
    if (!e) throw new NotFoundException('La encuesta no existe');
    return {
      id: e.id,
      codigo: e.codigo,
      nombre: e.nombre,
      activa: e.activa,
      moduloCodigo: e.moduloCodigo,
      moduloNombre: e.modulo.nombre,
      versiones: e.versiones.map((v) => ({
        id: v.id,
        numero: v.numero,
        estado: v.estado,
        titulo: v.titulo,
        publicadaAt: v.publicadaAt,
        preguntas: v._count.preguntas,
        invitaciones: v._count.invitaciones,
      })),
    };
  }

  /** Una versión con sus preguntas, opciones y escalas. */
  async version(versionId: string) {
    const v = await this.prisma.encuestaVersion.findUnique({
      where: { id: versionId },
      include: DETALLE_VERSION,
    });
    if (!v) throw new NotFoundException('La versión no existe');
    return this.aDetalle(v);
  }

  /** Crea la encuesta con su primer borrador (vacío: hay que agregarle preguntas para publicarla). */
  async crear(entrada: { codigo: string; nombre: string; moduloCodigo: string }, actor: AuthUser) {
    const modulo = await this.prisma.moduloEncuesta.findUnique({
      where: { codigo: entrada.moduloCodigo },
    });
    if (!modulo || !modulo.activo) throw new BadRequestException('El módulo indicado no existe');
    if (await this.prisma.encuesta.findUnique({ where: { codigo: entrada.codigo } })) {
      throw new ConflictException(`Ya existe una encuesta con el código «${entrada.codigo}»`);
    }
    const id = uuidv7();
    await this.prisma.$transaction(async (tx) => {
      await tx.encuesta.create({
        data: {
          id,
          codigo: entrada.codigo,
          nombre: entrada.nombre.trim(),
          moduloCodigo: entrada.moduloCodigo,
          createdBy: actor.id,
          updatedBy: actor.id,
        },
      });
      await tx.encuestaVersion.create({
        data: {
          id: uuidv7(),
          encuestaId: id,
          numero: 1,
          titulo: entrada.nombre.trim(),
          createdBy: actor.id,
          updatedBy: actor.id,
        },
      });
    });
    return this.obtener(id);
  }

  async actualizar(id: string, cambios: { nombre?: string; activa?: boolean }, actor: AuthUser) {
    await this.exigirEncuesta(id);
    await this.prisma.encuesta.update({
      where: { id },
      data: {
        ...(cambios.nombre !== undefined ? { nombre: cambios.nombre.trim() } : {}),
        ...(cambios.activa !== undefined ? { activa: cambios.activa } : {}),
        updatedBy: actor.id,
      },
    });
    return this.obtener(id);
  }

  /** Abre un borrador copiando la versión vigente (o la última archivada) para corregirla. */
  async crearBorrador(encuestaId: string, actor: AuthUser) {
    await this.exigirEncuesta(encuestaId);
    const versiones = await this.prisma.encuestaVersion.findMany({
      where: { encuestaId },
      orderBy: { numero: 'desc' },
      include: { preguntas: { orderBy: { orden: 'asc' }, include: { opciones: true } } },
    });
    if (versiones.some((v) => v.estado === EstadoVersion.borrador)) {
      throw new ConflictException('La encuesta ya tiene un borrador abierto: edítelo o publíquelo');
    }
    const base = versiones.find((v) => v.estado === EstadoVersion.publicada) ?? versiones[0];
    const versionId = uuidv7();
    await this.prisma.$transaction(async (tx) => {
      await tx.encuestaVersion.create({
        data: {
          id: versionId,
          encuestaId,
          numero: (versiones[0]?.numero ?? 0) + 1,
          titulo: base?.titulo ?? 'Encuesta',
          introduccion: base?.introduccion ?? null,
          createdBy: actor.id,
          updatedBy: actor.id,
        },
      });
      for (const p of base?.preguntas ?? []) await this.copiarPregunta(tx, versionId, p, actor);
    });
    return this.version(versionId);
  }

  /** Cambia el título y la introducción de un borrador. */
  async editarBorrador(
    versionId: string,
    cambios: { titulo?: string; introduccion?: string | null },
    actor: AuthUser,
  ) {
    await this.exigirBorrador(versionId);
    await this.prisma.encuestaVersion.update({
      where: { id: versionId },
      data: {
        ...(cambios.titulo !== undefined ? { titulo: cambios.titulo.trim() } : {}),
        ...(cambios.introduccion !== undefined
          ? { introduccion: cambios.introduccion?.trim() || null }
          : {}),
        updatedBy: actor.id,
      },
    });
    return this.version(versionId);
  }

  /** Reemplaza todas las preguntas de un borrador (el orden es el de la lista). */
  async reemplazarPreguntas(versionId: string, preguntas: PreguntaEntrada[], actor: AuthUser) {
    await this.exigirBorrador(versionId);
    const escalaIds = [...new Set(preguntas.flatMap((p) => (p.escalaId ? [p.escalaId] : [])))];
    const escalas = escalaIds.length
      ? await this.prisma.escala.findMany({
          where: { id: { in: escalaIds } },
          select: { id: true },
        })
      : [];
    const validas = new Set(escalas.map((e) => e.id));
    preguntas.forEach((p, i) => this.validarPregunta(p, i + 1, validas));
    await this.prisma.$transaction(async (tx) => {
      await tx.pregunta.deleteMany({ where: { versionId } });
      for (const [i, p] of preguntas.entries()) {
        const id = uuidv7();
        await tx.pregunta.create({
          data: {
            id,
            versionId,
            orden: i + 1,
            texto: p.texto.trim(),
            tipo: p.tipo,
            obligatoria: p.obligatoria,
            escalaId: p.tipo === TipoRespuesta.escala ? p.escalaId : null,
            createdBy: actor.id,
            updatedBy: actor.id,
          },
        });
        for (const [j, etiqueta] of (p.opciones ?? []).entries()) {
          await tx.preguntaOpcion.create({
            data: {
              id: uuidv7(),
              preguntaId: id,
              preguntaTipo: p.tipo,
              orden: j + 1,
              etiqueta: etiqueta.trim(),
              createdBy: actor.id,
              updatedBy: actor.id,
            },
          });
        }
      }
      await tx.encuestaVersion.update({ where: { id: versionId }, data: { updatedBy: actor.id } });
    });
    return this.version(versionId);
  }

  /** Publica el borrador y archiva la versión que estaba vigente. Desde ahí es lo que se envía. */
  async publicar(versionId: string, actor: AuthUser) {
    const v = await this.exigirBorrador(versionId);
    const e = await this.prisma.encuesta.findUniqueOrThrow({ where: { id: v.encuestaId } });
    if (!e.activa)
      throw new ConflictException('La encuesta está inactiva: actívela para publicarla');
    const preguntas = await this.prisma.pregunta.findMany({
      where: { versionId },
      include: { _count: { select: { opciones: true } } },
    });
    if (!preguntas.length) {
      throw new BadRequestException(
        'La encuesta no tiene preguntas: agregue al menos una para publicarla',
      );
    }
    const corta = preguntas.find(
      (p) => TIPOS_CON_OPCIONES.includes(p.tipo) && p._count.opciones < 2,
    );
    if (corta) {
      throw new BadRequestException(`La pregunta «${corta.texto}» necesita al menos dos opciones`);
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.encuestaVersion.updateMany({
        where: { encuestaId: v.encuestaId, estado: EstadoVersion.publicada },
        data: { estado: EstadoVersion.archivada, updatedBy: actor.id },
      });
      await tx.encuestaVersion.update({
        where: { id: versionId },
        data: {
          estado: EstadoVersion.publicada,
          publicadaAt: new Date(),
          publicadaBy: actor.id,
          updatedBy: actor.id,
        },
      });
    });
    return this.version(versionId);
  }

  private validarPregunta(p: PreguntaEntrada, n: number, escalasValidas: Set<string>): void {
    const donde = `La pregunta ${n}`;
    if (p.tipo === TipoRespuesta.escala) {
      if (!p.escalaId || !escalasValidas.has(p.escalaId)) {
        throw new BadRequestException(`${donde} es de escala: elija una escala que exista`);
      }
    } else if (p.escalaId) {
      throw new BadRequestException(`${donde} no es de escala: no lleva escala`);
    }
    const opciones = (p.opciones ?? []).map((o) => o.trim());
    if (TIPOS_CON_OPCIONES.includes(p.tipo)) {
      if (opciones.length < 2)
        throw new BadRequestException(`${donde} necesita al menos dos opciones`);
      if (opciones.some((o) => !o))
        throw new BadRequestException(`${donde} tiene una opción vacía`);
      if (new Set(opciones.map((o) => o.toLowerCase())).size !== opciones.length) {
        throw new BadRequestException(`${donde} tiene opciones repetidas`);
      }
    } else if (opciones.length) {
      throw new BadRequestException(`${donde} no es de opciones: no lleva opciones`);
    }
  }

  private async copiarPregunta(
    tx: Prisma.TransactionClient,
    versionId: string,
    p: Prisma.PreguntaGetPayload<{ include: { opciones: true } }>,
    actor: AuthUser,
  ) {
    const id = uuidv7();
    await tx.pregunta.create({
      data: {
        id,
        versionId,
        orden: p.orden,
        texto: p.texto,
        tipo: p.tipo,
        obligatoria: p.obligatoria,
        escalaId: p.escalaId,
        createdBy: actor.id,
        updatedBy: actor.id,
      },
    });
    for (const o of p.opciones) {
      await tx.preguntaOpcion.create({
        data: {
          id: uuidv7(),
          preguntaId: id,
          preguntaTipo: o.preguntaTipo,
          orden: o.orden,
          etiqueta: o.etiqueta,
          createdBy: actor.id,
          updatedBy: actor.id,
        },
      });
    }
  }

  private async exigirEncuesta(id: string) {
    const e = await this.prisma.encuesta.findUnique({ where: { id }, select: { id: true } });
    if (!e) throw new NotFoundException('La encuesta no existe');
  }

  private async exigirBorrador(versionId: string) {
    const v = await this.prisma.encuestaVersion.findUnique({ where: { id: versionId } });
    if (!v) throw new NotFoundException('La versión no existe');
    if (v.estado !== EstadoVersion.borrador) {
      throw new ConflictException(
        'Una versión publicada no se modifica: abra un borrador a partir de ella para corregirla',
      );
    }
    return v;
  }

  private aDetalle(v: Prisma.EncuestaVersionGetPayload<{ include: typeof DETALLE_VERSION }>) {
    return {
      id: v.id,
      numero: v.numero,
      estado: v.estado,
      titulo: v.titulo,
      introduccion: v.introduccion,
      publicadaAt: v.publicadaAt,
      encuesta: v.encuesta,
      preguntas: v.preguntas.map((p) => ({
        id: p.id,
        orden: p.orden,
        texto: p.texto,
        tipo: p.tipo,
        obligatoria: p.obligatoria,
        escala: p.escala
          ? {
              id: p.escala.id,
              codigo: p.escala.codigo,
              nombre: p.escala.nombre,
              valores: p.escala.valores.map((x) => ({ valor: x.valor, etiqueta: x.etiqueta })),
            }
          : null,
        opciones: p.opciones.map((o) => ({ id: o.id, orden: o.orden, etiqueta: o.etiqueta })),
      })),
    };
  }
}
