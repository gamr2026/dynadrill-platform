import { Injectable, NotFoundException } from '@nestjs/common';
import { aDia, aFecha, diasHasta, hoyEcuador } from '../comun/fechas';
import { ResultadoInspeccion } from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';

/** Consecutivo visible de la inspección: INSP-000001. */
export const codigoInspeccion = (numero: number): string =>
  `INSP-${String(numero).padStart(6, '0')}`;

/** Lectura de inspecciones: tipos con sus criterios, bandeja, detalle y el estado de cada equipo (cuarentena y próxima inspección debida). */
@Injectable()
export class InspeccionesConsultaService {
  constructor(private readonly prisma: PrismaService) {}

  /** Tipos de equipo con los criterios de rechazo que se evalúan en cada inspección (para armar el formulario). */
  tipos() {
    return this.prisma.inspeccionTipo
      .findMany({
        where: { activo: true },
        orderBy: { orden: 'asc' },
        include: {
          criterios: {
            where: { activo: true },
            orderBy: { orden: 'asc' },
            select: { id: true, nombre: true },
          },
        },
      })
      .then((ts) =>
        ts.map((t) => ({
          id: t.id,
          codigo: t.codigo,
          nombre: t.nombre,
          frecuenciaDias: t.frecuenciaDias,
          requiereBumpTest: t.requiereBumpTest,
          requiereUnidad: t.requiereUnidad,
          generaCasoMantenimiento: t.generaCasoMantenimiento,
          criterios: t.criterios,
        })),
      );
  }

  async listar(
    f: {
      tipoId?: string;
      resultado?: ResultadoInspeccion;
      desde?: string;
      hasta?: string;
      q?: string;
    } = {},
  ) {
    const q = f.q?.trim();
    const filas = await this.prisma.inspeccion.findMany({
      where: {
        ...(f.tipoId ? { tipoId: f.tipoId } : {}),
        ...(f.resultado ? { resultado: f.resultado } : {}),
        ...(f.desde || f.hasta
          ? {
              fecha: {
                ...(f.desde ? { gte: aFecha(f.desde) } : {}),
                ...(f.hasta ? { lte: aFecha(f.hasta) } : {}),
              },
            }
          : {}),
        ...(q
          ? {
              OR: [
                { equipo: { codigo: { contains: q, mode: 'insensitive' } } },
                { unidadCodigo: { contains: q, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      orderBy: [{ fecha: 'desc' }, { numero: 'desc' }],
      take: 500,
      include: {
        tipo: { select: { id: true, codigo: true, nombre: true } },
        inspector: { select: { nombre: true } },
        equipo: { select: { codigo: true } },
      },
    });
    const hoy = hoyEcuador();
    return filas.map((i) => ({
      id: i.id,
      numero: i.numero,
      codigo: codigoInspeccion(i.numero),
      tipo: i.tipo,
      equipoCodigo: i.equipo.codigo,
      unidadId: i.unidadId,
      unidadCodigo: i.unidadCodigo,
      inspector: i.inspector.nombre,
      fecha: aDia(i.fecha),
      resultado: i.resultado,
      vigenteHasta: aDia(i.vigenteHasta),
      vencida: aDia(i.vigenteHasta) < hoy,
    }));
  }

  async detalle(id: string) {
    const i = await this.prisma.inspeccion.findUnique({
      where: { id },
      include: {
        tipo: { select: { id: true, codigo: true, nombre: true, requiereBumpTest: true } },
        inspector: { select: { nombre: true } },
        equipo: { select: { codigo: true } },
        ticket: { select: { ticketNumero: true, pedidoCodigo: true } },
        resultados: { include: { criterio: { select: { nombre: true, orden: true } } } },
      },
    });
    if (!i) throw new NotFoundException('La inspección no existe');
    return {
      id: i.id,
      numero: i.numero,
      codigo: codigoInspeccion(i.numero),
      tipo: i.tipo,
      equipoCodigo: i.equipo.codigo,
      unidadId: i.unidadId,
      unidadCodigo: i.unidadCodigo,
      inspector: i.inspector.nombre,
      fecha: aDia(i.fecha),
      resultado: i.resultado,
      bumpTestRealizado: i.bumpTestRealizado,
      vigenteHasta: aDia(i.vigenteHasta),
      observaciones: i.observaciones,
      ticketId: i.ticketId,
      ticketNumero: i.ticket?.ticketNumero ?? null,
      pedidoCodigo: i.ticket?.pedidoCodigo ?? null,
      criterios: i.resultados
        .sort((a, b) => a.criterio.orden - b.criterio.orden)
        .map((r) => ({ criterio: r.criterio.nombre, cumple: r.cumple })),
    };
  }

  /**
   * Estado de cada equipo según su ÚLTIMA inspección: en cuarentena si quedó rechazada (se levanta con una inspección nueva aprobada), con la
   * próxima inspección debida (fecha + frecuencia del tipo) y si ya está atrasada o vencida su vigencia trimestral. Se deduce del historial.
   */
  async equipos() {
    const hoy = hoyEcuador();
    const todas = await this.prisma.inspeccion.findMany({
      orderBy: [{ fecha: 'desc' }, { numero: 'desc' }],
      take: 5000,
      select: {
        id: true,
        numero: true,
        tipoId: true,
        equipoId: true,
        equipo: { select: { codigo: true } },
        unidadCodigo: true,
        fecha: true,
        resultado: true,
        vigenteHasta: true,
        tipo: { select: { codigo: true, nombre: true, frecuenciaDias: true } },
      },
    });
    const vistos = new Set<string>();
    const equipos = [];
    for (const i of todas) {
      const clave = i.equipoId;
      if (vistos.has(clave)) continue;
      vistos.add(clave);
      const fecha = aDia(i.fecha);
      const proxima = masDias(fecha, i.tipo.frecuenciaDias);
      equipos.push({
        tipo: { codigo: i.tipo.codigo, nombre: i.tipo.nombre },
        equipoCodigo: i.equipo.codigo,
        unidadCodigo: i.unidadCodigo,
        ultimaInspeccion: {
          id: i.id,
          codigo: codigoInspeccion(i.numero),
          fecha,
          resultado: i.resultado,
        },
        enCuarentena: i.resultado === ResultadoInspeccion.rechazado,
        proximaDebida: proxima,
        atrasada: proxima < hoy,
        vigenteHasta: aDia(i.vigenteHasta),
        vigenciaVencida: aDia(i.vigenteHasta) < hoy,
        diasParaProxima: diasHasta(proxima, hoy),
      });
    }
    return equipos.sort(
      (a, b) =>
        Number(b.enCuarentena) - Number(a.enCuarentena) ||
        a.proximaDebida.localeCompare(b.proximaDebida),
    );
  }
}

function masDias(dia: string, dias: number): string {
  return new Date(Date.parse(`${dia}T00:00:00Z`) + dias * 86_400_000).toISOString().slice(0, 10);
}
