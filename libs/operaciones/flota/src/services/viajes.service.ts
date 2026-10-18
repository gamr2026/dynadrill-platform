import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Permission } from '@dyn/authz';
import { currentTraceparent } from '@dyn/common';
import { createEvent, EventBus } from '@dyn/messaging';
import { uuidv7 } from '@dyn/utils';
import type {
  DecisionViaje,
  NivelRiesgoViaje,
  Prisma,
  TipoGerenciamiento,
} from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';

const P = Permission;

export interface ActorViaje {
  id: string;
  roleCode: string;
  permissions: string[];
}

/** Un extremo del viaje: una bodega (la base) o un pozo; exactamente uno. */
export interface ExtremoViaje {
  bodegaId?: string;
  pozoId?: string;
}

export interface SolicitarViajeEntrada {
  tipo: TipoGerenciamiento;
  ticketId?: string;
  unidadId: string;
  fecha: string;
  motivo: string;
  origen: ExtremoViaje;
  destino: ExtremoViaje;
  respuestas: Array<{ preguntaId: string; opcionId: string }>;
  pasajeros?: string | null;
  puedeCombinarViajes?: boolean | null;
  horaSalida?: string | null;
  horaLlegada?: string | null;
  datosPernocta?: string | null;
  aprobacionTelefonica?: { de: string; hora: string } | null;
  paradas?: Array<{
    lugar: string;
    horaLlegada?: string | null;
    horaSalida?: string | null;
    detallePernocta?: string | null;
  }>;
  comunicaciones?: Array<{
    frecuencia: string;
    personaContacto: string;
    datosContacto?: string | null;
  }>;
}

/** El nivel es el de mayor `desde` que no supere el puntaje. Función pura (la prueban las unitarias). */
export function nivelDePuntaje(
  puntos: number,
  umbrales: Array<{ nivel: NivelRiesgoViaje; desdePuntos: number }>,
): NivelRiesgoViaje {
  const orden = [...umbrales].sort((a, b) => b.desdePuntos - a.desdePuntos);
  const hallado = orden.find((u) => u.desdePuntos <= puntos);
  if (!hallado) throw new Error('No hay un umbral de riesgo para el puntaje');
  return hallado.nivel;
}

export const codigoDeViaje = (numero: bigint | number) => `GV-${String(numero).padStart(4, '0')}`;

const hora = (h: string | null | undefined): Date | null => {
  if (!h) return null;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(h))
    throw new BadRequestException(`La hora «${h}» no es válida (use HH:MM)`);
  return new Date(`1970-01-01T${h}:00.000Z`);
};
const verHora = (d: Date | null) => (d ? d.toISOString().slice(11, 16) : null);
const verDia = (d: Date) => d.toISOString().slice(0, 10);

type Cliente = PrismaService | Prisma.TransactionClient;

/**
 * Gerenciamiento de Viaje (DYN-SGI-RE-049). Lo solicita el Conductor; el nivel de riesgo y quién lo autoriza salen de las tablas
 * `opcion_riesgo_viaje` y `umbral_riesgo_viaje`, no del frontend. Pumping consume `flota.gerenciamiento_viaje.aprobado|rechazado`
 * (`ticketId` y `tipo`) como condición del ticket.
 */
