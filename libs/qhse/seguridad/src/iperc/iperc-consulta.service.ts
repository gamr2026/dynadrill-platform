import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { AuthUser } from '@dyn/common';
import type { Tx } from '../epi/epi-tipos';
import { EstadoIperc } from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';
import { aDia, aFecha, diasHasta, hoyEcuador } from '../comun/fechas';
import { requisitosIperc } from '../ptw/ptw-iperc';
import { valorar } from './gtc45';

/** Consecutivo visible de la matriz: IPERC-000001. */
export const codigoIperc = (numero: number): string => `IPERC-${String(numero).padStart(6, '0')}`;

const dia = (d: Date | null): string | null => (d ? aDia(d) : null);

/** Avisa 30 días antes de que venza la vigencia de 12 meses. */
export const AVISO_VENCIMIENTO_DIAS = 30;

/** Lectura de la matriz maestra: actividades con su estado y vigencia, detalle de una matriz con la valoración GTC 45 y la cobertura. */
@Injectable()
export class IpercConsultaService {
  constructor(private readonly prisma: PrismaService) {}

  /** Actividades de la matriz maestra con su matriz aprobada (y si venció) y la versión en trabajo, si la hay. */
  async actividades(filtro: { q?: string; procesoId?: string; zonaId?: string } = {}) {
    const q = filtro.q?.trim();
    const filas = await this.prisma.ipercActividad.findMany({
      where: {
        ...(filtro.procesoId ? { procesoId: filtro.procesoId } : {}),
        ...(filtro.zonaId ? { zonaId: filtro.zonaId } : {}),
        ...(q ? { nombre: { contains: q, mode: 'insensitive' } } : {}),
      },
      orderBy: [{ proceso: { orden: 'asc' } }, { nombre: 'asc' }],
      include: {
        proceso: { select: { id: true, nombre: true } },
        zona: { select: { id: true, nombre: true } },
        matrices: {
          where: { estado: { not: EstadoIperc.reemplazada } },
          select: {
            id: true,
            numero: true,
            version: true,
            estado: true,
            aprobadaEl: true,
            vigenteHasta: true,
          },
        },
        cobertura: { select: { tipoServicioCodigo: true } },
      },
    });
    return filas.map((a) => {
      const aprobada = a.matrices.find((m) => m.estado === EstadoIperc.aprobada);
      const enTrabajo = a.matrices.find((m) => m.estado !== EstadoIperc.aprobada);
      const hasta = dia(aprobada?.vigenteHasta ?? null);
      const faltan = hasta ? diasHasta(hasta) : null;
      return {
        id: a.id,
        nombre: a.nombre,
        activo: a.activo,
        proceso: a.proceso,
        zona: a.zona,
        tiposServicio: a.cobertura.map((c) => c.tipoServicioCodigo).sort(),
        aprobada: aprobada
          ? {
              matrizId: aprobada.id,
              codigo: codigoIperc(aprobada.numero),
              version: aprobada.version,
              aprobadaEl: dia(aprobada.aprobadaEl),
              vigenteHasta: hasta,
              venceEnDias: faltan,
              vencida: faltan !== null && faltan < 0,
              porVencer: faltan !== null && faltan >= 0 && faltan <= AVISO_VENCIMIENTO_DIAS,
            }
          : null,
        enTrabajo: enTrabajo
          ? {
              matrizId: enTrabajo.id,
              codigo: codigoIperc(enTrabajo.numero),
              version: enTrabajo.version,
              estado: enTrabajo.estado,
            }
          : null,
      };
    });
  }

