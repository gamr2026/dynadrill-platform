import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { currentTraceparent, type AuthUser } from '@dyn/common';
import { EventBus } from '@dyn/messaging';
import { uuidv7 } from '@dyn/utils';
import { REQ } from '../catalog/sembrar-pasos';
import { PrismaService } from '../prisma/prisma.service';
import { exigirFecha } from './bitacora.service';
import { RequisitosService } from './requisitos.service';
import { TicketsService } from './tickets.service';

const PASO = 'control_retorno';

export interface LlegadaEntrada {
  /** Día de la llegada (`AAAA-MM-DD`). */
  fecha: string;
  combustible: number;
  novedadesMecanica?: string;
  novedadesInstrumentacion?: string;
  novedadesOperaciones?: string;
  unidadLista: boolean;
  operacionInterrumpida: boolean;
  detalleInterrupcion?: string;
}

const num = (d: { toString(): string } | null) => (d === null ? null : Number(d));
const limpio = (v: string | undefined) => v?.trim() || null;

/**
 * Reporte de unidad de llegada (DYN-MNT-RE-012): uno por ticket y unidad, que firma el operador asignado a esa unidad en el control de
 * retorno (el paso lo atiende Bodega, pero el reporte es del operador). Es inmutable. Al firmarlo cumple el requisito de su unidad y se
 * publica `operaciones.fcr.reporte_unidad_llegada` para que Mantenimiento reciba el reporte (contrato 4.2).
 */
@Injectable()
export class ReporteUnidadLlegadaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: EventBus,
    private readonly tickets: TicketsService,
    private readonly requisitos: RequisitosService,
  ) {}

  /** Las unidades del ticket con su operador y si ya firmaron la llegada. */
  async listar(ticketId: string) {
    if (!(await this.prisma.ticket.findUnique({ where: { id: ticketId }, select: { id: true } })))
      throw new NotFoundException('El ticket no existe');
    const [unidades, personas, reportes] = await Promise.all([
      this.prisma.ticketUnidad.findMany({
        where: { ticketId },
        include: { vehiculo: true },
        orderBy: { vehiculo: { placa: 'asc' } },
      }),
      this.prisma.ticketPersona.findMany({
        where: { ticketId, rol: 'operador' },
        include: { usuario: true },
      }),
      this.prisma.reporteUnidadLlegada.findMany({
        where: { ticketId },
        include: { firmante: { select: { nombre: true } } },
      }),
    ]);
    return unidades.map((u) => {
      const r = reportes.find((x) => x.vehiculoId === u.vehiculoId);
      const o = personas.find((p) => p.vehiculoId === u.vehiculoId);
      return {
        vehiculoId: u.vehiculoId,
        placa: u.vehiculo.placa,
        operador: o ? { usuarioId: o.usuarioId, nombre: o.usuario.nombre } : null,
        reporte: r
          ? {
              id: r.id,
              fecha: r.llegadaFecha.toISOString().slice(0, 10),
              combustible: num(r.combustible),
              novedadesMecanica: r.novedadesMecanica,
              novedadesInstrumentacion: r.novedadesInstrumentacion,
              novedadesOperaciones: r.novedadesOperaciones,
              unidadLista: r.unidadLista,
              operacionInterrumpida: r.operacionInterrumpida,
              detalleInterrupcion: r.detalleInterrupcion,
              firmadaPor: r.firmante.nombre,
              firmadaAt: r.firmadaAt,
            }
          : null,
      };
    });
  }

  /** El operador de la unidad llena y firma el reporte de llegada. */
  async firmar(ticketId: string, vehiculoId: string, e: LlegadaEntrada, actor: AuthUser) {
    exigirFecha(e.fecha);
    if (e.operacionInterrumpida && !e.detalleInterrupcion?.trim())
      throw new BadRequestException('Explique por qué se interrumpió la operación');
    await this.prisma.$transaction(async (tx) => {
      const t = await this.tickets.cargarEnTx(tx, ticketId);
      if (t.pasoCodigo !== PASO) {
        throw new ConflictException('El reporte de llegada se firma en el «Control de retorno»');
      }
      if (!t.unidades.some((u) => u.vehiculoId === vehiculoId)) {
        throw new NotFoundException('Esa unidad no está asignada al ticket');
      }
      const operador = t.personas.find((p) => p.rol === 'operador' && p.vehiculoId === vehiculoId);
      if (actor.roleCode !== 'superadmin' && operador?.usuarioId !== actor.id) {
        throw new ForbiddenException(
          'Solo el operador asignado a esta unidad firma su reporte de llegada',
        );
      }
      if (
        await tx.reporteUnidadLlegada.findUnique({
          where: { ticketId_vehiculoId: { ticketId, vehiculoId } },
          select: { id: true },
        })
      ) {
        throw new ConflictException('El reporte de llegada de esta unidad ya está firmado');
      }
      const id = uuidv7();
      const novedades = [
        limpio(e.novedadesMecanica),
        limpio(e.novedadesInstrumentacion),
        limpio(e.novedadesOperaciones),
      ];
      await tx.reporteUnidadLlegada.create({
        data: {
          id,
          ticketId,
          vehiculoId,
          llegadaFecha: new Date(`${e.fecha}T00:00:00.000Z`),
          combustible: e.combustible,
          novedadesMecanica: novedades[0],
          novedadesInstrumentacion: novedades[1],
          novedadesOperaciones: novedades[2],
          unidadLista: e.unidadLista,
          operacionInterrumpida: e.operacionInterrumpida,
          detalleInterrupcion: e.operacionInterrumpida ? limpio(e.detalleInterrupcion) : null,
          firmadaPor: actor.id,
        },
      });
      await this.requisitos.marcar(
        tx,
        { ticketId, codigo: REQ.reporteUnidadLlegada, vehiculoId },
        'sistema',
        actor.id,
      );
      await this.bus.publish(
        tx,
        this.bus.create({
          type: 'operaciones.fcr.reporte_unidad_llegada',
          subject: { type: 'fcr_ticket', id: ticketId },
          data: {
            ticketId,
            vehiculoId,
            reporteUnidadId: id,
            hayNovedades: novedades.some(Boolean) || !e.unidadLista || e.operacionInterrumpida,
            pedidoId: t.pedidoId,
            ticketNumero: t.ticketNumero,
          },
          actor: { userId: actor.id, role: actor.roleCode },
          traceparent: currentTraceparent(),
        }),
      );
    });
    return this.listar(ticketId);
  }
}
