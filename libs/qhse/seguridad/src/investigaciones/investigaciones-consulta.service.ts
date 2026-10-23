import { Injectable, NotFoundException } from '@nestjs/common';
import { aDia, hoyEcuador, masMeses } from '../comun/fechas';
import { EstadoAccionInvestigacion, EstadoInvestigacion } from '../generated/client';
import type { Prisma } from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';
import { faltaParaCierre, faltaParaRevision } from './cierre';
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

  /** Categorías (6 M) del diagrama de Ishikawa, para armar sus causas. */
  categoriasIshikawa() {
    return this.prisma.ishikawaCategoria.findMany({
      where: { activo: true },
      orderBy: { orden: 'asc' },
      select: { id: true, codigo: true, nombre: true },
    });
  }

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
    // acciones por implementar de cada investigación (la bandeja las muestra y las suma)
    const pendientes = await this.prisma.investigacionAccion.groupBy({
      by: ['investigacionId'],
      where: {
        investigacionId: { in: filas.map((i) => i.id) },
        estado: EstadoAccionInvestigacion.pendiente,
      },
      _count: { _all: true },
    });
    const porInvestigacion = new Map(pendientes.map((p) => [p.investigacionId, p._count._all]));
    const items = filas.map((i) => ({
      ...this.resumen(i),
      accionesPendientes: porInvestigacion.get(i.id) ?? 0,
    }));
    // un plazo vencido cuenta si el informe final venció o si no se inició a tiempo y sigue sin iniciarse
    const conPlazoVencido = (i: (typeof items)[number]) =>
      i.estado !== EstadoInvestigacion.cerrada &&
      (i.plazos.finalVencido ||
        (i.estado === EstadoInvestigacion.abierta && i.plazos.inicioVencido));
    return {
      items,
      kpi: {
        total: items.length,
        abiertas: items.filter((i) => i.estado !== EstadoInvestigacion.cerrada).length,
        conPlazoVencido: items.filter(conPlazoVencido).length,
        accionesPendientes: items.reduce((suma, i) => suma + i.accionesPendientes, 0),
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
        porques: { orderBy: { orden: 'asc' } },
        ishikawa: {
          orderBy: { orden: 'asc' },
          include: { categoria: { select: { codigo: true, nombre: true } } },
        },
        causas: { orderBy: [{ tipo: 'asc' }, { orden: 'asc' }] },
        acciones: {
          orderBy: { orden: 'asc' },
          include: {
            responsable: { select: { id: true, nombre: true } },
            controles: { select: { nivel: true } },
          },
        },
      },
    });
    if (!i) throw new NotFoundException('La investigación no existe');
    const t = i.trabajador;
    const [personas, actividad] = await Promise.all([
      this.prisma.idUsuario.findMany({
        where: { id: { in: [i.revisionEnviadaPor, i.cerradaPor].filter((x): x is string => !!x) } },
        select: { id: true, nombre: true },
      }),
      i.ipercActividadId
        ? this.prisma.ipercActividad.findUnique({
            where: { id: i.ipercActividadId },
            select: { id: true, nombre: true },
          })
        : null,
    ]);
    const nombre = (uid: string | null) => personas.find((p) => p.id === uid)?.nombre ?? null;
    return {
      ...this.resumen(i),
      descripcionEvento: i.descripcionEvento,
      origenEmergenciaId: i.origenEmergenciaId,
      creadoPor: i.creador.nombre,
      createdAt: i.createdAt,
      conclusion: i.conclusion,
      leccionesAprendidas: i.leccionesAprendidas,
      // lección aprendida: solo el vínculo con la actividad de la matriz IPERC (no cambia el estado de la matriz)
      ipercActividad: actividad,
      notificacionLegal: {
        sugerida: i.resultado.sugiereNotificacionLegal,
        requerida: i.notificacionLegalRequerida,
        ministerioTrabajoNotificadoAt: i.ministerioTrabajoNotificadoAt,
        iessNotificadoAt: i.iessNotificadoAt,
      },
      revisionEnviadaAt: i.revisionEnviadaAt,
      revisionEnviadaPor: nombre(i.revisionEnviadaPor),
      cerradaAt: i.cerradaAt,
      cerradaPor: nombre(i.cerradaPor),
      // lo que falta para avanzar, ya explicado (el cliente no recalcula las reglas)
      cierre: {
        pendientesParaRevision: faltaParaRevision({
          porques: i.porques.length,
          conclusion: i.conclusion,
          accionesVigentes: i.acciones.filter(
            (a) => a.estado !== EstadoAccionInvestigacion.cancelada,
          ).length,
        }),
        pendientesParaCierre: faltaParaCierre(i),
      },
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
      porques: i.porques.map((x) => ({
        orden: x.orden,
        pregunta: x.pregunta,
        respuesta: x.respuesta,
      })),
      ishikawa: i.ishikawa.map((x) => ({
        orden: x.orden,
        categoriaId: x.categoriaId,
        categoria: x.categoria.nombre,
        descripcion: x.descripcion,
      })),
      causas: i.causas.map((x) => ({ tipo: x.tipo, orden: x.orden, descripcion: x.descripcion })),
      acciones: i.acciones.map((x) => ({
        id: x.id,
        orden: x.orden,
        descripcion: x.descripcion,
        tipo: x.tipo,
        estado: x.estado,
        responsable: x.responsable,
        plazo: aDia(x.plazo),
        // una acción pendiente con el plazo cumplido está vencida
        vencida: x.estado === EstadoAccionInvestigacion.pendiente && aDia(x.plazo) < hoyEcuador(),
        controles: x.controles.map((c) => c.nivel),
        implementadaAt: x.implementadaAt,
        // el formato indica verificar la eficacia tres meses después de implementar (informativo: no bloquea)
        verificableDesde: x.implementadaAt ? masMeses(aDia(x.implementadaAt), 3) : null,
        fueEficaz: x.fueEficaz,
        verificacionObservacion: x.verificacionObservacion,
        verificadaAt: x.verificadaAt,
        canceladaAt: x.canceladaAt,
        cancelacionMotivo: x.cancelacionMotivo,
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
