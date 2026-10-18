import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { currentTraceparent } from '@dyn/common';
import { createEvent, EventBus } from '@dyn/messaging';
import { uuidv7 } from '@dyn/utils';
import type { Prisma } from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';

/** Días de aviso antes del vencimiento de un documento. */
export const DIAS_POR_VENCER = 30;

export type EstadoDocumento = 'vigente' | 'por_vencer' | 'vencido' | 'faltante';

export interface DocumentoConductor {
  tipo: { id: string; codigo: string; nombre: string; conVigencia: boolean };
  estado: EstadoDocumento;
  vigenteHasta: string | null;
  /** Días que faltan para el vencimiento (negativo si ya venció); nulo si el documento no vence. */
  diasRestantes: number | null;
  permisoId: string | null;
}

export interface ActorConductores {
  id: string;
  roleCode: string;
}

type Cliente = PrismaService | Prisma.TransactionClient;

/** La fecha de hoy en Ecuador (YYYY-MM-DD): la vigencia de un documento se cuenta por días calendario locales. */
export function hoyEcuador(ahora = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Guayaquil' }).format(ahora);
}

const aMs = (fecha: string) => Date.parse(`${fecha}T00:00:00Z`);

/** Clasifica un documento según su vigencia. Función pura (la prueban las unitarias). */
export function estadoDeDocumento(
  conVigencia: boolean,
  vigenteHasta: string | null,
  hoy: string,
): { estado: EstadoDocumento; diasRestantes: number | null } {
  if (!conVigencia) return { estado: 'vigente', diasRestantes: null };
  if (!vigenteHasta) return { estado: 'faltante', diasRestantes: null };
  const dias = Math.round((aMs(vigenteHasta) - aMs(hoy)) / 86_400_000);
  if (dias < 0) return { estado: 'vencido', diasRestantes: dias };
  return { estado: dias <= DIAS_POR_VENCER ? 'por_vencer' : 'vigente', diasRestantes: dias };
}

const dia = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

/**
 * Documentos con vigencia de los conductores. El conductor es una cuenta de identidad; cada renovación es un registro nuevo y el
 * vigente de cada tipo es el último no anulado. Es la base de la regla «sin documentos vigentes no se guarda la inspección».
 */
