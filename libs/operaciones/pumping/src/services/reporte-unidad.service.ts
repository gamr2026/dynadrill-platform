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
import { REQ } from '../catalog/sembrar-traslado-salida';
import type {
  Prisma,
  PosicionLlanta,
  PuntoHubodometro,
  ResultadoInspeccion,
} from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';
import { RequisitosService } from './requisitos.service';
import { UNIDAD_CON_PLACA } from './unidad-etiqueta';

const PASO = 'traslado_salida';
const PASO_LLEGADA = 'traslado_llegada';

export interface LlegadaEntrada {
  /** Día de la llegada (`AAAA-MM-DD`). */
  fecha: string;
  combustible: number;
  hubodometros: Array<{ eje: string; punto: PuntoHubodometro; llegada: number | null }>;
  llantas: Array<{ posicion: PosicionLlanta; llegada: string | null }>;
  inspecciones: Array<{ itemId: string; resultado: ResultadoInspeccion }>;
  novedadesMecanica?: string;
  novedadesInstrumentacion?: string;
  novedadesOperaciones?: string;
  unidadLista: boolean;
  operacionInterrumpida: boolean;
  detalleInterrupcion?: string;
}

export interface SalidaEntrada {
  /** Día de la salida (`AAAA-MM-DD`). */
  fecha: string;
  combustible: number;
  origen: string;
  destino: string;
  hubodometros: Array<{ eje: string; punto: PuntoHubodometro; salida: number | null }>;
  llantas: Array<{ posicion: PosicionLlanta; salida: string | null }>;
  inspecciones: Array<{ itemId: string; resultado: ResultadoInspeccion }>;
}

const num = (d: Prisma.Decimal | null) => (d === null ? null : Number(d));

/**
 * Reporte de unidad (DYN-MNT-RE-012): uno por ticket y unidad. Aquí se registra la SALIDA, que firma el operador asignado a esa unidad
 * al guardarla. Solo se puede guardar cuando los demás requisitos del traslado de salida ya están cumplidos (es la firma final del
 * traslado). Al guardarla cumple el requisito `reporte_unidad_salida` de la unidad. La llegada se agrega en Traslado de llegada.
 */
