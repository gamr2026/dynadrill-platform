import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { currentTraceparent } from '@dyn/common';
import { createEvent, EventBus } from '@dyn/messaging';
import { uuidv7 } from '@dyn/utils';
import type { MomentoInspeccion, Prisma, ResultadoChecklist } from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';
import { ConductoresService } from './conductores.service';
import { LecturasService } from './lecturas.service';

export interface ActorInspeccion {
  id: string;
  roleCode: string;
}

export interface RegistrarInspeccionEntrada {
  /** Caso del ticket (la unidad se toma de él). Sin caso la inspección es suelta y exige `unidadId`. */
  casoId?: string;
  unidadId?: string;
  momento?: MomentoInspeccion;
  fecha?: Date;
  puntoPartida: string;
  destino?: string | null;
  conductorId: string;
  /** Lectura del odómetro al momento de la inspección. */
  km: number;
  observaciones?: string | null;
  resultados: Array<{ itemId: string; resultado: ResultadoChecklist }>;
}

export type EstadoCaso = 'pendiente' | 'por_aprobar' | 'aprobada';

/**
 * Estado de la inspección de salida de un caso, calculado (no se guarda): sin inspección vigente = pendiente; con una y sin
 * aprobación = por aprobar; la última revisión decide si está aprobada.
 */
export function estadoDeSalida(
  inspeccion: { revisiones: Array<{ decision: 'aprobada' | 'rechazada' }> } | null,
): EstadoCaso {
  if (!inspeccion) return 'pendiente';
  return inspeccion.revisiones[0]?.decision === 'aprobada' ? 'aprobada' : 'por_aprobar';
}

const SOLO_DIA = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Inspección de vehículos (DYN-SGI-RE-068). Una inspección es un documento firmado: no se edita; se anula con motivo y se repite.
 * Los eventos `flota.inspeccion_vehiculo.*` los consume Pumping (requisitos del traslado de salida): llevan `ticketId`,
 * `vehiculoId` (el del catálogo, que es lo que Pumping guarda mientras dure D2) y `unidadId`.
 */