@Injectable()
export class ConductoresService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: EventBus,
  ) {}

  tipos() {
    return this.prisma.tipoPermisoConductor.findMany({
      where: { activo: true },
      orderBy: { orden: 'asc' },
      select: { id: true, codigo: true, nombre: true, conVigencia: true, orden: true },
    });
  }

  /** Estado de los documentos de una cuenta y si reúne las condiciones para conducir. */
  async estado(usuarioId: string, db: Cliente = this.prisma) {
    const usuario = await db.idUsuario.findUnique({
      where: { id: usuarioId },
      select: { id: true, nombre: true, activo: true },
    });
    if (!usuario) throw new NotFoundException('La cuenta del conductor no existe');
    const [resumen] = await this.resumenDe(db, [usuario]);
    return resumen;
  }

  /** Cuentas con rol de conductor o con algún documento registrado, con su estado. */
  async listar(q?: string) {
    const texto = q?.trim();
    const usuarios = await this.prisma.idUsuario.findMany({
      where: {
        activo: true,
        OR: [
          { rol: { codigo: 'conductor' } },
          { permisosConductor: { some: { anulacion: { is: null } } } },
        ],
        ...(texto ? { nombre: { contains: texto, mode: 'insensitive' as const } } : {}),
      },
      select: { id: true, nombre: true, activo: true },
      orderBy: { nombre: 'asc' },
      take: 300,
    });
    return this.resumenDe(this.prisma, usuarios);
  }

  /** Historia de documentos de una cuenta (incluye los anulados). */
  async historia(usuarioId: string) {
    const filas = await this.prisma.conductorPermiso.findMany({
      where: { usuarioId },
      include: { tipo: true, anulacion: true, registrador: { select: { id: true, nombre: true } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return filas.map((f) => ({
      id: f.id,
      tipo: { id: f.tipo.id, codigo: f.tipo.codigo, nombre: f.tipo.nombre },
      vigenteHasta: dia(f.vigenteHasta),
      archivoId: f.archivoId,
      observaciones: f.observaciones,
      registradoPor: f.registrador,
      registradoAt: f.createdAt,
      anulado: f.anulacion ? { at: f.anulacion.anuladaAt, motivo: f.anulacion.motivo } : null,
    }));
  }

  async registrar(
    usuarioId: string,
    entrada: {
      tipoId: string;
      vigenteHasta?: string | null;
      archivoId?: string | null;
      observaciones?: string | null;
    },
    actor: ActorConductores,
  ) {
    const [usuario, tipo] = await Promise.all([
      this.prisma.idUsuario.findUnique({
        where: { id: usuarioId },
        select: { id: true, activo: true },
      }),
      this.prisma.tipoPermisoConductor.findUnique({ where: { id: entrada.tipoId } }),
    ]);
    if (!usuario) throw new NotFoundException('La cuenta del conductor no existe');
    if (!usuario.activo) {
      throw new ConflictException({
        message: 'La cuenta del conductor está inactiva',
        code: 'conductor_inactivo',
      });
    }
    if (!tipo || !tipo.activo) throw new BadRequestException('El tipo de documento no existe');
    if (tipo.conVigencia && !entrada.vigenteHasta) {
      throw new BadRequestException({
        message: `${tipo.nombre} vence: indique hasta qué fecha es válido`,
        code: 'falta_vigencia',
      });
    }
    if (!tipo.conVigencia && entrada.vigenteHasta) {
      throw new BadRequestException({
        message: `${tipo.nombre} no tiene fecha de vencimiento`,
        code: 'sin_vigencia',
      });
    }
    return this.prisma.$transaction(async (tx) => {
      const permiso = await tx.conductorPermiso.create({
        data: {
          id: uuidv7(),
          usuarioId,
          tipoId: tipo.id,
          conVigencia: tipo.conVigencia,
          vigenteHasta: entrada.vigenteHasta ? new Date(`${entrada.vigenteHasta}T00:00:00Z`) : null,
          archivoId: entrada.archivoId ?? null,
          observaciones: entrada.observaciones?.trim() || null,
          createdBy: actor.id,
        },
      });
      await this.bus.publish(
        tx,
        createEvent({
          type: 'flota.conductor.permiso_registrado',
          source: 'flota',
          subject: { type: 'identidad_usuario', id: usuarioId },
          data: {
            usuarioId,
            permisoId: permiso.id,
            tipo: tipo.codigo,
            vigenteHasta: entrada.vigenteHasta ?? null,
          },
          actor: { userId: actor.id, role: actor.roleCode },
          traceparent: currentTraceparent(),
        }),
      );
      return {
        id: permiso.id,
        usuarioId,
        tipo: tipo.codigo,
        vigenteHasta: entrada.vigenteHasta ?? null,
      };
    });
  }

  async anular(permisoId: string, motivo: string, actor: ActorConductores) {
    return this.prisma.$transaction(async (tx) => {
      const p = await tx.conductorPermiso.findUnique({
        where: { id: permisoId },
        include: { anulacion: true, tipo: { select: { codigo: true } } },
      });
      if (!p) throw new NotFoundException('El documento no existe');
      if (p.anulacion) {
        throw new ConflictException({
          message: 'El documento ya está anulado',
          code: 'permiso_ya_anulado',
        });
      }
      await tx.conductorPermisoAnulacion.create({
        data: { permisoId, anuladaPor: actor.id, motivo: motivo.trim() },
      });
      await this.bus.publish(
        tx,
        createEvent({
          type: 'flota.conductor.permiso_anulado',
          source: 'flota',
          subject: { type: 'identidad_usuario', id: p.usuarioId },
          data: { usuarioId: p.usuarioId, permisoId, tipo: p.tipo.codigo },
          actor: { userId: actor.id, role: actor.roleCode },
          traceparent: currentTraceparent(),
        }),
      );
      return { permisoId, anulado: true };
    });
  }

  /**
   * Exige que el conductor reúna las condiciones (todos los documentos vigentes). Lo usa la inspección de vehículos: si falta o
   * venció alguno, no se guarda y el mensaje dice cuál.
   */
  async exigirCondiciones(usuarioId: string, db: Cliente = this.prisma): Promise<void> {
    const e = await this.estado(usuarioId, db);
    if (e.reuneCondiciones) return;
    const pendientes = e.documentos
      .filter((d) => d.estado === 'vencido' || d.estado === 'faltante')
      .map((d) => `${d.tipo.nombre} (${d.estado === 'vencido' ? 'vencido' : 'sin registrar'})`);
    throw new UnprocessableEntityException({
      message: `${e.usuario.nombre} no reúne las condiciones para conducir: ${pendientes.join(', ')}`,
      code: 'conductor_sin_condiciones',
    });
  }

  private async resumenDe(
    db: Cliente,
    usuarios: Array<{ id: string; nombre: string; activo: boolean }>,
  ) {
    const tipos = await db.tipoPermisoConductor.findMany({
      where: { activo: true },
      orderBy: { orden: 'asc' },
    });
    const permisos = usuarios.length
      ? await db.conductorPermiso.findMany({
          where: { usuarioId: { in: usuarios.map((u) => u.id) }, anulacion: { is: null } },
          orderBy: { createdAt: 'desc' },
          select: { id: true, usuarioId: true, tipoId: true, vigenteHasta: true },
        })
      : [];
    const hoy = hoyEcuador();
    return usuarios.map((u) => {
      const documentos: DocumentoConductor[] = tipos.map((t) => {
        // El primero de cada tipo es el último registrado (orden descendente).
        const p = permisos.find((x) => x.usuarioId === u.id && x.tipoId === t.id);
        const vence = dia(p?.vigenteHasta ?? null);
        const { estado, diasRestantes } = p
          ? estadoDeDocumento(t.conVigencia, vence, hoy)
          : { estado: 'faltante' as const, diasRestantes: null };
        return {
          tipo: { id: t.id, codigo: t.codigo, nombre: t.nombre, conVigencia: t.conVigencia },
          estado,
          vigenteHasta: vence,
          diasRestantes,
          permisoId: p?.id ?? null,
        };
      });
      return {
        usuario: { id: u.id, nombre: u.nombre },
        reuneCondiciones: documentos.every(
          (d) => d.estado === 'vigente' || d.estado === 'por_vencer',
        ),
        porVencer: documentos.filter((d) => d.estado === 'por_vencer').map((d) => d.tipo.nombre),
        documentos,
      };
    });
  }
}
