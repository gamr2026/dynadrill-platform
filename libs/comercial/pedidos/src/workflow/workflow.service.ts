import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { uuidv7 } from '@dyn/utils';
import { Prisma } from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';

/** Quién hace el cambio. `permisos` son los del token; el motor nunca consulta usuarios. */
export interface ActorFlujo {
  id?: string;
  nombre?: string;
  rol?: string;
  permisos: readonly string[];
}

/** Cómo se produjo el cambio (queda en el seguimiento). */
export type OrigenCambio = 'manual' | 'automatico' | 'sincronizacion' | 'forzado' | 'sistema';

export interface TransicionDisponible {
  estado: string;
  nombre: string;
  requiereMotivo: boolean;
  regla: string | null;
}

export interface CambioAplicado {
  macroEstado: string;
  nombreEstado: string;
  historialId: string;
}

const MIN_MOTIVO_FORZADO = 5;

/**
 * Motor de estados por proceso. El catálogo de estados, los pasos válidos (con su permiso y si exigen motivo) y el
 * seguimiento viven en base de datos y se ajustan sin desplegar código. Lo que NO está aquí: las precondiciones de
 * negocio (p. ej. "el pedido está completo"), que siguen en código y se identifican por el nombre en `regla`.
 *
 * `aplicar` solo valida y deja el seguimiento; actualizar el estado de la entidad es responsabilidad de quien lo llama,
 * dentro de la MISMA transacción, para que el estado y su historial no se separen.
 */
@Injectable()
export class WorkflowService {
  constructor(private readonly prisma: PrismaService) {}

  estados(proceso: string) {
    return this.prisma.procesoEstado.findMany({
      where: { proceso, activo: true },
      orderBy: { orden: 'asc' },
      select: {
        codigo: true,
        nombre: true,
        macroEstado: true,
        orden: true,
        rolResponsable: true,
        terminal: true,
      },
    });
  }

  transiciones(proceso: string) {
    return this.prisma.procesoTransicion.findMany({
      where: { proceso, activa: true },
      orderBy: [{ estadoOrigen: 'asc' }, { estadoDestino: 'asc' }],
      select: {
        estadoOrigen: true,
        estadoDestino: true,
        permiso: true,
        requiereMotivo: true,
        automatica: true,
        eventoDisparador: true,
        regla: true,
      },
    });
  }

  /** Pasos que ESTA persona puede dar a mano desde un estado (los que tienen permiso y ella lo tiene). */
  async disponibles(
    proceso: string,
    estadoActual: string,
    actor: Pick<ActorFlujo, 'permisos'>,
  ): Promise<TransicionDisponible[]> {
    const filas = await this.prisma.procesoTransicion.findMany({
      where: {
        proceso,
        estadoOrigen: estadoActual,
        activa: true,
        permiso: { in: [...actor.permisos] },
      },
      include: { destino: { select: { nombre: true, activo: true } } },
      orderBy: { estadoDestino: 'asc' },
    });
    return filas
      .filter((f) => f.destino.activo)
      .map((f) => ({
        estado: f.estadoDestino,
        nombre: f.destino.nombre,
        requiereMotivo: f.requiereMotivo,
        regla: f.regla,
      }));
  }

