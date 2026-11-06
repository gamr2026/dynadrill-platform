import { Injectable } from '@nestjs/common';
import type { AuthUser } from '@dyn/common';
import { PrismaService } from '../prisma/prisma.service';

/** Pasos del ticket de Pumping en los que la unidad sale, trabaja o regresa: el conductor tiene traslados que cumplir. */
const PASOS_ACTIVOS = [
  'traslado_salida',
  'revision_reportes_salida',
  'ejecucion_operativa',
  'control_retorno',
  'traslado_llegada',
];

export interface TareaConductor {
  clave: 'inspeccion_salida' | 'viaje_salida' | 'inspeccion_llegada' | 'viaje_retorno';
  titulo: string;
  detalle: string | null;
  estado: 'hecha' | 'pendiente';
  tono: 'ok' | 'warn';
  ticketId: string;
  /** Ruta del portal donde se resuelve. */
  enlace: string;
}

const diaEcuador = (d: Date = new Date()) =>
  new Date(d.getTime() - 5 * 3_600_000).toISOString().slice(0, 10);
const aDia = (d: Date) => d.toISOString().slice(0, 10);

/**
 * «Mis traslados de hoy» del Conductor: los equipos regresan a base cada día, así que cada día del servicio tiene su inspección del vehículo y su
 * gerenciamiento de viaje de salida y de regreso. Muestra, por cada unidad que lleva en un servicio activo cuyo día de hoy es de servicio, lo que
 * ya hizo y lo que le falta.
 */
@Injectable()
export class TareasHoyConductorService {
  constructor(private readonly prisma: PrismaService) {}

  async delUsuario(actor: AuthUser, hoy: string = diaEcuador()) {
    const casos = await this.prisma.inspeccionCaso.findMany({
      where: { operadorId: actor.id, ticket: { pasoCodigo: { in: PASOS_ACTIVOS } } },
      include: {
        ticket: true,
        unidad: { select: { codigo: true, vehiculo: { select: { placa: true } } } },
        inspecciones: {
          where: { anuladaAt: null, diaServicio: new Date(`${hoy}T00:00:00Z`) },
          select: { momento: true },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
    const bloques = [];
    for (const c of casos) {
      const t = c.ticket;
      // hoy debe ser un día del servicio (si el ticket no trae fechas, se muestra)
      if (
        (t.fechaInicioServicio && hoy < aDia(t.fechaInicioServicio)) ||
        (t.fechaFinServicio && hoy > aDia(t.fechaFinServicio))
      )
        continue;
      const viajes = await this.prisma.gerenciamientoViaje.findMany({
        where: {
          ticketId: t.id,
          unidadId: c.unidadId,
          fecha: new Date(`${hoy}T00:00:00Z`),
          OR: [{ decision: null }, { decision: 'autorizado' }],
        },
        select: { tipo: true, decision: true },
      });
      const placa = c.unidad.vehiculo?.placa ?? c.unidad.codigo;
      const enlace = `/modulos/operativo/pumping/pedidos/${t.id}`;
      const inspeccion = (momento: 'salida' | 'llegada') =>
        c.inspecciones.some((i) => i.momento === momento);
      const viaje = (tipo: 'salida' | 'retorno') => viajes.find((v) => v.tipo === tipo);
      const tarea = (
        clave: TareaConductor['clave'],
        titulo: string,
        hecha: boolean,
        detalle: string | null,
      ): TareaConductor => ({
        clave,
        titulo,
        detalle: hecha ? null : detalle,
        estado: hecha ? 'hecha' : 'pendiente',
        tono: hecha ? 'ok' : 'warn',
        ticketId: t.id,
        enlace,
      });
      const decidido = (tipo: 'salida' | 'retorno') => viaje(tipo)?.decision === 'autorizado';
      const detalleViaje = (tipo: 'salida' | 'retorno') =>
        viaje(tipo)
          ? 'Solicitado: espera la autorización'
          : `Falta solicitar el gerenciamiento de viaje de ${tipo === 'salida' ? 'salida' : 'retorno'}`;
      const tareas = [
        tarea(
          'inspeccion_salida',
          `Inspección del vehículo ${placa} antes de salir`,
          inspeccion('salida'),
          'Hágala antes de salir de la base',
        ),
        tarea(
          'viaje_salida',
          'Traslado de salida: base → locación',
          decidido('salida'),
          detalleViaje('salida'),
        ),
        tarea(
          'inspeccion_llegada',
          `Inspección del vehículo ${placa} para el regreso`,
          inspeccion('llegada'),
          'Hágala antes de salir de la locación',
        ),
        tarea(
          'viaje_retorno',
          'Traslado de regreso: locación → base',
          decidido('retorno'),
          detalleViaje('retorno'),
        ),
      ];
      bloques.push({
        rol: 'conductor' as const,
        ticketId: t.id,
        ticketNumero: t.ticketNumero,
        titulo: `Conductor · Mis traslados de hoy · Ticket ${t.ticketNumero ?? 's/n'} · ${placa}`,
        jornada: null,
        pendientes: tareas.filter((x) => x.estado !== 'hecha').length,
        tareas,
      });
    }
    return {
      fecha: hoy,
      pendientes: bloques.reduce((s, b) => s + b.pendientes, 0),
      bloques,
    };
  }
}