@Injectable()
export class ReporteUnidadService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly requisitos: RequisitosService,
    private readonly bus: EventBus,
  ) {}

  /** Las unidades del ticket con su operador y si el reporte de salida ya está firmado. */
  async listar(ticketId: string) {
    const [unidades, personas, reportes] = await Promise.all([
      this.prisma.ticketUnidad.findMany({
        where: { ticketId },
        include: { unidad: UNIDAD_CON_PLACA },
        orderBy: { unidad: { codigo: 'asc' } },
      }),
      this.prisma.ticketPersona.findMany({
        where: { ticketId, rol: 'operador' },
        include: { usuario: true },
      }),
      this.prisma.reporteUnidad.findMany({ where: { ticketId } }),
    ]);
    return unidades.map((u) => {
      const r = reportes.find((x) => x.unidadId === u.unidadId);
      const o = personas.find((p) => p.unidadId === u.unidadId);
      return {
        unidadId: u.unidadId,
        codigo: u.unidad.codigo,
        nombre: u.unidad.nombre,
        // la placa del vehículo enlazado a la unidad (nula si no tiene); para nombrarla en pantalla: `placa ?? codigo`
        placa: u.unidad.vehiculo?.placa ?? null,
        operador: o ? { usuarioId: o.usuarioId, nombre: o.usuario.nombre } : null,
        salidaFirmada: !!r?.salidaFirmadaAt,
        salidaFirmadaAt: r?.salidaFirmadaAt ?? null,
      };
    });
  }

  /** El reporte de una unidad (vacío si todavía no se llenó) con todos los ítems del formulario. */
  async obtener(ticketId: string, unidadId: string) {
    const unidad = await this.prisma.ticketUnidad.findUnique({
      where: { ticketId_unidadId: { ticketId, unidadId } },
      include: { unidad: UNIDAD_CON_PLACA },
    });
    if (!unidad) throw new NotFoundException('Esa unidad no está asignada al ticket');
    const [reporte, items, firmante] = await Promise.all([
      this.prisma.reporteUnidad.findUnique({
        where: { ticketId_unidadId: { ticketId, unidadId } },
        include: {
          hubodometros: { orderBy: [{ eje: 'asc' }, { punto: 'asc' }] },
          llantas: true,
          inspecciones: true,
        },
      }),
      this.prisma.inspeccionItem.findMany({
        where: { activo: true },
        orderBy: [{ seccion: 'asc' }, { orden: 'asc' }],
      }),
      this.prisma.ticketPersona.findFirst({
        where: { ticketId, unidadId, rol: 'operador' },
        include: { usuario: true },
      }),
    ]);
    const respuestas = new Map((reporte?.inspecciones ?? []).map((i) => [i.itemId, i]));
    const firmadoPor = reporte?.salidaFirmadaPor
      ? ((
          await this.prisma.idUsuario.findUnique({
            where: { id: reporte.salidaFirmadaPor },
            select: { nombre: true },
          })
        )?.nombre ?? null)
      : null;
    return {
      ticketId,
      unidadId,
      codigo: unidad.unidad.codigo,
      nombre: unidad.unidad.nombre,
      placa: unidad.unidad.vehiculo?.placa ?? null,
      operador: firmante
        ? { usuarioId: firmante.usuarioId, nombre: firmante.usuario.nombre }
        : null,
      origen: reporte?.origen ?? null,
      destino: reporte?.destino ?? null,
      salida: {
        fecha: reporte?.salidaFecha ? reporte.salidaFecha.toISOString().slice(0, 10) : null,
        combustible: num(reporte?.salidaCombustible ?? null),
        firmadaPor: firmadoPor,
        firmadaAt: reporte?.salidaFirmadaAt ?? null,
      },
      llegada: {
        fecha: reporte?.llegadaFecha ? reporte.llegadaFecha.toISOString().slice(0, 10) : null,
        combustible: num(reporte?.llegadaCombustible ?? null),
        novedadesMecanica: reporte?.novedadesMecanica ?? null,
        novedadesInstrumentacion: reporte?.novedadesInstrumentacion ?? null,
        novedadesOperaciones: reporte?.novedadesOperaciones ?? null,
        unidadLista: reporte?.unidadLista ?? null,
        operacionInterrumpida: reporte?.operacionInterrumpida ?? null,
        detalleInterrupcion: reporte?.detalleInterrupcion ?? null,
        firmadaAt: reporte?.llegadaFirmadaAt ?? null,
      },
      hubodometros: (reporte?.hubodometros ?? []).map((h) => ({
        eje: h.eje,
        punto: h.punto,
        salida: num(h.salida),
        llegada: num(h.llegada),
      })),
      llantas: (reporte?.llantas ?? []).map((l) => ({
        posicion: l.posicion,
        salida: l.salida,
        llegada: l.llegada,
      })),
      inspecciones: items.map((i) => ({
        itemId: i.id,
        seccion: i.seccion,
        etiqueta: i.etiqueta,
        salida: respuestas.get(i.id)?.salida ?? null,
        llegada: respuestas.get(i.id)?.llegada ?? null,
      })),
    };
  }

  async guardarSalida(ticketId: string, unidadId: string, e: SalidaEntrada, actor: AuthUser) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e.fecha) || Number.isNaN(Date.parse(`${e.fecha}T00:00:00Z`))) {
      throw new BadRequestException('La fecha de salida no es válida');
    }
    if (!Number.isFinite(e.combustible) || e.combustible < 0)
      throw new BadRequestException('El combustible debe ser un número mayor o igual a cero');
    const origen = e.origen?.trim();
    const destino = e.destino?.trim();
    if (!origen || !destino)
      throw new BadRequestException('Indique el origen y el destino del traslado');

    await this.prisma.$transaction(async (tx) => {
      const t = await tx.ticket.findUnique({ where: { id: ticketId }, include: { paso: true } });
      if (!t) throw new NotFoundException('El ticket no existe');
      if (t.pasoCodigo !== PASO)
        throw new ConflictException(
          'El reporte de salida se registra en el paso de Traslado de salida',
        );
      const unidad = await tx.ticketUnidad.findUnique({
        where: { ticketId_unidadId: { ticketId, unidadId } },
      });
      if (!unidad) throw new NotFoundException('Esa unidad no está asignada al ticket');
      if (actor.roleCode !== 'superadmin') {
        const op = await tx.ticketPersona.findFirst({
          where: { ticketId, unidadId, usuarioId: actor.id, rol: 'operador' },
        });
        if (!op)
          throw new ForbiddenException(
            'Solo el operador asignado a esta unidad puede firmar su reporte de salida',
          );
      }
      // el reporte es la firma final: antes deben estar cumplidos los demás requisitos del paso
      const faltan = await this.requisitos.pendientes(tx, ticketId, PASO, [REQ.reporteSalida]);
      if (faltan.length) {
        throw new ConflictException({
          message: `Antes de firmar el reporte de unidad falta: ${faltan.map((f) => f.texto).join('; ')}.`,
          code: 'REQUISITOS_PENDIENTES',
          pendientes: faltan,
        });
      }

      // ids de ítems válidos y sin repetir
      const items = await tx.inspeccionItem.findMany({
        where: { activo: true },
        select: { id: true },
      });
      const validos = new Set(items.map((i) => i.id));
      const vistos = new Set<string>();
      for (const i of e.inspecciones) {
        if (!validos.has(i.itemId))
          throw new BadRequestException('Alguno de los ítems de inspección no existe');
        if (vistos.has(i.itemId))
          throw new BadRequestException('Hay un ítem de inspección repetido');
        vistos.add(i.itemId);
      }
      const clavesHub = new Set<string>();
      for (const h of e.hubodometros) {
        const k = `${h.eje}|${h.punto}`;
        if (!/^[A-Z]$/.test(h.eje))
          throw new BadRequestException('El eje del hubodómetro debe ser una letra de la A a la Z');
        if (clavesHub.has(k))
          throw new BadRequestException('Hay una lectura de hubodómetro repetida');
        clavesHub.add(k);
      }
      if (new Set(e.llantas.map((l) => l.posicion)).size !== e.llantas.length)
        throw new BadRequestException('Hay una llanta repetida');

      const datos = {
        origen,
        destino,
        salidaFecha: new Date(`${e.fecha}T00:00:00.000Z`),
        salidaCombustible: e.combustible,
        salidaFirmadaPor: actor.id,
        salidaFirmadaAt: new Date(),
      };
      const reporte = await tx.reporteUnidad.upsert({
        where: { ticketId_unidadId: { ticketId, unidadId } },
        create: { id: uuidv7(), ticketId, unidadId, ...datos },
        update: datos,
      });
      await tx.reporteUnidadHubodometro.deleteMany({ where: { reporteId: reporte.id } });
      await tx.reporteUnidadLlanta.deleteMany({ where: { reporteId: reporte.id } });
      await tx.reporteUnidadInspeccion.deleteMany({ where: { reporteId: reporte.id } });
      await tx.reporteUnidadHubodometro.createMany({
        data: e.hubodometros.map((h) => ({
          reporteId: reporte.id,
          eje: h.eje,
          punto: h.punto,
          salida: h.salida,
        })),
      });
      await tx.reporteUnidadLlanta.createMany({
        data: e.llantas.map((l) => ({
          reporteId: reporte.id,
          posicion: l.posicion,
          salida: l.salida?.trim() || null,
        })),
      });
      await tx.reporteUnidadInspeccion.createMany({
        data: e.inspecciones.map((i) => ({
          reporteId: reporte.id,
          itemId: i.itemId,
          salida: i.resultado,
        })),
      });
      await this.requisitos.marcar(
        tx,
        { ticketId, codigo: REQ.reporteSalida, unidadId },
        'sistema',
        actor.id,
      );
    });
    return this.obtener(ticketId, unidadId);
  }

  /**
   * Firma de la LLEGADA de la unidad (Reporte de Unidad, DYN-MNT-RE-012): la firma el operador asignado a esa unidad en el paso
   * de Traslado de llegada, sobre el reporte de salida ya firmado. Al guardarla cumple el requisito `reporte_unidad_llegada` y
   * publica `operaciones.pumping.reporte_unidad_llegada` (contrato 4.2) en la misma transacción, para que Mantenimiento reciba
   * el reporte si hay novedades.
   */
  async guardarLlegada(ticketId: string, unidadId: string, e: LlegadaEntrada, actor: AuthUser) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e.fecha) || Number.isNaN(Date.parse(`${e.fecha}T00:00:00Z`))) {
      throw new BadRequestException('La fecha de llegada no es válida');
    }
    if (!Number.isFinite(e.combustible) || e.combustible < 0)
      throw new BadRequestException('El combustible debe ser un número mayor o igual a cero');
    const detalle = e.detalleInterrupcion?.trim() || null;
    if (e.operacionInterrumpida && !detalle)
      throw new BadRequestException('Indique el detalle de la interrupción de la operación');

    await this.prisma.$transaction(async (tx) => {
      const t = await tx.ticket.findUnique({ where: { id: ticketId } });
      if (!t) throw new NotFoundException('El ticket no existe');
      if (t.pasoCodigo !== PASO_LLEGADA)
        throw new ConflictException(
          'El reporte de llegada se registra en el paso de Traslado de llegada',
        );
      const asignada = await tx.ticketUnidad.findUnique({
        where: { ticketId_unidadId: { ticketId, unidadId } },
        include: { unidad: { select: { vehiculoId: true } } },
      });
      if (!asignada) throw new NotFoundException('Esa unidad no está asignada al ticket');
      if (actor.roleCode !== 'superadmin') {
        const op = await tx.ticketPersona.findFirst({
          where: { ticketId, unidadId, usuarioId: actor.id, rol: 'operador' },
        });
        if (!op)
          throw new ForbiddenException(
            'Solo el operador asignado a esta unidad puede firmar su reporte de llegada',
          );
      }
      const previo = await tx.reporteUnidad.findUnique({
        where: { ticketId_unidadId: { ticketId, unidadId } },
      });
      if (!previo?.salidaFirmadaAt)
        throw new ConflictException('La unidad no tiene un reporte de salida firmado');

      const items = await tx.inspeccionItem.findMany({
        where: { activo: true },
        select: { id: true },
      });
      const validos = new Set(items.map((i) => i.id));
      if (e.inspecciones.some((i) => !validos.has(i.itemId)))
        throw new BadRequestException('Alguno de los ítems de inspección no existe');
      if (new Set(e.inspecciones.map((i) => i.itemId)).size !== e.inspecciones.length)
        throw new BadRequestException('Hay un ítem de inspección repetido');
      if (new Set(e.llantas.map((l) => l.posicion)).size !== e.llantas.length)
        throw new BadRequestException('Hay una llanta repetida');
      if (new Set(e.hubodometros.map((h) => `${h.eje}|${h.punto}`)).size !== e.hubodometros.length)
        throw new BadRequestException('Hay una lectura de hubodómetro repetida');

      const reporte = await tx.reporteUnidad.update({
        where: { id: previo.id },
        data: {
          llegadaFecha: new Date(`${e.fecha}T00:00:00.000Z`),
          llegadaCombustible: e.combustible,
          novedadesMecanica: e.novedadesMecanica?.trim() || null,
          novedadesInstrumentacion: e.novedadesInstrumentacion?.trim() || null,
          novedadesOperaciones: e.novedadesOperaciones?.trim() || null,
          unidadLista: e.unidadLista,
          operacionInterrumpida: e.operacionInterrumpida,
          detalleInterrupcion: e.operacionInterrumpida ? detalle : null,
          llegadaFirmadaPor: actor.id,
          llegadaFirmadaAt: new Date(),
        },
      });
      for (const h of e.hubodometros) {
        await tx.reporteUnidadHubodometro.upsert({
          where: { reporteId_eje_punto: { reporteId: reporte.id, eje: h.eje, punto: h.punto } },
          create: { reporteId: reporte.id, eje: h.eje, punto: h.punto, llegada: h.llegada },
          update: { llegada: h.llegada },
        });
      }
      for (const l of e.llantas) {
        await tx.reporteUnidadLlanta.upsert({
          where: { reporteId_posicion: { reporteId: reporte.id, posicion: l.posicion } },
          create: {
            reporteId: reporte.id,
            posicion: l.posicion,
            llegada: l.llegada?.trim() || null,
          },
          update: { llegada: l.llegada?.trim() || null },
        });
      }
      for (const i of e.inspecciones) {
        await tx.reporteUnidadInspeccion.upsert({
          where: { reporteId_itemId: { reporteId: reporte.id, itemId: i.itemId } },
          create: { reporteId: reporte.id, itemId: i.itemId, llegada: i.resultado },
          update: { llegada: i.resultado },
        });
      }
      await this.requisitos.marcar(
        tx,
        { ticketId, codigo: REQ.reporteLlegada, unidadId },
        'sistema',
        actor.id,
      );
      const hayNovedades =
        !!(
          reporte.novedadesMecanica ||
          reporte.novedadesInstrumentacion ||
          reporte.novedadesOperaciones
        ) ||
        !e.unidadLista ||
        e.operacionInterrumpida ||
        e.inspecciones.some((i) => i.resultado === 'no_conforme');
      await this.bus.publish(
        tx,
        this.bus.create({
          type: 'operaciones.pumping.reporte_unidad_llegada',
          subject: { type: 'pumping_ticket', id: ticketId },
          // `unidadId` es la unidad de Flota (D2); `vehiculoId`, el vehículo del catálogo enlazado a ella (nulo si no tiene), se conserva
          // mientras algún consumidor aún lo lea
          data: {
            ticketId,
            unidadId,
            vehiculoId: asignada.unidad.vehiculoId,
            reporteUnidadId: reporte.id,
            hayNovedades,
          },
          actor: { userId: actor.id, role: actor.roleCode },
          traceparent: currentTraceparent(),
        }),
      );
    });
    return this.obtener(ticketId, unidadId);
  }
}