@Injectable()
export class ViajesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: EventBus,
  ) {}

  async preguntas() {
    const filas = await this.prisma.preguntaRiesgoViaje.findMany({
      where: { activa: true },
      orderBy: { orden: 'asc' },
      include: { opciones: { where: { activa: true }, orderBy: { orden: 'asc' } } },
    });
    return filas.map((p) => ({
      id: p.id,
      codigo: p.codigo,
      orden: p.orden,
      texto: p.texto,
      opciones: p.opciones.map((o) => ({
        id: o.id,
        etiqueta: o.etiqueta,
        puntos: o.puntos,
        impideConducir: o.impideConducir,
      })),
    }));
  }

  async umbrales() {
    return this.prisma.umbralRiesgoViaje.findMany({
      orderBy: { desdePuntos: 'asc' },
      select: { nivel: true, desdePuntos: true, permisoAutoriza: true, descripcion: true },
    });
  }

  /** Bodegas (la base) entre las que se elige el origen o el destino que no es el pozo del ticket. */
  bodegas() {
    return this.prisma.catBodega.findMany({
      where: { habilitado: true },
      orderBy: { nombre: 'asc' },
      select: { id: true, nombre: true },
    });
  }

  async solicitar(entrada: SolicitarViajeEntrada, actor: ActorViaje) {
    this.validarExtremo(entrada.origen, 'origen');
    this.validarExtremo(entrada.destino, 'destino');
    const motivo = entrada.motivo.trim();
    if (!motivo) throw new BadRequestException('Indique el motivo del viaje');

    return this.prisma.$transaction(async (tx) => {
      const unidad = await tx.unidad.findUnique({
        where: { id: entrada.unidadId },
        select: { id: true, tipo: true, activa: true },
      });
      if (!unidad) throw new NotFoundException('La unidad no existe');
      if (unidad.tipo !== 'transporte' || !unidad.activa) {
        throw new ConflictException({
          message: 'El viaje se hace con una unidad de transporte activa',
          code: 'unidad_no_es_transporte',
        });
      }

      const { puntos, nivel } = await this.evaluar(tx, entrada.respuestas);

      if (entrada.ticketId) {
        const hay = await tx.gerenciamientoViaje.findFirst({
          // pendiente (decisión nula) o autorizado: `not` solo no sirve porque en SQL NULL <> 'rechazado' no es verdadero
          where: {
            ticketId: entrada.ticketId,
            tipo: entrada.tipo,
            OR: [{ decision: null }, { decision: 'autorizado' }],
          },
          select: { id: true },
        });
        if (hay) {
          throw new ConflictException({
            message: `Este ticket ya tiene un gerenciamiento de viaje de ${entrada.tipo} vigente`,
            code: 'viaje_ya_solicitado',
          });
        }
      }

      const id = uuidv7();
      const telefonica = entrada.aprobacionTelefonica;
      const viaje = await tx.gerenciamientoViaje.create({
        data: {
          id,
          tipo: entrada.tipo,
          ticketId: entrada.ticketId ?? null,
          conductorId: actor.id,
          unidadId: unidad.id,
          fecha: new Date(`${entrada.fecha}T00:00:00.000Z`),
          motivo,
          origenBodegaId: entrada.origen.bodegaId ?? null,
          origenPozoId: entrada.origen.pozoId ?? null,
          destinoBodegaId: entrada.destino.bodegaId ?? null,
          destinoPozoId: entrada.destino.pozoId ?? null,
          puntajeTotal: puntos,
          nivel,
          pasajeros: entrada.pasajeros?.trim() || null,
          puedeCombinarViajes: entrada.puedeCombinarViajes ?? null,
          horaSalida: hora(entrada.horaSalida),
          horaLlegada: hora(entrada.horaLlegada),
          datosPernocta: entrada.datosPernocta?.trim() || null,
          aprobacionTelefonicaDe: telefonica?.de.trim() || null,
          aprobacionTelefonicaHora: telefonica ? hora(telefonica.hora) : null,
          createdBy: actor.id,
        },
      });
      await tx.gerenciamientoViajeRespuesta.createMany({
        data: entrada.respuestas.map((r) => ({
          gerenciamientoId: id,
          preguntaId: r.preguntaId,
          opcionId: r.opcionId,
        })),
      });
      if (entrada.paradas?.length) {
        await tx.gerenciamientoViajeParada.createMany({
          data: entrada.paradas.map((p, i) => ({
            gerenciamientoId: id,
            orden: i + 1,
            lugar: p.lugar.trim(),
            horaLlegada: hora(p.horaLlegada),
            horaSalida: hora(p.horaSalida),
            detallePernocta: p.detallePernocta?.trim() || null,
          })),
        });
      }
      if (entrada.comunicaciones?.length) {
        await tx.gerenciamientoViajeComunicacion.createMany({
          data: entrada.comunicaciones.map((c, i) => ({
            gerenciamientoId: id,
            orden: i + 1,
            frecuencia: c.frecuencia.trim(),
            personaContacto: c.personaContacto.trim(),
            datosContacto: c.datosContacto?.trim() || null,
          })),
        });
      }
      await this.publicar(tx, 'solicitado', id, actor, {
        gerenciamientoId: id,
        codigo: codigoDeViaje(viaje.numero),
        ticketId: entrada.ticketId ?? null,
        tipo: entrada.tipo,
        nivel,
        puntaje: puntos,
      });
      return {
        id,
        codigo: codigoDeViaje(viaje.numero),
        nivel,
        puntajeTotal: puntos,
        estado: 'pendiente' as const,
      };
    });
  }

  async autorizar(id: string, actor: ActorViaje) {
    return this.decidir(id, 'autorizado', null, actor);
  }

  async rechazar(id: string, motivo: string, actor: ActorViaje) {
    return this.decidir(id, 'rechazado', motivo.trim(), actor);
  }

  async listar(
    f: {
      estado?: 'pendiente' | 'autorizado' | 'rechazado';
      ticketId?: string;
      tipo?: TipoGerenciamiento;
    },
    actor: ActorViaje,
  ) {
    const veTodo = this.puedeVerTodo(actor);
    const [filas, umbrales] = await Promise.all([
      this.prisma.gerenciamientoViaje.findMany({
        where: {
          ...(veTodo ? {} : { conductorId: actor.id }),
          ...(f.ticketId ? { ticketId: f.ticketId } : {}),
          ...(f.tipo ? { tipo: f.tipo } : {}),
          ...(f.estado === 'pendiente'
            ? { decision: null }
            : f.estado
              ? { decision: f.estado }
              : {}),
        },
        include: {
          conductor: { select: { id: true, nombre: true } },
          unidad: { select: { id: true, codigo: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 200,
      }),
      this.umbrales(),
    ]);
    return filas.map((v) => ({
      id: v.id,
      codigo: codigoDeViaje(v.numero),
      tipo: v.tipo,
      ticketId: v.ticketId,
      fecha: verDia(v.fecha),
      conductor: v.conductor,
      unidad: v.unidad,
      puntajeTotal: v.puntajeTotal,
      nivel: v.nivel,
      estado: v.decision ?? ('pendiente' as const),
      puedeDecidir: this.puedeDecidir(v, umbrales, actor),
      createdAt: v.createdAt,
    }));
  }

  async obtener(id: string, actor: ActorViaje) {
    const v = await this.prisma.gerenciamientoViaje.findUnique({
      where: { id },
      include: {
        conductor: { select: { id: true, nombre: true } },
        decisor: { select: { id: true, nombre: true } },
        registrador: { select: { id: true, nombre: true } },
        unidad: {
          select: {
            id: true,
            codigo: true,
            nombre: true,
            categoriaPeso: true,
            vehiculo: { select: { placa: true } },
          },
        },
        origenBodega: { select: { id: true, nombre: true } },
        origenPozo: {
          select: { id: true, nombreCompleto: true, campo: { select: { nombre: true } } },
        },
        destinoBodega: { select: { id: true, nombre: true } },
        destinoPozo: {
          select: { id: true, nombreCompleto: true, campo: { select: { nombre: true } } },
        },
        respuestas: { include: { pregunta: true, opcion: true } },
        paradas: { orderBy: { orden: 'asc' } },
        comunicaciones: { orderBy: { orden: 'asc' } },
      },
    });
    if (!v || (v.conductorId !== actor.id && !this.puedeVerTodo(actor))) {
      throw new NotFoundException('El gerenciamiento de viaje no existe');
    }
    const umbrales = await this.umbrales();
    const extremo = (
      bodega: { id: string; nombre: string } | null,
      pozo: { id: string; nombreCompleto: string; campo: { nombre: string } | null } | null,
    ) =>
      bodega
        ? { tipo: 'bodega' as const, id: bodega.id, nombre: bodega.nombre }
        : {
            tipo: 'pozo' as const,
            id: pozo!.id,
            nombre: pozo!.nombreCompleto,
            campo: pozo!.campo?.nombre ?? null,
          };
    return {
      id: v.id,
      codigo: codigoDeViaje(v.numero),
      tipo: v.tipo,
      ticketId: v.ticketId,
      fecha: verDia(v.fecha),
      motivo: v.motivo,
      conductor: v.conductor,
      unidad: {
        id: v.unidad.id,
        codigo: v.unidad.codigo,
        nombre: v.unidad.nombre,
        categoriaPeso: v.unidad.categoriaPeso,
        placa: v.unidad.vehiculo?.placa ?? null,
      },
      origen: extremo(v.origenBodega, v.origenPozo),
      destino: extremo(v.destinoBodega, v.destinoPozo),
      puntajeTotal: v.puntajeTotal,
      nivel: v.nivel,
      descripcionNivel: umbrales.find((u) => u.nivel === v.nivel)?.descripcion ?? null,
      pasajeros: v.pasajeros,
      puedeCombinarViajes: v.puedeCombinarViajes,
      horaSalida: verHora(v.horaSalida),
      horaLlegada: verHora(v.horaLlegada),
      datosPernocta: v.datosPernocta,
      aprobacionTelefonica: v.aprobacionTelefonicaDe
        ? { de: v.aprobacionTelefonicaDe, hora: verHora(v.aprobacionTelefonicaHora) }
        : null,
      respuestas: v.respuestas
        .map((r) => ({
          orden: r.pregunta.orden,
          pregunta: r.pregunta.texto,
          opcion: r.opcion.etiqueta,
          puntos: r.opcion.puntos,
        }))
        .sort((a, b) => a.orden - b.orden),
      paradas: v.paradas.map((p) => ({
        lugar: p.lugar,
        horaLlegada: verHora(p.horaLlegada),
        horaSalida: verHora(p.horaSalida),
        detallePernocta: p.detallePernocta,
      })),
      comunicaciones: v.comunicaciones.map((c) => ({
        frecuencia: c.frecuencia,
        personaContacto: c.personaContacto,
        datosContacto: c.datosContacto,
      })),
      estado: v.decision ?? ('pendiente' as const),
      decision: v.decision ? { por: v.decisor, at: v.decididoAt, motivo: v.motivoDecision } : null,
      registradoPor: v.registrador,
      createdAt: v.createdAt,
      puedeDecidir: this.puedeDecidir(v, umbrales, actor),
    };
  }

  // ---------------------------------------------------------------- reglas

  private puedeVerTodo(actor: ActorViaje): boolean {
    return (
      actor.permissions.includes(P.VIAJES_APROBAR) ||
      actor.permissions.includes(P.VIAJES_AUTORIZAR_MAYOR)
    );
  }

  /** Puede decidir quien tiene el permiso que el umbral de ese nivel exige, y nunca sobre su propia solicitud. */
  private puedeDecidir(
    v: { decision: DecisionViaje | null; nivel: NivelRiesgoViaje; conductorId: string },
    umbrales: Array<{ nivel: NivelRiesgoViaje; permisoAutoriza: string }>,
    actor: ActorViaje,
  ): boolean {
    if (v.decision !== null || v.conductorId === actor.id) return false;
    const requerido = umbrales.find((u) => u.nivel === v.nivel)?.permisoAutoriza;
    return !!requerido && actor.permissions.includes(requerido);
  }

  private async decidir(
    id: string,
    decision: DecisionViaje,
    motivo: string | null,
    actor: ActorViaje,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const v = await tx.gerenciamientoViaje.findUnique({
        where: { id },
        select: {
          id: true,
          numero: true,
          ticketId: true,
          tipo: true,
          nivel: true,
          conductorId: true,
          decision: true,
          unidadId: true,
        },
      });
      if (!v) throw new NotFoundException('El gerenciamiento de viaje no existe');
      if (v.decision !== null) {
        throw new ConflictException({
          message: 'Este gerenciamiento de viaje ya tiene una decisión',
          code: 'viaje_ya_decidido',
        });
      }
      if (v.conductorId === actor.id) {
        throw new ForbiddenException({
          message: 'Usted no puede decidir sobre su propia solicitud',
          code: 'viaje_propio',
        });
      }
      const umbral = await tx.umbralRiesgoViaje.findUnique({ where: { nivel: v.nivel } });
      if (!umbral || !actor.permissions.includes(umbral.permisoAutoriza)) {
        throw new ForbiddenException({
          message:
            v.nivel === 'bajo'
              ? 'Este viaje lo autoriza el Supervisor'
              : `Este viaje es de riesgo ${v.nivel.toUpperCase()}: lo autoriza el Jefe de Base o el Gerente HSE`,
          code: 'nivel_requiere_otro_rol',
        });
      }
      const n = await tx.gerenciamientoViaje.updateMany({
        where: { id, decision: null },
        data: { decision, decididoPor: actor.id, decididoAt: new Date(), motivoDecision: motivo },
      });
      if (n.count === 0) {
        throw new ConflictException({
          message: 'Este gerenciamiento de viaje ya tiene una decisión',
          code: 'viaje_ya_decidido',
        });
      }
      // Pumping solo entiende el hecho cuando hay ticket: es la condición del paso (revisión de salida / control de retorno).
      if (v.ticketId) {
        await this.publicar(tx, decision === 'autorizado' ? 'aprobado' : 'rechazado', id, actor, {
          gerenciamientoId: id,
          codigo: codigoDeViaje(v.numero),
          ticketId: v.ticketId,
          tipo: v.tipo,
          nivel: v.nivel,
          unidadId: v.unidadId,
          ...(motivo ? { motivo } : {}),
        });
      }
      return { id, estado: decision };
    });
  }

  /** Suma los puntos de las opciones elegidas y calcula el nivel; todas las preguntas vigentes se contestan una vez. */
  private async evaluar(tx: Cliente, respuestas: Array<{ preguntaId: string; opcionId: string }>) {
    const preguntas = await tx.preguntaRiesgoViaje.findMany({
      where: { activa: true },
      select: { id: true },
    });
    const idsPreguntas = new Set(preguntas.map((p) => p.id));
    const vistas = new Set<string>();
    for (const r of respuestas) {
      if (!idsPreguntas.has(r.preguntaId))
        throw new BadRequestException('Hay una pregunta que no es del formato');
      if (vistas.has(r.preguntaId))
        throw new BadRequestException('Hay una pregunta contestada dos veces');
      vistas.add(r.preguntaId);
    }
    const faltan = preguntas.length - vistas.size;
    if (faltan > 0) {
      throw new BadRequestException({
        message: `Falta contestar ${faltan} pregunta(s) del cuestionario de riesgo`,
        code: 'cuestionario_incompleto',
      });
    }
    const opciones = await tx.opcionRiesgoViaje.findMany({
      where: { id: { in: respuestas.map((r) => r.opcionId) }, activa: true },
      select: { id: true, preguntaId: true, puntos: true, impideConducir: true, etiqueta: true },
    });
    let puntos = 0;
    for (const r of respuestas) {
      const o = opciones.find((x) => x.id === r.opcionId && x.preguntaId === r.preguntaId);
      if (!o) throw new BadRequestException('Hay una opción que no corresponde a su pregunta');
      if (o.impideConducir) {
        throw new UnprocessableEntityException({
          message: `La respuesta «${o.etiqueta}» indica que el conductor no debe viajar: no se puede solicitar el gerenciamiento de viaje`,
          code: 'conductor_no_debe_conducir',
        });
      }
      puntos += o.puntos;
    }
    const umbrales = await tx.umbralRiesgoViaje.findMany({
      select: { nivel: true, desdePuntos: true },
    });
    return { puntos, nivel: nivelDePuntaje(puntos, umbrales) };
  }

  private validarExtremo(e: ExtremoViaje, nombre: string): void {
    if ((e.bodegaId ? 1 : 0) + (e.pozoId ? 1 : 0) !== 1) {
      throw new BadRequestException(
        `Indique una sola base o un solo pozo como ${nombre} del viaje`,
      );
    }
  }

  private publicar(
    tx: Prisma.TransactionClient,
    hecho: 'solicitado' | 'aprobado' | 'rechazado',
    id: string,
    actor: ActorViaje,
    data: Record<string, unknown>,
  ) {
    return this.bus.publish(
      tx,
      createEvent({
        type: `flota.gerenciamiento_viaje.${hecho}`,
        source: 'flota',
        subject: { type: 'flota_gerenciamiento_viaje', id },
        data,
        actor: { userId: actor.id, role: actor.roleCode },
        traceparent: currentTraceparent(),
      }),
    );
  }
}