  /** Valida el paso y deja el seguimiento. Lanza el error HTTP que corresponda si no es válido. */
  async aplicar(
    tx: Prisma.TransactionClient,
    p: {
      proceso: string;
      entidadId: string;
      desde: string | null;
      hacia: string;
      motivo?: string | null;
      actor: ActorFlujo;
      origen: OrigenCambio;
      /** Permiso que habilita forzar un estado (solo con `origen = 'forzado'`). */
      permisoForzar?: string;
      eventoId?: string;
    },
  ): Promise<CambioAplicado> {
    const destino = await tx.procesoEstado.findUnique({
      where: { proceso_codigo: { proceso: p.proceso, codigo: p.hacia } },
    });
    if (!destino || !destino.activo) {
      throw new BadRequestException(`El estado "${p.hacia}" no existe en el proceso ${p.proceso}`);
    }
    if (p.desde === p.hacia)
      throw new ConflictException(`El pedido ya está en "${destino.nombre}"`);
    const motivo = p.motivo?.trim() || null;

    if (p.origen === 'forzado') {
      if (!p.permisoForzar || !p.actor.permisos.includes(p.permisoForzar)) {
        throw new ForbiddenException('No tiene permiso para forzar el estado');
      }
      if (!motivo || motivo.length < MIN_MOTIVO_FORZADO) {
        throw new BadRequestException(
          `Forzar un estado exige un motivo de al menos ${MIN_MOTIVO_FORZADO} caracteres`,
        );
      }
    } else {
      const paso = p.desde
        ? await tx.procesoTransicion.findUnique({
            where: {
              proceso_estadoOrigen_estadoDestino: {
                proceso: p.proceso,
                estadoOrigen: p.desde,
                estadoDestino: p.hacia,
              },
            },
          })
        : null;
      if (!paso || !paso.activa) {
        throw new ConflictException(`No se puede pasar de "${p.desde}" a "${destino.nombre}"`);
      }
      if (p.origen === 'manual') {
        if (!paso.permiso)
          throw new ForbiddenException('Este paso lo realiza el sistema, no se hace a mano');
        if (!p.actor.permisos.includes(paso.permiso)) {
          throw new ForbiddenException('Su rol no tiene permiso para este paso');
        }
      }
      if (paso.requiereMotivo && !motivo)
        throw new BadRequestException('El motivo es obligatorio para este paso');
    }

    const historialId = uuidv7();
    await tx.procesoHistorial.create({
      data: {
        id: historialId,
        proceso: p.proceso,
        entidadId: p.entidadId,
        estadoAnterior: p.desde,
        estadoNuevo: p.hacia,
        macroEstado: destino.macroEstado,
        motivo,
        actorId: p.actor.id ?? null,
        actorRol: p.actor.rol ?? null,
        origen: p.origen,
        eventoId: p.eventoId ?? null,
      },
    });
    return { macroEstado: destino.macroEstado, nombreEstado: destino.nombre, historialId };
  }

  /** Primer registro del seguimiento de una entidad nueva (sin estado anterior). No valida pasos. */
  async iniciar(
    tx: Prisma.TransactionClient,
    p: {
      proceso: string;
      entidadId: string;
      estado: string;
      actor: ActorFlujo;
      origen: OrigenCambio;
      motivo?: string;
    },
  ): Promise<void> {
    const e = await tx.procesoEstado.findUnique({
      where: { proceso_codigo: { proceso: p.proceso, codigo: p.estado } },
    });
    if (!e || !e.activo)
      throw new BadRequestException(`El estado "${p.estado}" no existe en el proceso ${p.proceso}`);
    await tx.procesoHistorial.create({
      data: {
        id: uuidv7(),
        proceso: p.proceso,
        entidadId: p.entidadId,
        estadoAnterior: null,
        estadoNuevo: p.estado,
        macroEstado: e.macroEstado,
        motivo: p.motivo ?? null,
        actorId: p.actor.id ?? null,
        actorRol: p.actor.rol ?? null,
        origen: p.origen,
      },
    });
  }

  /** Seguimiento de una entidad, del más antiguo al más reciente, con el nombre legible de cada estado. */
  async historial(proceso: string, entidadId: string) {
    const [filas, estados] = await Promise.all([
      this.prisma.procesoHistorial.findMany({
        where: { proceso, entidadId },
        orderBy: { createdAt: 'asc' },
        include: { actor: { select: { nombre: true } } },
      }),
      this.estados(proceso),
    ]);
    const nombre = new Map(estados.map((e) => [e.codigo, e.nombre]));
    return filas.map((h) => ({
      estadoAnterior: h.estadoAnterior,
      estadoNuevo: h.estadoNuevo,
      nombreEstado: nombre.get(h.estadoNuevo) ?? h.estadoNuevo,
      macroEstado: h.macroEstado,
      motivo: h.motivo,
      actorNombre: h.actor?.nombre ?? null,
      actorRol: h.actorRol,
      origen: h.origen,
      fecha: h.createdAt,
    }));
  }

  async estadoInfo(proceso: string, codigo: string) {
    const e = await this.prisma.procesoEstado.findUnique({
      where: { proceso_codigo: { proceso, codigo } },
    });
    if (!e) throw new NotFoundException(`El estado "${codigo}" no existe`);
    return e;
  }
}