@Injectable()
export class InspeccionesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: EventBus,
    private readonly conductores: ConductoresService,
    private readonly lecturas: LecturasService,
  ) {}

  items() {
    return this.prisma.itemInspeccionVehiculo.findMany({
      where: { activo: true },
      orderBy: [{ seccion: 'asc' }, { orden: 'asc' }],
      select: {
        id: true,
        codigo: true,
        seccion: true,
        orden: true,
        etiqueta: true,
        bloqueaSiNoCumple: true,
      },
    });
  }

  async registrar(entrada: RegistrarInspeccionEntrada, actor: ActorInspeccion) {
    const momento = entrada.momento ?? 'salida';
    const puntoPartida = entrada.puntoPartida.trim();
    if (!puntoPartida) throw new BadRequestException('Indique el punto de partida');

    return this.prisma.$transaction(async (tx) => {
      const caso = entrada.casoId
        ? await tx.inspeccionCaso.findUnique({ where: { id: entrada.casoId } })
        : null;
      if (entrada.casoId && !caso) throw new NotFoundException('El caso de inspección no existe');
      const unidadId = caso?.unidadId ?? entrada.unidadId;
      if (!unidadId) throw new BadRequestException('Indique la unidad o el caso del ticket');
      if (caso && entrada.unidadId && entrada.unidadId !== caso.unidadId) {
        throw new BadRequestException('La unidad no corresponde al caso de inspección');
      }
      const unidad = await tx.unidad.findUnique({
        where: { id: unidadId },
        select: { id: true, codigo: true, tipo: true, activa: true, vehiculoId: true },
      });
      if (!unidad) throw new NotFoundException('La unidad no existe');
      if (unidad.tipo !== 'transporte') {
        throw new ConflictException({
          message: 'La inspección de vehículos aplica solo a unidades de transporte',
          code: 'unidad_no_es_transporte',
        });
      }
      if (!unidad.activa) {
        throw new ConflictException({
          message: 'La unidad está dada de baja',
          code: 'unidad_inactiva',
        });
      }

      if (caso) {
        const hay = await tx.inspeccionVehiculo.findFirst({
          where: { casoId: caso.id, momento, anuladaAt: null },
          select: { id: true },
        });
        if (hay) {
          throw new ConflictException({
            message: `Este caso ya tiene la inspección de ${momento}; anúlela antes de repetirla`,
            code: 'inspeccion_ya_registrada',
          });
        }
      }

      // Todos los ítems vigentes del formato deben tener respuesta (y ninguna repetida ni ajena).
      const items = await tx.itemInspeccionVehiculo.findMany({
        where: { activo: true },
        select: { id: true, etiqueta: true },
      });
      const idsItems = new Set(items.map((i) => i.id));
      const respondidos = new Set<string>();
      for (const r of entrada.resultados) {
        if (!idsItems.has(r.itemId))
          throw new BadRequestException('Hay un ítem que no es del formato');
        if (respondidos.has(r.itemId))
          throw new BadRequestException('Hay un ítem respondido dos veces');
        respondidos.add(r.itemId);
      }
      const faltan = items.filter((i) => !respondidos.has(i.id));
      if (faltan.length > 0) {
        throw new BadRequestException({
          message: `Falta marcar ${faltan.length} ítem(s) del formato (Cumple, No cumple o No aplica)`,
          code: 'checklist_incompleto',
        });
      }

      // Sin documentos vigentes del conductor no se guarda (formato DYN-SGI-RE-068, sección «Conductor»).
      await this.conductores.exigirCondiciones(entrada.conductorId, tx);

      const id = uuidv7();
      const fecha = entrada.fecha ?? new Date();
      await tx.inspeccionVehiculo.create({
        data: {
          id,
          casoId: caso?.id ?? null,
          unidadId,
          momento,
          fecha,
          puntoPartida,
          destino: entrada.destino?.trim() || null,
          conductorId: entrada.conductorId,
          observaciones: entrada.observaciones?.trim() || null,
          createdBy: actor.id,
        },
      });
      await tx.inspeccionVehiculoResultado.createMany({
        data: entrada.resultados.map((r) => ({
          inspeccionId: id,
          itemId: r.itemId,
          resultado: r.resultado,
        })),
      });
      // El kilometraje de la inspección es una lectura de odómetro de la unidad (única fuente del km).
      await this.lecturas.registrar(
        unidadId,
        {
          tipo: 'odometro',
          valor: entrada.km,
          leidaAt: fecha,
          fuente: 'inspeccion',
          inspeccionId: id,
        },
        actor,
        tx,
      );

      const noCumple = entrada.resultados.filter((r) => r.resultado === 'no_cumple');
      const bloqueantes = noCumple.length
        ? await tx.itemInspeccionVehiculo.count({
            where: { id: { in: noCumple.map((r) => r.itemId) }, bloqueaSiNoCumple: true },
          })
        : 0;
      const base = {
        inspeccionId: id,
        casoId: caso?.id ?? null,
        ticketId: caso?.ticketId ?? null,
        unidadId,
        vehiculoId: unidad.vehiculoId,
      };
      await this.publicar(tx, 'registrada', id, actor, {
        ...base,
        momento,
        hayNovedades: noCumple.length > 0,
        bloqueaUso: bloqueantes > 0,
      });
      if (caso && momento === 'salida') {
        await this.publicar(tx, 'realizada', id, actor, base);
      }
      return {
        id,
        unidadId,
        momento,
        hayNovedades: noCumple.length > 0,
        bloqueaUso: bloqueantes > 0,
      };
    });
  }

  /** Aprobación del Supervisor (condición para pasar a la ejecución). Una inspección con la Nota 1 incumplida no se aprueba. */
  async aprobar(inspeccionId: string, actor: ActorInspeccion) {
    return this.prisma.$transaction(async (tx) => {
      const i = await this.paraRevisar(tx, inspeccionId);
      if (i.revisiones[0]?.decision === 'aprobada') {
        throw new ConflictException({
          message: 'La inspección ya está aprobada',
          code: 'inspeccion_ya_aprobada',
        });
      }
      const bloqueante = i.resultados.find(
        (r) => r.resultado === 'no_cumple' && r.item.bloqueaSiNoCumple,
      );
      if (bloqueante) {
        throw new ConflictException({
          message: `«${bloqueante.item.etiqueta}» no cumple: según la Nota 1 del formato el vehículo no puede usarse y la inspección no se aprueba`,
          code: 'nota_1_bloquea_uso',
        });
      }
      await tx.inspeccionVehiculoRevision.create({
        data: { id: uuidv7(), inspeccionId, decision: 'aprobada', revisadaPor: actor.id },
      });
      await this.publicar(tx, 'aprobada', inspeccionId, actor, this.base(i));
      return { id: inspeccionId, estado: 'aprobada' as const };
    });
  }

  /** Rechazo del Supervisor: deja la revisión y anula la inspección, para que se repita. */
  async rechazar(inspeccionId: string, motivo: string, actor: ActorInspeccion) {
    return this.prisma.$transaction(async (tx) => {
      const i = await this.paraRevisar(tx, inspeccionId);
      await tx.inspeccionVehiculoRevision.create({
        data: {
          id: uuidv7(),
          inspeccionId,
          decision: 'rechazada',
          motivo: motivo.trim(),
          revisadaPor: actor.id,
        },
      });
      await tx.inspeccionVehiculo.update({
        where: { id: inspeccionId },
        data: {
          anuladaAt: new Date(),
          anuladaPor: actor.id,
          anulacionMotivo: `Rechazada por el Supervisor: ${motivo.trim()}`,
        },
      });
      // Dos hechos: el Supervisor la rechazó (reabre «aprobada») y quedó anulada (reabre «realizada»).
      await this.publicar(tx, 'rechazada', inspeccionId, actor, this.base(i));
      if (i.momento === 'salida')
        await this.publicar(tx, 'anulada', inspeccionId, actor, this.base(i));
      return { id: inspeccionId, estado: 'rechazada' as const };
    });
  }

  /** Anulación por error de registro. Una inspección aprobada se rechaza primero (la firma del Supervisor no se pasa por alto). */
  async anular(inspeccionId: string, motivo: string, actor: ActorInspeccion) {
    return this.prisma.$transaction(async (tx) => {
      const i = await this.paraRevisar(tx, inspeccionId);
      if (i.revisiones[0]?.decision === 'aprobada') {
        throw new ConflictException({
          message: 'La inspección está aprobada: el Supervisor debe rechazarla antes de anularla',
          code: 'inspeccion_aprobada',
        });
      }
      await tx.inspeccionVehiculo.update({
        where: { id: inspeccionId },
        data: { anuladaAt: new Date(), anuladaPor: actor.id, anulacionMotivo: motivo.trim() },
      });
      if (i.momento === 'salida')
        await this.publicar(tx, 'anulada', inspeccionId, actor, this.base(i));
      return { id: inspeccionId, anulada: true };
    });
  }

  async obtener(id: string) {
    const i = await this.prisma.inspeccionVehiculo.findUnique({
      where: { id },
      include: {
        unidad: {
          select: {
            id: true,
            codigo: true,
            nombre: true,
            fechaMatricula: true,
            caducidadMatricula: true,
            caducidadPoliza: true,
            vigenciaOtroDocumento: true,
            vehiculo: { select: { placa: true, marca: true, modelo: true, anio: true } },
          },
        },
        caso: {
          select: { id: true, ticketId: true, operador: { select: { id: true, nombre: true } } },
        },
        conductor: { select: { id: true, nombre: true } },
        registrador: { select: { id: true, nombre: true } },
        anulador: { select: { id: true, nombre: true } },
        lectura: { select: { valor: true, leidaAt: true } },
        resultados: { include: { item: true } },
        revisiones: {
          orderBy: { revisadaAt: 'desc' },
          include: { revisor: { select: { id: true, nombre: true } } },
        },
      },
    });
    if (!i) throw new NotFoundException('La inspección no existe');
    return {
      id: i.id,
      momento: i.momento,
      fecha: i.fecha,
      puntoPartida: i.puntoPartida,
      destino: i.destino,
      observaciones: i.observaciones,
      km: i.lectura ? Number(i.lectura.valor) : null,
      unidad: {
        id: i.unidad.id,
        codigo: i.unidad.codigo,
        nombre: i.unidad.nombre,
        vehiculo: i.unidad.vehiculo,
        documentos: {
          fechaMatricula: i.unidad.fechaMatricula ? SOLO_DIA(i.unidad.fechaMatricula) : null,
          caducidadMatricula: i.unidad.caducidadMatricula
            ? SOLO_DIA(i.unidad.caducidadMatricula)
            : null,
          caducidadPoliza: i.unidad.caducidadPoliza ? SOLO_DIA(i.unidad.caducidadPoliza) : null,
          vigenciaOtroDocumento: i.unidad.vigenciaOtroDocumento
            ? SOLO_DIA(i.unidad.vigenciaOtroDocumento)
            : null,
        },
      },
      caso: i.caso,
      conductor: i.conductor,
      registradaPor: i.registrador,
      registradaAt: i.createdAt,
      anulada: i.anuladaAt ? { at: i.anuladaAt, por: i.anulador, motivo: i.anulacionMotivo } : null,
      estado: i.anuladaAt ? ('anulada' as const) : estadoDeSalida(i),
      hayNovedades: i.resultados.some((r) => r.resultado === 'no_cumple'),
      bloqueaUso: i.resultados.some((r) => r.resultado === 'no_cumple' && r.item.bloqueaSiNoCumple),
      resultados: i.resultados
        .map((r) => ({
          itemId: r.itemId,
          codigo: r.item.codigo,
          seccion: r.item.seccion,
          orden: r.item.orden,
          etiqueta: r.item.etiqueta,
          resultado: r.resultado,
        }))
        .sort((a, b) =>
          a.seccion === b.seccion ? a.orden - b.orden : a.seccion === 'vehiculo' ? -1 : 1,
        ),
      revisiones: i.revisiones.map((r) => ({
        decision: r.decision,
        motivo: r.motivo,
        por: r.revisor,
        at: r.revisadaAt,
      })),
    };
  }

  /** Inspecciones, de la más reciente a la más antigua; por omisión sin las anuladas. */
  async listar(f: {
    ticketId?: string;
    unidadId?: string;
    conductorId?: string;
    momento?: MomentoInspeccion;
    incluirAnuladas?: boolean;
    limite?: number;
  }) {
    const filas = await this.prisma.inspeccionVehiculo.findMany({
      where: {
        ...(f.ticketId ? { caso: { ticketId: f.ticketId } } : {}),
        ...(f.unidadId ? { unidadId: f.unidadId } : {}),
        ...(f.conductorId ? { conductorId: f.conductorId } : {}),
        ...(f.momento ? { momento: f.momento } : {}),
        ...(f.incluirAnuladas ? {} : { anuladaAt: null }),
      },
      include: {
        unidad: { select: { id: true, codigo: true, nombre: true } },
        conductor: { select: { id: true, nombre: true } },
        lectura: { select: { valor: true } },
        resultados: { select: { resultado: true } },
        revisiones: { orderBy: { revisadaAt: 'desc' }, take: 1 },
        caso: { select: { ticketId: true } },
      },
      orderBy: { fecha: 'desc' },
      take: Math.min(Math.max(f.limite ?? 100, 1), 300),
    });
    return filas.map((i) => ({
      id: i.id,
      momento: i.momento,
      fecha: i.fecha,
      unidad: i.unidad,
      conductor: i.conductor,
      ticketId: i.caso?.ticketId ?? null,
      km: i.lectura ? Number(i.lectura.valor) : null,
      hayNovedades: i.resultados.some((r) => r.resultado === 'no_cumple'),
      estado: i.anuladaAt ? ('anulada' as const) : estadoDeSalida(i),
    }));
  }

  /** Casos de un ticket con el estado de la inspección de cada unidad (salida) y si ya hay la de llegada. */
  async casosDeTicket(ticketId: string) {
    return this.casos({ ticketId });
  }

  /** Casos asignados a una cuenta (el operador emparejado con la unidad), de los últimos 60 días. */
  async casosDeOperador(operadorId: string) {
    return this.casos({
      operadorId,
      createdAt: { gte: new Date(Date.now() - 60 * 86_400_000) },
    });
  }

  private async casos(where: Prisma.InspeccionCasoWhereInput) {
    const casos = await this.prisma.inspeccionCaso.findMany({
      where,
      include: {
        unidad: {
          select: {
            id: true,
            codigo: true,
            nombre: true,
            vehiculo: { select: { id: true, placa: true } },
          },
        },
        operador: { select: { id: true, nombre: true } },
        inspecciones: {
          where: { anuladaAt: null },
          include: { revisiones: { orderBy: { revisadaAt: 'desc' }, take: 1 } },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return casos.map((c) => {
      const salida = c.inspecciones.find((i) => i.momento === 'salida') ?? null;
      const llegada = c.inspecciones.find((i) => i.momento === 'llegada') ?? null;
      return {
        id: c.id,
        ticketId: c.ticketId,
        unidad: c.unidad,
        operador: c.operador,
        estado: estadoDeSalida(salida),
        salidaInspeccionId: salida?.id ?? null,
        llegadaInspeccionId: llegada?.id ?? null,
      };
    });
  }

  private async paraRevisar(tx: Prisma.TransactionClient, id: string) {
    const i = await tx.inspeccionVehiculo.findUnique({
      where: { id },
      include: {
        caso: { select: { ticketId: true } },
        unidad: { select: { vehiculoId: true } },
        resultados: { include: { item: { select: { etiqueta: true, bloqueaSiNoCumple: true } } } },
        revisiones: { orderBy: { revisadaAt: 'desc' }, take: 1 },
      },
    });
    if (!i) throw new NotFoundException('La inspección no existe');
    if (i.anuladaAt) {
      throw new ConflictException({
        message: 'La inspección está anulada',
        code: 'inspeccion_anulada',
      });
    }
    return i;
  }

  private base(i: {
    id: string;
    casoId: string | null;
    unidadId: string;
    caso: { ticketId: string } | null;
    unidad: { vehiculoId: string | null };
  }) {
    return {
      inspeccionId: i.id,
      casoId: i.casoId,
      ticketId: i.caso?.ticketId ?? null,
      unidadId: i.unidadId,
      vehiculoId: i.unidad.vehiculoId,
    };
  }

  private publicar(
    tx: Prisma.TransactionClient,
    hecho: 'registrada' | 'realizada' | 'anulada' | 'aprobada' | 'rechazada',
    inspeccionId: string,
    actor: ActorInspeccion,
    data: Record<string, unknown>,
  ) {
    return this.bus.publish(
      tx,
      createEvent({
        type: `flota.inspeccion_vehiculo.${hecho}`,
        source: 'flota',
        subject: { type: 'flota_inspeccion_vehiculo', id: inspeccionId },
        data,
        actor: { userId: actor.id, role: actor.roleCode },
        traceparent: currentTraceparent(),
      }),
    );
  }
}
