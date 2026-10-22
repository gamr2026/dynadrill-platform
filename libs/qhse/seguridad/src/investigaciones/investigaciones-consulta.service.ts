import { Injectable, NotFoundException } from '@nestjs/common';
import { EstadoInvestigacion } from '../generated/client';
import type { Prisma } from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';
import { calcularPlazos, codigoInvestigacion } from './plazos';

export interface FiltroInvestigaciones {
  estado?: EstadoInvestigacion;
  resultado?: string;
  q?: string;
}

const CON_DATOS = {
  resultado: true,
  lider: { select: { id: true, nombre: true } },
  creador: { select: { id: true, nombre: true } },
} satisfies Prisma.InvestigacionInclude;

type Fila = Prisma.InvestigacionGetPayload<{ include: typeof CON_DATOS }>;

/** Lectura de investigaciones: catálogo de resultados, bandeja con plazos calculados y detalle con su historial. */
@Injectable()
export class InvestigacionesConsultaService {
  constructor(private readonly prisma: PrismaService) {}

  /** Resultados posibles del incidente, para el formulario de apertura. */
  resultados() {
    return this.prisma.investigacionResultado.findMany({
      where: { activo: true },
      orderBy: { orden: 'asc' },
      select: {
        id: true,
        codigo: true,
        nombre: true,
        inicioHoras: true,
        preliminarHoras: true,
        finalDias: true,
        plazoSupuesto: true,
        involucraLesionado: true,
        sugiereNotificacionLegal: true,
      },
    });
  }

  async listar(f: FiltroInvestigaciones = {}) {
    const q = f.q?.trim();
    const filas = await this.prisma.investigacion.findMany({
      where: {
        ...(f.estado ? { estado: f.estado } : {}),
        ...(f.resultado ? { resultado: { codigo: f.resultado } } : {}),
        ...(q
          ? {
              OR: [
                { ubicacion: { contains: q, mode: 'insensitive' } },
                { descripcionEvento: { contains: q, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      orderBy: [{ fechaIncidente: 'desc' }, { numero: 'desc' }],
      take: 500,
      include: CON_DATOS,
    });
    const items = filas.map((i) => this.resumen(i));
    return {
      items,
      kpi: {
        total: items.length,
        abiertas: items.filter((i) => i.estado !== EstadoInvestigacion.cerrada).length,
        conPlazoVencido: items.filter(
          (i) =>
            i.estado !== EstadoInvestigacion.cerrada &&
            (i.plazos.inicioVencido || i.plazos.finalVencido),
        ).length,
      },
    };
  }

  async detalle(id: string) {
    const i = await this.prisma.investigacion.findUnique({
      where: { id },
      include: {
        ...CON_DATOS,
        historial: {
          orderBy: { createdAt: 'asc' },
          include: { actor: { select: { id: true, nombre: true } } },
        },
        trabajador: {
          include: {
            usuario: {
              select: { nombre: true, perfil: { select: { cedula: true, cargo: true } } },
            },
          },
        },
        detalle: true,
        equipo: {
          orderBy: { createdAt: 'asc' },
          include: { usuario: { select: { nombre: true } } },
        },
        testigos: { orderBy: { orden: 'asc' } },
        entorno: { orderBy: { orden: 'asc' } },
      },
    });
    if (!i) throw new NotFoundException('La investigación no existe');
    const t = i.trabajador;
    return {
      ...this.resumen(i),
      descripcionEvento: i.descripcionEvento,
      origenEmergenciaId: i.origenEmergenciaId,
      creadoPor: i.creador.nombre,
      createdAt: i.createdAt,
      evidenciasRecopiladas: i.evidenciasRecopiladas,
      testimoniosResumen: i.testimoniosResumen,
      // con cuenta del portal, el nombre, la cédula y el cargo salen de identidad (no se copian al guardar)
      trabajador: t && {
        ...t,
        apellidosNombres: t.usuario?.nombre ?? t.apellidosNombres,
        cedula: t.usuario?.perfil?.cedula ?? t.cedula,
        cargo: t.usuario?.perfil?.cargo ?? t.cargo,
        usuario: undefined,
      },
      incidente: i.detalle,
      equipo: i.equipo.map((m) => ({
        id: m.id,
        usuarioId: m.usuarioId,
        nombre: m.usuario?.nombre ?? m.nombreExterno,
      })),
      testigos: i.testigos.map((x) => ({
        orden: x.orden,
        nombresApellidos: x.nombresApellidos,
        cedula: x.cedula,
        version: x.version,
      })),
      entorno: i.entorno.map((x) => ({
        orden: x.orden,
        tipo: x.tipo,
        fuente: x.fuente,
        existeControl: x.existeControl,
        contribuyoAlSuceso: x.contribuyoAlSuceso,
      })),
      historial: i.historial.map((h) => ({
        id: h.id,
        estadoAnterior: h.estadoAnterior,
        estadoNuevo: h.estadoNuevo,
        observacion: h.observacion,
        actor: h.actor.nombre,
        at: h.createdAt,
      })),
    };
  }

  private resumen(i: Fila) {
    return {
      id: i.id,
      numero: i.numero,
      codigo: codigoInvestigacion(i.numero),
      estado: i.estado,
      resultado: {
        id: i.resultado.id,
        codigo: i.resultado.codigo,
        nombre: i.resultado.nombre,
        involucraLesionado: i.resultado.involucraLesionado,
        sugiereNotificacionLegal: i.resultado.sugiereNotificacionLegal,
        plazoSupuesto: i.resultado.plazoSupuesto,
      },
      fechaIncidente: i.fechaIncidente,
      ubicacion: i.ubicacion,
      lider: i.lider,
      escenaAseguradaAt: i.escenaAseguradaAt,
      plazos: calcularPlazos(
        i.fechaIncidente,
        i.resultado,
        i.escenaAseguradaAt,
        i.estado === EstadoInvestigacion.cerrada,
      ),
    };
  }
}