  /** Una matriz completa: tareas, peligros con su valoración calculada, controles, adjuntos, aprobación e historial. */
  async matriz(id: string) {
    const m = await this.prisma.ipercMatriz.findUnique({
      where: { id },
      include: {
        actividad: {
          include: {
            proceso: { select: { id: true, nombre: true } },
            zona: { select: { id: true, nombre: true } },
          },
        },
        evaluadores: { include: { usuario: { select: { id: true, nombre: true } } } },
        aprobador: { select: { nombre: true } },
        rechazador: { select: { nombre: true } },
        creador: { select: { nombre: true } },
        historial: {
          include: { actor: { select: { nombre: true } } },
          orderBy: { createdAt: 'asc' },
        },
        tareas: {
          orderBy: { orden: 'asc' },
          include: {
            cargos: { include: { cargo: { select: { id: true, nombre: true } } } },
            peligros: {
              orderBy: { orden: 'asc' },
              include: {
                clasificacion: { select: { id: true, nombre: true } },
                generadoEn: { select: { id: true, nombre: true } },
                controles: { orderBy: { tipo: 'asc' } },
              },
            },
          },
        },
      },
    });
    if (!m) throw new NotFoundException('La matriz no existe');
    const hasta = dia(m.vigenteHasta);
    const faltan = hasta && m.estado === EstadoIperc.aprobada ? diasHasta(hasta) : null;
    return {
      id: m.id,
      numero: m.numero,
      codigo: codigoIperc(m.numero),
      version: m.version,
      estado: m.estado,
      actividad: {
        id: m.actividad.id,
        nombre: m.actividad.nombre,
        proceso: m.actividad.proceso,
        zona: m.actividad.zona,
      },
      equipoEvaluador: m.evaluadores.map((e) => e.usuario),
      procedimientoArchivoId: m.procedimientoArchivoId,
      atsArchivoId: m.atsArchivoId,
      aprobadaPor: m.aprobador?.nombre ?? null,
      aprobadaAt: m.aprobadaAt,
      aprobadaEl: dia(m.aprobadaEl),
      vigenteHasta: hasta,
      venceEnDias: faltan,
      vencida: faltan !== null && faltan < 0,
      porVencer: faltan !== null && faltan >= 0 && faltan <= AVISO_VENCIMIENTO_DIAS,
      rechazadaPor: m.rechazador?.nombre ?? null,
      rechazadaAt: m.rechazadaAt,
      motivoRechazo: m.motivoRechazo,
      origenTicketId: m.origenTicketId,
      creadaPor: m.creador.nombre,
      createdAt: m.createdAt,
      tareas: m.tareas.map((t) => ({
        id: t.id,
        orden: t.orden,
        descripcion: t.descripcion,
        rutinaria: t.rutinaria,
        areaPuesto: t.areaPuesto,
        cargos: t.cargos.map((c) => c.cargo),
        peligros: t.peligros.map((p) => ({
          id: p.id,
          orden: p.orden,
          descripcion: p.descripcion,
          clasificacion: p.clasificacion,
          fuenteRiesgo: p.fuenteRiesgo,
          generadoEn: p.generadoEn,
          efectosPosibles: p.efectosPosibles,
          controlExistenteFuente: p.controlExistenteFuente,
          controlExistenteMedio: p.controlExistenteMedio,
          controlExistenteIndividuo: p.controlExistenteIndividuo,
          numeroExpuestos: p.numeroExpuestos,
          peorConsecuencia: p.peorConsecuencia,
          requisitoLegal: p.requisitoLegal,
          seguimiento: p.seguimiento,
          seguimientoResidual: p.seguimientoResidual,
          inicial: valorar(p.inicialNd, p.inicialNe, p.inicialNc),
          residual: valorar(p.residualNd, p.residualNe, p.residualNc),
          controles: p.controles.map((c) => ({
            id: c.id,
            momento: c.momento,
            tipo: c.tipo,
            descripcion: c.descripcion,
          })),
        })),
      })),
      historial: m.historial.map((h) => ({
        estadoAnterior: h.estadoAnterior,
        estadoNuevo: h.estadoNuevo,
        motivo: h.motivo,
        actor: h.actor.nombre,
        at: h.createdAt,
      })),
    };
  }

