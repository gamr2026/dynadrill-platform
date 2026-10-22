import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { uuidv7 } from '@dyn/utils';
import { EstadoVersion } from '../generated/client';
import type { Prisma } from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';
import { nuevoToken } from './token';

/** El enlace de una encuesta vale un día. */
export const VIGENCIA_HORAS = 24;

const CORREO = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export type EstadoInvitacion = 'pendiente' | 'respondida' | 'vencida';

export interface FiltroInvitaciones {
  encuestaId?: string;
  moduloCodigo?: string;
  referenciaId?: string;
  estado?: EstadoInvitacion;
  limite?: number;
  desplazamiento?: number;
}

const estadoDe = (i: { venceAt: Date; respuesta: unknown }): EstadoInvitacion =>
  i.respuesta ? 'respondida' : i.venceAt.getTime() <= Date.now() ? 'vencida' : 'pendiente';

/**
 * Envío de encuestas: crea la invitación (enlace de un solo uso con vigencia de un día) con la versión vigente de la encuesta, y la
 * consulta para la administración. El token en claro solo se devuelve al crearla, para el correo; la base guarda su hash.
 */
@Injectable()
export class InvitacionesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Crea la invitación de una encuesta (por su código) para lo que se evalúa en otro contenedor (`referenciaId`, p. ej. el ticket de FCR).
   * `actorId` es quien la pide; nulo si la crea el sistema al recibir un evento.
   */
  async crear(
    entrada: {
      encuestaCodigo: string;
      referenciaId: string;
      correoDestino: string;
      actorId?: string | null;
    },
    /** Dentro de la transacción de quien llama (p. ej. el consumidor de un evento); por defecto, la conexión del módulo. */
    db: Pick<Prisma.TransactionClient, 'encuesta' | 'invitacion'> = this.prisma,
  ) {
    const correo = entrada.correoDestino.trim().toLowerCase();
    if (!CORREO.test(correo)) throw new BadRequestException('El correo indicado no es válido');
    const encuesta = await db.encuesta.findUnique({
      where: { codigo: entrada.encuestaCodigo },
      include: { versiones: { where: { estado: EstadoVersion.publicada } } },
    });
    if (!encuesta) throw new NotFoundException('La encuesta no existe');
    if (!encuesta.activa) throw new ConflictException('La encuesta está inactiva');
    const version = encuesta.versiones[0];
    if (!version) throw new ConflictException('La encuesta no tiene una versión publicada');

    const { token, hash } = nuevoToken();
    const id = uuidv7();
    const venceAt = new Date(Date.now() + VIGENCIA_HORAS * 3_600_000);
    await db.invitacion.create({
      data: {
        id,
        versionId: version.id,
        moduloCodigo: encuesta.moduloCodigo,
        referenciaId: entrada.referenciaId,
        tokenHash: hash,
        correoDestino: correo,
        venceAt,
        createdBy: entrada.actorId ?? null,
      },
    });
    return {
      id,
      token,
      venceAt,
      correoDestino: correo,
      moduloCodigo: encuesta.moduloCodigo,
      titulo: version.titulo,
    };
  }

  /** Deja anotado que el correo salió (y borra un error anterior). */
  async marcarEnviada(id: string): Promise<void> {
    await this.prisma.invitacion.update({
      where: { id },
      data: { enviadaAt: new Date(), envioError: null },
    });
  }

  /** Deja anotado por qué no salió el correo, para que la administración lo vea. */
  async marcarError(id: string, error: string): Promise<void> {
    await this.prisma.invitacion.update({
      where: { id },
      data: { enviadaAt: null, envioError: error.slice(0, 500) },
    });
  }

  async listar(f: FiltroInvitaciones) {
    const ahora = new Date();
    const where: Prisma.InvitacionWhereInput = {
      ...(f.moduloCodigo ? { moduloCodigo: f.moduloCodigo } : {}),
      ...(f.referenciaId ? { referenciaId: f.referenciaId } : {}),
      ...(f.encuestaId ? { version: { encuestaId: f.encuestaId } } : {}),
      ...(f.estado === 'respondida' ? { respuesta: { isNot: null } } : {}),
      ...(f.estado === 'pendiente' ? { respuesta: null, venceAt: { gt: ahora } } : {}),
      ...(f.estado === 'vencida' ? { respuesta: null, venceAt: { lte: ahora } } : {}),
    };
    const [total, filas] = await Promise.all([
      this.prisma.invitacion.count({ where }),
      this.prisma.invitacion.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: Math.min(f.limite ?? 50, 200),
        skip: f.desplazamiento ?? 0,
        include: {
          version: {
            select: {
              numero: true,
              encuesta: { select: { id: true, codigo: true, nombre: true } },
            },
          },
          respuesta: {
            select: { respondidaAt: true, nombreRespondiente: true, cargoRespondiente: true },
          },
        },
      }),
    ]);
    return {
      total,
      items: filas.map((i) => ({
        id: i.id,
        encuesta: i.version.encuesta,
        version: i.version.numero,
        moduloCodigo: i.moduloCodigo,
        referenciaId: i.referenciaId,
        correoDestino: i.correoDestino,
        creadaAt: i.createdAt,
        venceAt: i.venceAt,
        enviadaAt: i.enviadaAt,
        envioError: i.envioError,
        estado: estadoDe(i),
        respondidaAt: i.respuesta?.respondidaAt ?? null,
        respondiente: i.respuesta
          ? { nombre: i.respuesta.nombreRespondiente, cargo: i.respuesta.cargoRespondiente }
          : null,
      })),
    };
  }

  /** Una invitación con cada pregunta de su versión y lo que se respondió. */
  async detalle(id: string) {
    const i = await this.prisma.invitacion.findUnique({
      where: { id },
      include: {
        version: {
          include: {
            encuesta: { select: { id: true, codigo: true, nombre: true } },
            preguntas: {
              orderBy: { orden: 'asc' },
              include: {
                escala: { include: { valores: true } },
                opciones: { orderBy: { orden: 'asc' } },
              },
            },
          },
        },
        respuesta: { include: { respuestas: true } },
      },
    });
    if (!i) throw new NotFoundException('La invitación no existe');
    const filas = i.respuesta?.respuestas ?? [];
    return {
      id: i.id,
      encuesta: i.version.encuesta,
      version: i.version.numero,
      titulo: i.version.titulo,
      moduloCodigo: i.moduloCodigo,
      referenciaId: i.referenciaId,
      correoDestino: i.correoDestino,
      creadaAt: i.createdAt,
      venceAt: i.venceAt,
      enviadaAt: i.enviadaAt,
      envioError: i.envioError,
      estado: estadoDe(i),
      respondidaAt: i.respuesta?.respondidaAt ?? null,
      respondiente: i.respuesta
        ? { nombre: i.respuesta.nombreRespondiente, cargo: i.respuesta.cargoRespondiente }
        : null,
      respuestas: i.version.preguntas.map((p) => {
        const mias = filas.filter((r) => r.preguntaId === p.id);
        let valor: unknown = null;
        if (mias.length) {
          if (p.tipo === 'escala') {
            const n = mias[0].valorNumero;
            valor = {
              valor: n,
              etiqueta: p.escala?.valores.find((v) => v.valor === n)?.etiqueta ?? null,
            };
          } else if (p.tipo === 'texto') valor = mias[0].valorTexto;
          else if (p.tipo === 'si_no') valor = mias[0].valorBooleano;
          else {
            const elegidas = mias.map((r) => ({
              id: r.opcionId,
              etiqueta: p.opciones.find((o) => o.id === r.opcionId)?.etiqueta ?? null,
            }));
            valor = p.tipo === 'opcion_unica' ? elegidas[0] : elegidas;
          }
        }
        return { preguntaId: p.id, orden: p.orden, texto: p.texto, tipo: p.tipo, valor };
      }),
    };
  }
}
