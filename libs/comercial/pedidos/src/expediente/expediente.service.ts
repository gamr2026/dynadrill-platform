import { Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { OperacionesPort } from '../directorio/operaciones.port';
import { QhsePort } from '../directorio/qhse.port';
import { PrismaService } from '../prisma/prisma.service';
import { hoyEnEcuador } from '../services/servicio-cumplido';
import type {
  DocumentoExpediente,
  Expediente,
  GrupoExpediente,
  OrigenExpediente,
} from './expediente.types';

/** Lo que se espera de cada módulo de otro contenedor antes de darlo por no disponible. */
export const LIMITE_MODULO_MS = 8_000;

const MS_DIA = 86_400_000;
const aDia = (d: Date) => d.toISOString().slice(0, 10);
const dmy = (f: string) => `${f.slice(8, 10)}/${f.slice(5, 7)}/${f.slice(0, 4)}`;

const TITULOS: Record<string, string> = {
  reporte_job: 'Reporte Job',
  reporte_herramientas: 'Reporte de Herramientas',
  monitoreo: 'Monitoreo',
  mezcla_quimica: 'Mezcla química',
  reporte_unidad: 'Reporte de unidad',
  prefactura: 'Prefactura',
  guia_remision: 'Guía de remisión',
  orden_trabajo: 'Orden de trabajo',
  qhse_formato_recepcion: 'Formato de recepción',
  qhse_art: 'ART',
  qhse_pt: 'Permiso de trabajo (PT)',
  qhse_sfi: 'SFI',
  qhse_formato_entrega: 'Acta de entrega de locación',
  fcr_formulario_inspeccion_externo: 'Formulario de inspección externo',
  fcr_formato_dimensionamiento_servicio: 'Formato de dimensionamiento del servicio',
  fcr_formato_dureza_servicio: 'Formato de dureza del servicio',
  fcr_documento_inspeccion: 'Documento de inspección',
  fcr_registro_dureza: 'Registro de dureza',
  fcr_registro_qaqc: 'Registro QA/QC',
  inspeccion_vehiculo: 'Inspección de vehículo',
  gerenciamiento_viaje: 'Gerenciamiento de viaje',
  orden_mantenimiento_general: 'Orden de trabajo de mantenimiento general',
  orden_mantenimiento_operativa: 'Orden de mantenimiento operativo',
  informe_mantenimiento: 'Informe de mantenimiento',
};

const ETIQUETAS: Record<OrigenExpediente, string> = {
  facturacion: 'Facturación',
  operaciones: 'Operaciones',
  qhse: 'QHSE',
  mantenimiento: 'Mantenimiento',
  flota_inspeccion: 'Inspecciones de unidades',
  flota_viaje: 'Gerenciamiento de viaje',
  adjuntos: 'Adjuntos',
};

/** Fuente de cada tipo: los que guardan un archivo; los demás son formatos que se arman con datos. */
const CON_ARCHIVO = (tipo: string) =>
  tipo === 'monitoreo' ||
  tipo === 'mezcla_quimica' ||
  tipo === 'adjunto' ||
  tipo.startsWith('qhse_') ||
  tipo.startsWith('fcr_');

/** Un documento antes de resolver su archivo y su versión firmada. */
interface Borrador {
  tipo: string;
  refId: string;
  titulo?: string;
  pertenece: string;
  fecha: string | null;
  archivoId?: string | null;
  /** Versión firmada que ya guarda el propio documento (guía, OT, firma de la prefactura). */
  firmadoPropio?: Firmado | null;
}

interface Firmado {
  id: string;
  archivoId: string;
  subidoPor: string;
  subidoAt: Date;
}

interface ResultadoGrupo {
  documentos: Borrador[];
  /** Motivo por el que lo que se leyó puede estar incompleto (un módulo falló). */
  error: string | null;
}

interface PedidoBase {
  id: string;
  codigo: string;
  inicio: Date | null;
  fin: Date | null;
  ticketNumero: number | null;
  origen: 'pumping' | 'fcr';
  ticketId: string | null;
}

const mensaje = (e: unknown): string =>
  e instanceof Error && e.message ? e.message : 'No respondió';

/**
 * Índice del expediente del pedido: todos los documentos vigentes que respaldan la prefactura, en grupos por origen. Lee sus propias
 * tablas y consulta a Operaciones y a QHSE por sus adaptadores HTTP (con el token de quien pide). Cada grupo falla por separado: si un
 * módulo no responde a tiempo o da error, su grupo sale con `disponible: false` y el motivo, nunca todo el índice.
 */
@Injectable()
export class ExpedienteService {
  private readonly logger = new Logger(ExpedienteService.name);
  /** Público para poder acortarlo en las pruebas. */
  limiteMs = LIMITE_MODULO_MS;

  constructor(
    private readonly prisma: PrismaService,
    private readonly operaciones: OperacionesPort,
    private readonly qhse: QhsePort,
  ) {}

  async construir(pedidoId: string, token: string): Promise<Expediente> {
    const p = await this.pedido(pedidoId);
    const fuentes: Array<[OrigenExpediente, () => Promise<ResultadoGrupo>]> = [
      ['facturacion', () => this.facturacion(p)],
      ['operaciones', () => this.operacionesGrupo(p, token)],
      ['qhse', () => this.qhseGrupo(p, token)],
      ...(p.origen === 'pumping'
        ? ([
            ['mantenimiento', () => this.mantenimiento(p, token)],
            ['flota_inspeccion', () => this.inspecciones(p, token)],
            ['flota_viaje', () => this.viajes(p, token)],
          ] as Array<[OrigenExpediente, () => Promise<ResultadoGrupo>]>)
        : []),
      ['adjuntos', () => this.adjuntos(p)],
    ];
    // todos los módulos a la vez, cada uno con su límite de tiempo; un fallo se queda en su grupo
    const resultados = await Promise.all(
      fuentes.map(async ([origen, leer]) => {
        try {
          return await this.conLimite(leer());
        } catch (e) {
          this.logger.warn(
            `Expediente del pedido ${pedidoId}: ${origen} no disponible (${mensaje(e)})`,
          );
          return { documentos: [], error: mensaje(e) } as ResultadoGrupo;
        }
      }),
    );

    const todos = resultados.flatMap((r) => r.documentos);
    const firmados = await this.firmadosVigentes(pedidoId);
    const [archivos, nombres] = await Promise.all([
      this.archivos(todos, firmados),
      this.nombres(
        [
          ...firmados.values(),
          ...todos.flatMap((d) => (d.firmadoPropio ? [d.firmadoPropio] : [])),
        ].map((f) => f.subidoPor),
      ),
    ]);
    const grupos: GrupoExpediente[] = fuentes.map(([origen], i) => {
      const r = resultados[i];
      return {
        origen,
        etiqueta: ETIQUETAS[origen],
        disponible: r.error === null,
        motivoNoDisponible: r.error,
        documentos: r.documentos
          .sort(
            (a, b) =>
              (a.fecha ?? '').localeCompare(b.fecha ?? '') ||
              a.pertenece.localeCompare(b.pertenece),
          )
          .map((b) => this.aDocumento(b, archivos, firmados, nombres)),
      };
    });
    return {
      pedido: {
        id: p.id,
        codigo: p.codigo,
        fechaInicioServicio: p.inicio ? aDia(p.inicio) : null,
        fechaFinServicio: p.fin ? aDia(p.fin) : null,
      },
      grupos,
    };
  }

  // ---- grupos propios ---------------------------------------------------------------------------------

  private async facturacion(p: PedidoBase): Promise<ResultadoGrupo> {
    const [prefacturas, guias, ot] = await Promise.all([
      this.prisma.prefactura.findMany({
        // vigentes: ni rechazadas ni anuladas (una versión nueva reemplaza a la rechazada)
        where: { pedidoId: p.id, estado: { in: ['generada', 'enviada_para_firmas', 'firmada'] } },
        include: {
          firmas: { where: { reemplazadaPorId: null }, orderBy: { createdAt: 'desc' }, take: 1 },
        },
        orderBy: { version: 'asc' },
      }),
      this.prisma.guiaRemision.findMany({
        where: { pedidoId: p.id, estado: 'emitida' },
        orderBy: { numero: 'asc' },
      }),
      this.prisma.ordenTrabajo.findUnique({ where: { pedidoId: p.id } }),
    ]);
    const documentos: Borrador[] = [
      ...prefacturas.map((x) => ({
        tipo: 'prefactura',
        refId: x.id,
        pertenece: `Prefactura versión ${x.version}`,
        fecha: hoyEnEcuador(x.generadaAt),
        firmadoPropio: x.firmas[0]
          ? {
              id: x.firmas[0].id,
              archivoId: x.firmas[0].archivoId,
              subidoPor: x.firmas[0].registradoPor,
              subidoAt: x.firmas[0].createdAt,
            }
          : null,
      })),
      ...guias.map((g) => ({
        tipo: 'guia_remision',
        refId: g.id,
        pertenece: `Guía ${g.codigo}`,
        fecha: aDia(g.fecha),
        firmadoPropio:
          g.archivoFirmadoId && g.firmadaAt
            ? {
                id: g.id,
                archivoId: g.archivoFirmadoId,
                subidoPor: g.emitidaPor,
                subidoAt: g.firmadaAt,
              }
            : null,
      })),
      ...(ot
        ? [
            {
              tipo: 'orden_trabajo',
              refId: ot.id,
              pertenece: `Orden de trabajo ${ot.codigo}`,
              fecha: aDia(ot.fecha),
              firmadoPropio:
                ot.archivoFirmadoId && ot.firmadaAt && ot.firmadaPor
                  ? {
                      id: ot.id,
                      archivoId: ot.archivoFirmadoId,
                      subidoPor: ot.firmadaPor,
                      subidoAt: ot.firmadaAt,
                    }
                  : null,
            },
          ]
        : []),
    ];
    return { documentos, error: null };
  }

  private async adjuntos(p: PedidoBase): Promise<ResultadoGrupo> {
    const filas = await this.prisma.pedidoDocumento.findMany({
      where: { pedidoId: p.id },
      orderBy: { createdAt: 'asc' },
    });
    return {
      documentos: filas.map((d) => ({
        tipo: 'adjunto',
        refId: d.id,
        titulo: d.descripcion,
        pertenece: `Pedido ${p.codigo}`,
        fecha: hoyEnEcuador(d.createdAt),
        archivoId: d.archivoId,
      })),
      error: null,
    };
  }

  // ---- grupos que viven en otros contenedores ---------------------------------------------------------

  /** Los Reportes Job y de Herramientas son de Comercial; el resto del grupo lo consulta a Pumping o a FCR. */
  private async operacionesGrupo(p: PedidoBase, token: string): Promise<ResultadoGrupo> {
    const propios = await this.prisma.documentoOperativo.findMany({
      // un día que Facturación quitó queda como documento corregido sin actividades: ya no es un documento del expediente
      where: { pedidoId: p.id, NOT: { corregidoAt: { not: null }, actividades: { none: {} } } },
      select: { id: true, tipo: true, fecha: true },
    });
    const documentos: Borrador[] = propios.map((d) =>
      d.tipo === 'reporte_job' && d.fecha
        ? {
            tipo: 'reporte_job',
            refId: d.id,
            pertenece: this.dia(p, aDia(d.fecha)),
            fecha: aDia(d.fecha),
          }
        : {
            tipo: 'reporte_herramientas',
            refId: d.id,
            pertenece: 'Todo el servicio',
            fecha: null,
          },
    );
    const ticketId = p.ticketId;
    if (!ticketId) return { documentos, error: null };

    const remotos =
      p.origen === 'pumping'
        ? await Promise.allSettled([
            this.operaciones.documentosDeTicketPumping(ticketId, token),
            this.operaciones.reportesDeUnidadDeTicket(ticketId, token),
          ])
        : await Promise.allSettled([this.operaciones.documentosDeTicketFcr(ticketId, token)]);
    const errores: string[] = [];
    if (p.origen === 'pumping') {
      const [docs, reportes] = remotos as [
        PromiseSettledResult<Awaited<ReturnType<OperacionesPort['documentosDeTicketPumping']>>>,
        PromiseSettledResult<Awaited<ReturnType<OperacionesPort['reportesDeUnidadDeTicket']>>>,
      ];
      if (docs.status === 'fulfilled') {
        for (const d of docs.value ?? []) {
          documentos.push({
            tipo: d.tipo,
            refId: d.id,
            pertenece:
              d.tipo === 'monitoreo' && d.fecha ? this.dia(p, d.fecha) : 'Todo el servicio',
            fecha: d.fecha,
            archivoId: d.archivoId ?? null,
          });
        }
      } else errores.push(mensaje(docs.reason));
      if (reportes.status === 'fulfilled') {
        for (const r of reportes.value) {
          documentos.push({
            tipo: 'reporte_unidad',
            refId: r.id,
            pertenece: `Unidad ${r.unidad} · ${this.dia(p, r.fecha)}`,
            fecha: r.fecha,
          });
        }
      } else errores.push(mensaje(reportes.reason));
    } else {
      const [docs] = remotos as [
        PromiseSettledResult<Awaited<ReturnType<OperacionesPort['documentosDeTicketFcr']>>>,
      ];
      if (docs.status === 'fulfilled') {
        for (const d of docs.value) {
          documentos.push({
            tipo: `fcr_${d.campo}`,
            refId: d.id,
            pertenece: p.ticketNumero ? `Ticket ${p.ticketNumero}` : 'Ticket de FCR',
            fecha: null,
            archivoId: d.archivoId,
          });
        }
      } else errores.push(mensaje(docs.reason));
    }
    return { documentos, error: errores.length ? errores.join(' ') : null };
  }

  private async qhseGrupo(p: PedidoBase, token: string): Promise<ResultadoGrupo> {
    const docs = await this.qhse.documentosDelPedido(p.id, token);
    return {
      documentos: docs.map((d) => ({
        tipo: `qhse_${d.tipo}`,
        refId: d.id,
        pertenece:
          d.tipo === 'pt' && d.fecha
            ? this.dia(p, d.fecha)
            : d.tipo === 'art' && d.fecha
              ? `Emisión ${dmy(d.fecha)}`
              : d.tipo === 'formato_entrega' && p.ticketNumero
                ? `Ticket ${p.ticketNumero}`
                : `Pedido ${p.codigo}`,
        fecha: d.fecha,
        archivoId: d.archivoId,
      })),
      error: null,
    };
  }

  private async mantenimiento(p: PedidoBase, token: string): Promise<ResultadoGrupo> {
    if (!p.ticketId) return { documentos: [], error: null };
    const ordenes = await this.operaciones.ordenesMantenimientoDelServicio(p.ticketId, token);
    const documentos = ordenes.flatMap((o) => {
      const fecha = o.creadaAt ? hoyEnEcuador(new Date(o.creadaAt)) : null;
      const pertenece = `Unidad ${o.unidad} · Orden ${o.codigo}`;
      const operativa = o.tiposSuborden.includes('operativo');
      const general =
        o.tiposSuborden.length === 0 || o.tiposSuborden.some((t) => t !== 'operativo');
      return [
        ...(general
          ? [{ tipo: 'orden_mantenimiento_general', refId: o.id, pertenece, fecha }]
          : []),
        ...(operativa
          ? [{ tipo: 'orden_mantenimiento_operativa', refId: o.id, pertenece, fecha }]
          : []),
        { tipo: 'informe_mantenimiento', refId: o.id, pertenece, fecha },
      ];
    });
    return { documentos, error: null };
  }

  private async inspecciones(p: PedidoBase, token: string): Promise<ResultadoGrupo> {
    if (!p.ticketId) return { documentos: [], error: null };
    const lista = await this.operaciones.inspeccionesDeTicket(p.ticketId, token);
    return {
      documentos: lista
        .filter((i) => !i.anulada)
        .map((i) => {
          const fecha = i.fecha ? hoyEnEcuador(new Date(i.fecha)) : null;
          return {
            tipo: 'inspeccion_vehiculo',
            refId: i.id,
            pertenece: `Unidad ${i.unidad} · ${i.momento === 'llegada' ? 'Llegada' : 'Salida'}${fecha ? ` · ${dmy(fecha)}` : ''}`,
            fecha,
          };
        }),
      error: null,
    };
  }

  private async viajes(p: PedidoBase, token: string): Promise<ResultadoGrupo> {
    if (!p.ticketId) return { documentos: [], error: null };
    const lista = await this.operaciones.viajesDeTicket(p.ticketId, token);
    return {
      documentos: lista
        .filter((v) => v.estado !== 'rechazado')
        .map((v) => ({
          tipo: 'gerenciamiento_viaje',
          refId: v.id,
          pertenece: `Unidad ${v.unidad} · ${v.tipo === 'retorno' ? 'Retorno' : 'Salida'}${v.fecha ? ` · ${dmy(v.fecha)}` : ''}`,
          fecha: v.fecha,
        })),
      error: null,
    };
  }

  // ---- armado ----------------------------------------------------------------------------------------

  private aDocumento(
    b: Borrador,
    archivos: Map<string, { nombre: string; mime: string }>,
    firmados: Map<string, Firmado>,
    nombres: Map<string, string>,
  ): DocumentoExpediente {
    const archivo = b.archivoId ? archivos.get(b.archivoId) : undefined;
    // la versión firmada que Facturación cargó manda; si no hay, la que el documento ya guarda (guía, OT, firma de la prefactura)
    const firmado = firmados.get(`${b.tipo}:${b.refId}`) ?? b.firmadoPropio ?? null;
    const archivoFirmado = firmado ? archivos.get(firmado.archivoId) : undefined;
    const guardaArchivo = CON_ARCHIVO(b.tipo);
    return {
      clave: `${b.tipo}:${b.refId}`,
      tipo: b.tipo,
      titulo: b.titulo ?? TITULOS[b.tipo] ?? b.tipo,
      pertenece: b.pertenece,
      fecha: b.fecha,
      fuente: guardaArchivo ? 'archivo' : 'formato',
      archivo: guardaArchivo && b.archivoId && archivo ? { id: b.archivoId, ...archivo } : null,
      formato: guardaArchivo ? null : { codigo: b.tipo, refId: b.refId },
      admiteFirmado: true,
      firmado:
        firmado && archivoFirmado
          ? {
              id: firmado.id,
              archivoId: firmado.archivoId,
              nombre: archivoFirmado.nombre,
              subidoPor: nombres.get(firmado.subidoPor) ?? 'Usuario',
              subidoAt: firmado.subidoAt.toISOString(),
            }
          : null,
    };
  }

  /** Las versiones firmadas vigentes que cargó Facturación, por `tipo:refId` (las reemplazadas quedan como historia). */
  private async firmadosVigentes(pedidoId: string): Promise<Map<string, Firmado>> {
    const filas = await this.prisma.documentoRespaldoFirmado.findMany({
      where: { pedidoId, reemplazadoPorId: null },
      orderBy: { createdAt: 'asc' },
    });
    return new Map(
      filas.map((f) => [
        `${f.tipo}:${f.documentoTicketId}`,
        { id: f.id, archivoId: f.archivoId, subidoPor: f.registradoPor, subidoAt: f.createdAt },
      ]),
    );
  }

  /** Nombre y tipo de los archivos (`archivos.archivo`, que Comercial lee por su FK) de los documentos y de sus versiones firmadas. */
  private async archivos(docs: Borrador[], firmados: Map<string, Firmado>) {
    const ids = new Set<string>();
    for (const d of docs) {
      if (d.archivoId) ids.add(d.archivoId);
      if (d.firmadoPropio) ids.add(d.firmadoPropio.archivoId);
    }
    for (const f of firmados.values()) ids.add(f.archivoId);
    const filas = ids.size
      ? await this.prisma.catArchivo.findMany({
          where: { id: { in: [...ids] } },
          select: { id: true, nombreOriginal: true, mimeType: true },
        })
      : [];
    return new Map(filas.map((a) => [a.id, { nombre: a.nombreOriginal, mime: a.mimeType }]));
  }

  private async nombres(ids: string[]): Promise<Map<string, string>> {
    const unicos = [...new Set(ids)];
    if (!unicos.length) return new Map();
    const filas = await this.prisma.idUsuario.findMany({
      where: { id: { in: unicos } },
      select: { id: true, nombre: true },
    });
    return new Map(filas.map((u) => [u.id, u.nombre]));
  }

  private async pedido(pedidoId: string): Promise<PedidoBase> {
    const p = await this.prisma.pedido.findUnique({
      where: { id: pedidoId },
      select: {
        id: true,
        codigo: true,
        fechaInicioServicio: true,
        fechaFinServicio: true,
        ticketNumero: true,
        linea: { select: { codigo: true } },
        ticketOperativo: { select: { origen: true, ticketId: true } },
      },
    });
    if (!p) throw new NotFoundException('El pedido no existe');
    return {
      id: p.id,
      codigo: p.codigo ?? '',
      inicio: p.fechaInicioServicio,
      fin: p.fechaFinServicio,
      ticketNumero: p.ticketNumero,
      // sin ticket todavía, la línea del pedido dice de qué clase es
      origen: p.ticketOperativo?.origen ?? (p.linea?.codigo === 'fcr' ? 'fcr' : 'pumping'),
      ticketId: p.ticketOperativo?.ticketId ?? null,
    };
  }

  /** «Día 2 · 12/11/2026»: el número del día dentro del servicio (si se conoce la fecha de inicio) y la fecha. */
  private dia(p: PedidoBase, fecha: string): string {
    if (!p.inicio) return dmy(fecha);
    const n =
      Math.round((new Date(`${fecha}T00:00:00Z`).getTime() - p.inicio.getTime()) / MS_DIA) + 1;
    return n >= 1 ? `Día ${n} · ${dmy(fecha)}` : dmy(fecha);
  }

  /** El módulo que no responde en `limiteMs` no retrasa el índice: su grupo queda como no disponible. */
  private conLimite<T>(trabajo: Promise<T>): Promise<T> {
    let reloj: NodeJS.Timeout | undefined;
    const limite = new Promise<never>((_, rechazar) => {
      reloj = setTimeout(
        () => rechazar(new ServiceUnavailableException('No respondió a tiempo')),
        this.limiteMs,
      );
    });
    return Promise.race([trabajo, limite]).finally(() => clearTimeout(reloj));
  }
}