  /** Versiones de una actividad (la más reciente primero). */
  async versiones(actividadId: string) {
    const filas = await this.prisma.ipercMatriz.findMany({
      where: { actividadId },
      orderBy: { version: 'desc' },
      select: {
        id: true,
        numero: true,
        version: true,
        estado: true,
        aprobadaEl: true,
        vigenteHasta: true,
      },
    });
    return filas.map((m) => ({
      id: m.id,
      codigo: codigoIperc(m.numero),
      version: m.version,
      estado: m.estado,
      aprobadaEl: dia(m.aprobadaEl),
      vigenteHasta: dia(m.vigenteHasta),
    }));
  }

  /** Cobertura: para cada tipo de servicio, las actividades de la matriz maestra que exige. */
  /**
   * Cobertura IPERC de un ticket (para el banner del ticket de FCR): por cada actividad que exigen los tipos de servicio del ticket, la matriz
   * aprobada y vigente el día indicado (hoy por defecto) o por qué falta. Un ticket sin tipos de servicio con cobertura devuelve lista vacía
   * y `coberturaOk = true`. El ticket es de otro contenedor: se conoce por sus servicios (`ticket_servicio`), sin FK.
   */
  async coberturaDeTicket(ticketId: string, diaTexto?: string) {
    const dia = diaTexto ?? hoyEcuador();
    const requisitos = await requisitosIperc(this.prisma, ticketId, aFecha(dia));
    return { ticketId, dia, requisitos, coberturaOk: requisitos.every((r) => r.falta === null) };
  }

  async cobertura() {
    const filas = await this.prisma.ipercCobertura.findMany({
      include: { actividad: { select: { id: true, nombre: true } } },
    });
    const mapa: Record<string, Array<{ id: string; nombre: string }>> = {};
    for (const f of filas) (mapa[f.tipoServicioCodigo] ??= []).push(f.actividad);
    for (const k of Object.keys(mapa))
      mapa[k].sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
    return mapa;
  }

  /**
   * Códigos de tipo de servicio que QHSE conoce: los de los tickets que le llegaron y los que ya tienen cobertura. Los nombres viven en
   * comercial (otro contenedor): la pantalla los pone con el catálogo de servicios y, si no puede leerlo, muestra el código.
   */
  async tiposDeServicioConocidos(): Promise<string[]> {
    const [deTickets, deCobertura] = await Promise.all([
      this.prisma.ticketServicio.findMany({
        distinct: ['tipoCodigo'],
        select: { tipoCodigo: true },
      }),
      this.prisma.ipercCobertura.findMany({
        distinct: ['tipoServicioCodigo'],
        select: { tipoServicioCodigo: true },
      }),
    ]);
    return [
      ...new Set([
        ...deTickets.map((t) => t.tipoCodigo),
        ...deCobertura.map((c) => c.tipoServicioCodigo),
      ]),
    ].sort();
  }

  /** Reemplaza las actividades que exige un tipo de servicio (código de comercial). */
  async fijarCobertura(tipoCodigo: string, actividadIds: string[], actor: AuthUser) {
    const codigo = tipoCodigo.trim();
    if (!codigo) throw new BadRequestException('Indique el tipo de servicio');
    const ids = [...new Set(actividadIds)];
    await this.prisma.$transaction(async (tx) => {
      if (
        ids.length &&
        (await tx.ipercActividad.count({ where: { id: { in: ids }, activo: true } })) !== ids.length
      )
        throw new BadRequestException('Una de las actividades no existe o está inactiva');
      await tx.ipercCobertura.deleteMany({ where: { tipoServicioCodigo: codigo } });
      if (ids.length)
        await tx.ipercCobertura.createMany({
          data: ids.map((actividadId) => ({
            tipoServicioCodigo: codigo,
            actividadId,
            createdBy: actor.id,
          })),
        });
    });
    return this.cobertura();
  }
}

/** Para que otros servicios del módulo (PTW) lean la cobertura dentro de su transacción. */
export type TxIperc = Pick<Tx, 'ipercCobertura' | 'ticketServicio' | 'ipercMatriz'>;
