import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AuthUser } from '@dyn/common';
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

const PASO = 'traslado_salida';

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
  ) {}

  /** Las unidades del ticket con su operador y si el reporte de salida ya está firmado. */
  async listar(ticketId: string) {
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
      this.prisma.reporteUnidad.findMany({ where: { ticketId } }),
    ]);
    return unidades.map((u) => {
      const r = reportes.find((x) => x.vehiculoId === u.vehiculoId);
      const o = personas.find((p) => p.vehiculoId === u.vehiculoId);
      return {
        vehiculoId: u.vehiculoId,
        placa: u.vehiculo.placa,
        operador: o ? { usuarioId: o.usuarioId, nombre: o.usuario.nombre } : null,
        salidaFirmada: !!r?.salidaFirmadaAt,
        salidaFirmadaAt: r?.salidaFirmadaAt ?? null,
      };
    });
  }

  /** El reporte de una unidad (vacío si todavía no se llenó) con todos los ítems del formulario. */
  async obtener(ticketId: string, vehiculoId: string) {
    const unidad = await this.prisma.ticketUnidad.findUnique({
      where: { ticketId_vehiculoId: { ticketId, vehiculoId } },
      include: { vehiculo: true },
    });
    if (!unidad) throw new NotFoundException('Esa unidad no está asignada al ticket');
    const [reporte, items, firmante] = await Promise.all([
      this.prisma.reporteUnidad.findUnique({
        where: { ticketId_vehiculoId: { ticketId, vehiculoId } },
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
        where: { ticketId, vehiculoId, rol: 'operador' },
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
      vehiculoId,
      placa: unidad.vehiculo.placa,
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

  async guardarSalida(ticketId: string, vehiculoId: string, e: SalidaEntrada, actor: AuthUser) {
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
        where: { ticketId_vehiculoId: { ticketId, vehiculoId } },
      });
      if (!unidad) throw new NotFoundException('Esa unidad no está asignada al ticket');
      if (actor.roleCode !== 'superadmin') {
        const op = await tx.ticketPersona.findFirst({
          where: { ticketId, vehiculoId, usuarioId: actor.id, rol: 'operador' },
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
        where: { ticketId_vehiculoId: { ticketId, vehiculoId } },
        create: { id: uuidv7(), ticketId, vehiculoId, ...datos },
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
        { ticketId, codigo: REQ.reporteSalida, vehiculoId },
        'sistema',
        actor.id,
      );
    });
    return this.obtener(ticketId, vehiculoId);
  }
}
