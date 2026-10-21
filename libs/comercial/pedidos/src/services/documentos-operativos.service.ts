import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { currentTraceparent, type AuthUser } from '@dyn/common';
import { EventBus } from '@dyn/messaging';
import { uuidv7 } from '@dyn/utils';
import type { Prisma } from '../generated/client';
import {
  ActividadOperativaDto,
  CorregirDiaOperativoDto,
  HerramientaOperativaDto,
  RecibirDocumentoOperativoDto,
} from '../dto/documentos-operativos.dto';
import { PrismaService } from '../prisma/prisma.service';
import { PedidoEstadoService } from './pedido-estado.service';

/** Estados del pedido en los que todavía se reciben o corrigen documentos operativos (antes de generar la prefactura). */
const RECIBEN_DOCUMENTOS = new Set([
  'abierto',
  'en_operacion',
  'en_elaboracion_operativa',
  'documentos_completos',
  'en_revision_prefacturacion',
  'en_correccion',
]);

/**
 * Estados en los que Facturación todavía puede corregir un día del Reporte Job: hasta que el pedido sale al cliente para
 * firmas. Un pedido rechazado por el cliente sí admite corrección.
 */
const ADMITEN_CORRECCION = new Set([
  ...RECIBEN_DOCUMENTOS,
  'prefactura_generada',
  'por_despachar_bodega',
  'rechazado_por_cliente',
]);

const dia = (iso: string) => new Date(`${iso.slice(0, 10)}T00:00:00.000Z`);
const aDia = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const MS_DIA = 86_400_000;

export interface Avance {
  completo: boolean;
  /** Días que debería cubrir el Reporte Job (inicio a fin del servicio) y días con reporte recibido. */
  diasEsperados: number;
  diasConReporteJob: number;
  /** El Reporte de Herramientas solo lo exige la línea FCR. */
  reporteHerramientasRequerido: boolean;
  reporteHerramientasRecibido: boolean;
  /** Si alguna herramienta se vendió (estado `venta`), la guía de remisión es requisito. */
  usoVenta: boolean;
  guiaRequerida: boolean;
  /** Hay una guía emitida (vigente) para el pedido. */
  guiaRegistrada: boolean;
  /** Hay herramientas reportadas o ítems Material en el pedido: conviene emitir guía aunque no sea requisito. */
  guiaSugerida: boolean;
  /** Lo que falta, en lenguaje de la persona. */
  pendientes: string[];
}

/**
 * Documentos operativos del pedido: el Reporte Job (uno por día) y el Reporte de Herramientas (uno por servicio) que
 * llegan de Operaciones. Calcula el avance documental y, cuando está completo, pasa el pedido a "documentos completos".
 * Todo cambio de estado va por el motor de estados.
 */
@Injectable()
export class DocumentosOperativosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly estados: PedidoEstadoService,
    private readonly bus: EventBus,
  ) {}

  async recibir(pedidoId: string, dto: RecibirDocumentoOperativoDto, actor: AuthUser) {
    this.validar(dto);
    const resultado = await this.prisma.$transaction(async (tx) => {
      const pedido = await tx.pedido.findUnique({
        where: { id: pedidoId },
        select: { id: true, estado: true, codigo: true },
      });
      if (!pedido) throw new NotFoundException('El pedido no existe');
      if (!RECIBEN_DOCUMENTOS.has(pedido.estado)) {
        throw new ConflictException(
          'El pedido no está en una etapa en la que se reciban documentos operativos',
        );
      }

      const fecha = dto.tipo === 'reporte_job' ? dia(dto.fecha as string) : null;
      // Un día que Facturación ya corrigió no se vuelve a pisar con lo que reenvíe el ticket.
      const corregido = await tx.documentoOperativo.findFirst({
        where: { pedidoId, tipo: dto.tipo, origen: dto.origen, fecha, corregidoAt: { not: null } },
        select: { id: true },
      });
      if (corregido) {
        throw new ConflictException(
          'Facturación corrigió este día: el ticket ya no puede reenviarlo',
        );
      }
      // Reemplazo idempotente: el documento con la misma clave se sustituye (sus hijos caen en cascada).
      await tx.documentoOperativo.deleteMany({
        where: { pedidoId, tipo: dto.tipo, origen: dto.origen, fecha },
      });
      const id = uuidv7();
      await tx.documentoOperativo.create({
        data: {
          id,
          pedidoId,
          tipo: dto.tipo,
          origen: dto.origen,
          ticketRef: dto.ticketRef ?? null,
          fecha,
          firmadoPor: dto.firmadoPor ?? null,
          firmadoAt: dto.firmadoAt ? new Date(dto.firmadoAt) : null,
          supervisorId: dto.supervisorId ?? null,
          operadorId: dto.operadorId ?? null,
          recibidoPor: actor.id,
        },
      });
      if (dto.tipo === 'reporte_job') {
        await this.guardarActividades(tx, id, dto.actividades ?? []);
      } else {
        for (const [i, h] of (dto.herramientas ?? []).entries()) {
          await this.herramienta(tx, id, h, i);
        }
      }

      // Primer documento: el servicio está en curso. El estado avanza por el motor, paso a paso.
      let estado = pedido.estado;
      const pasos: string[] = [];
      if (estado === 'abierto') pasos.push('en_operacion');
      if (estado === 'abierto' || estado === 'en_operacion') pasos.push('en_elaboracion_operativa');
      for (const hacia of pasos) {
        await this.estados.pasar(
          tx,
          pedidoId,
          estado,
          hacia,
          actor,
          'documento operativo recibido',
        );
        estado = hacia;
      }

      // Si con este documento la documentación queda completa, el pedido pasa a "documentos completos".
      const avance = await this.avanceEn(tx, pedidoId);
      if (
        avance.completo &&
        (estado === 'abierto' || estado === 'en_operacion' || estado === 'en_elaboracion_operativa')
      ) {
        await this.estados.pasar(
          tx,
          pedidoId,
          estado,
          'documentos_completos',
          actor,
          'documentación completa',
        );
        estado = 'documentos_completos';
      }

      await this.bus.publish(
        tx,
        this.bus.create({
          type: 'comercial.documento_operativo.recibido',
          subject: { type: 'pedido', id: pedidoId },
          data: {
            pedidoId,
            documentoId: id,
            tipo: dto.tipo,
            origen: dto.origen,
            fecha: aDia(fecha),
          },
          actor: { userId: actor.id, role: actor.roleCode },
          traceparent: currentTraceparent(),
        }),
      );
      return { id, estado, avance };
    });
    return { documentoId: resultado.id, estadoPedido: resultado.estado, avance: resultado.avance };
  }

  async listar(pedidoId: string, tipo?: string) {
    await this.existePedido(pedidoId);
    const docs = await this.prisma.documentoOperativo.findMany({
      where: {
        pedidoId,
        ...(tipo ? { tipo: tipo as 'reporte_job' | 'reporte_herramientas' } : {}),
      },
      include: {
        actividades: {
          orderBy: { orden: 'asc' },
          include: {
            tablas: {
              orderBy: { orden: 'asc' },
              include: {
                columnas: { orderBy: { orden: 'asc' } },
                filas: { orderBy: { orden: 'asc' }, include: { celdas: true } },
              },
            },
          },
        },
        herramientas: {
          orderBy: { orden: 'asc' },
          include: { usos: { orderBy: { fecha: 'asc' } } },
        },
        supervisor: true,
        operador: true,
      },
      orderBy: [{ tipo: 'asc' }, { fecha: 'asc' }, { recibidoAt: 'asc' }],
    });
    return docs.map((d) => ({
      id: d.id,
      tipo: d.tipo,
      origen: d.origen,
      ticketRef: d.ticketRef,
      fecha: aDia(d.fecha),
      firmadoPor: d.firmadoPor,
      firmadoAt: d.firmadoAt,
      supervisor: d.supervisor ? { id: d.supervisor.id, nombre: d.supervisor.nombre } : null,
      operador: d.operador ? { id: d.operador.id, nombre: d.operador.nombre } : null,
      recibidoAt: d.recibidoAt,
      corregidoAt: d.corregidoAt,
      corregidoPor: d.corregidoPor,
      actividades: d.actividades.map((a) => ({
        orden: a.orden,
        fecha: aDia(a.fecha),
        horaInicio: a.horaInicio,
        horaFin: a.horaFin,
        duracionHoras: Number(a.duracionHoras),
        detalle: a.detalle,
        autor: a.autor,
        tablas: a.tablas.map((t) => ({
          titulo: t.titulo,
          columnas: t.columnas.map((c) => c.encabezado),
          filas: t.filas.map((f) =>
            t.columnas.map((c) => f.celdas.find((x) => x.columnaId === c.id)?.valor ?? ''),
          ),
        })),
      })),
      herramientas: d.herramientas.map((h) => ({
        orden: h.orden,
        nombre: h.nombre,
        serie: h.serie,
        codigo: h.codigo,
        unidad: h.unidad,
        cantidad: h.cantidad === null ? null : Number(h.cantidad),
        usos: h.usos.map((u) => ({ fecha: aDia(u.fecha), estado: u.estado })),
      })),
    }));
  }

  /**
   * Facturación corrige un día del Reporte Job (actividades y tablas). Solo antes de que el pedido salga al cliente
   * para firmas. Una lista vacía quita el día. Desde la corrección, el ticket ya no puede reenviar ese día.
   */
  async corregirDia(pedidoId: string, dto: CorregirDiaOperativoDto, actor: AuthUser) {
    const fecha = dia(dto.fecha);
    const raros = dto.actividades.filter((a) => a.fecha.slice(0, 10) !== dto.fecha.slice(0, 10));
    if (raros.length)
      throw new BadRequestException('Todas las actividades deben ser del día corregido');
    return this.prisma.$transaction(async (tx) => {
      const pedido = await tx.pedido.findUnique({
        where: { id: pedidoId },
        select: { id: true, estado: true },
      });
      if (!pedido) throw new NotFoundException('El pedido no existe');
      if (!ADMITEN_CORRECCION.has(pedido.estado)) {
        throw new ConflictException(
          'El pedido ya salió al cliente para firmas: sus documentos operativos no se corrigen',
        );
      }
      const previo = await tx.documentoOperativo.findFirst({
        where: { pedidoId, tipo: 'reporte_job', origen: dto.origen, fecha },
      });
      await tx.documentoOperativo.deleteMany({
        where: { pedidoId, tipo: 'reporte_job', origen: dto.origen, fecha },
      });
      let documentoId: string | null = null;
      if (dto.actividades.length || previo) {
        // Con la lista vacía se deja un documento corregido sin actividades: así el ticket no reenvía el día quitado.
        documentoId = uuidv7();
        await tx.documentoOperativo.create({
          data: {
            id: documentoId,
            pedidoId,
            tipo: 'reporte_job',
            origen: dto.origen,
            ticketRef: previo?.ticketRef ?? null,
            fecha,
            firmadoPor: previo?.firmadoPor ?? null,
            firmadoAt: previo?.firmadoAt ?? null,
            supervisorId: previo?.supervisorId ?? null,
            operadorId: previo?.operadorId ?? null,
            recibidoPor: previo?.recibidoPor ?? actor.id,
            corregidoAt: new Date(),
            corregidoPor: actor.id,
          },
        });
        await this.guardarActividades(tx, documentoId, dto.actividades);
      }
      await this.bus.publish(
        tx,
        this.bus.create({
          type: 'comercial.documento_operativo.corregido',
          subject: { type: 'pedido', id: pedidoId },
          data: { pedidoId, documentoId, origen: dto.origen, fecha: aDia(fecha) },
          actor: { userId: actor.id, role: actor.roleCode },
          traceparent: currentTraceparent(),
        }),
      );
      return { documentoId, avance: await this.avanceEn(tx, pedidoId) };
    });
  }

  async avance(pedidoId: string): Promise<Avance> {
    await this.existePedido(pedidoId);
    return this.avanceEn(this.prisma, pedidoId);
  }

  async eliminar(pedidoId: string, documentoId: string): Promise<void> {
    const pedido = await this.existePedido(pedidoId);
    if (!RECIBEN_DOCUMENTOS.has(pedido.estado)) {
      throw new ConflictException('El pedido ya no admite cambios en sus documentos operativos');
    }
    const r = await this.prisma.documentoOperativo.deleteMany({
      where: { id: documentoId, pedidoId },
    });
    if (r.count === 0) throw new NotFoundException('El documento no existe en este pedido');
  }

  // =============================================================================================================

  /** El avance documental. Las condiciones de la guía y del PTW de QHSE se suman cuando esos módulos existan. */
  private async avanceEn(
    db: Pick<
      PrismaService,
      'pedido' | 'documentoOperativo' | 'documentoOperativoUso' | 'guiaRemision' | 'pedidoItem'
    >,
    pedidoId: string,
  ): Promise<Avance> {
    const pedido = await db.pedido.findUniqueOrThrow({
      where: { id: pedidoId },
      select: {
        fechaInicioServicio: true,
        fechaFinServicio: true,
        linea: { select: { codigo: true } },
      },
    });
    const dias = await db.documentoOperativo.findMany({
      // Un día quitado por Facturación queda como documento corregido sin actividades: no cuenta como reportado.
      where: {
        pedidoId,
        tipo: 'reporte_job',
        NOT: { corregidoAt: { not: null }, actividades: { none: {} } },
      },
      select: { fecha: true },
    });
    const conReporte = new Set(dias.map((d) => aDia(d.fecha)));
    const ini = pedido.fechaInicioServicio;
    const fin = pedido.fechaFinServicio;
    const diasEsperados =
      ini && fin
        ? Math.max(1, Math.round((fin.getTime() - ini.getTime()) / MS_DIA) + 1)
        : conReporte.size;

    const requiereHerramientas = pedido.linea?.codigo !== 'pumping';
    const herramientas = await db.documentoOperativo.count({
      where: { pedidoId, tipo: 'reporte_herramientas' },
    });
    const usoVenta =
      (await db.documentoOperativoUso.count({
        where: { estado: 'venta', herramienta: { documento: { pedidoId } } },
      })) > 0;
    const guiaRegistrada =
      (await this.prisma.guiaRemision.count({ where: { pedidoId, estado: 'emitida' } })) > 0;
    const materiales = await this.prisma.pedidoItem.count({
      where: { pedidoId, listaPreciosItem: { tipo: 'Material' } },
    });
    const guiaSugerida = herramientas > 0 || materiales > 0;

    const pendientes: string[] = [];
    if (conReporte.size === 0) pendientes.push('el Reporte Job');
    else if (conReporte.size < diasEsperados) {
      pendientes.push(`Reporte Job de ${diasEsperados - conReporte.size} día(s)`);
    }
    if (requiereHerramientas && herramientas === 0) pendientes.push('el Reporte de Herramientas');
    if (usoVenta && !guiaRegistrada)
      pendientes.push('la guía de remisión (hay herramientas vendidas)');

    return {
      completo: pendientes.length === 0,
      diasEsperados,
      diasConReporteJob: conReporte.size,
      reporteHerramientasRequerido: requiereHerramientas,
      reporteHerramientasRecibido: herramientas > 0,
      usoVenta,
      guiaRequerida: usoVenta,
      guiaRegistrada,
      guiaSugerida,
      pendientes,
    };
  }

  private validar(dto: RecibirDocumentoOperativoDto) {
    if (dto.tipo === 'reporte_job') {
      if (!dto.fecha) throw new BadRequestException('El Reporte Job lleva la fecha del día');
      if (dto.herramientas?.length)
        throw new BadRequestException('El Reporte Job no lleva herramientas');
      const raros = (dto.actividades ?? []).filter(
        (a) => a.fecha.slice(0, 10) !== dto.fecha?.slice(0, 10),
      );
      if (raros.length)
        throw new BadRequestException('Todas las actividades deben ser del día del reporte');
    } else {
      if (dto.fecha)
        throw new BadRequestException(
          'El Reporte de Herramientas es uno por servicio: no lleva fecha',
        );
      if (dto.actividades?.length)
        throw new BadRequestException('El Reporte de Herramientas no lleva actividades');
    }
  }

  /** Guarda las actividades de un Reporte Job con sus tablas (encabezados, filas y celdas). */
  private async guardarActividades(
    tx: Prisma.TransactionClient,
    documentoId: string,
    actividades: ActividadOperativaDto[],
  ) {
    for (const [orden, a] of actividades.entries()) {
      const actividadId = uuidv7();
      await tx.documentoOperativoActividad.create({
        data: {
          id: actividadId,
          documentoId,
          orden,
          fecha: dia(a.fecha),
          horaInicio: a.horaInicio,
          horaFin: a.horaFin,
          duracionHoras: a.duracionHoras,
          detalle: a.detalle,
          autor: a.autor ?? null,
        },
      });
      for (const [ordenTabla, t] of (a.tablas ?? []).entries()) {
        const tablaId = uuidv7();
        await tx.documentoOperativoActividadTabla.create({
          data: { id: tablaId, actividadId, orden: ordenTabla, titulo: t.titulo ?? null },
        });
        const columnas = t.columnas.map((encabezado, i) => ({
          id: uuidv7(),
          orden: i,
          encabezado,
        }));
        await tx.documentoOperativoTablaColumna.createMany({
          data: columnas.map((c) => ({ ...c, tablaId })),
        });
        for (const [ordenFila, valores] of t.filas.entries()) {
          if (valores.length !== columnas.length) {
            throw new BadRequestException(
              'Cada fila de una tabla debe tener una celda por encabezado',
            );
          }
          const filaId = uuidv7();
          await tx.documentoOperativoTablaFila.create({
            data: { id: filaId, tablaId, orden: ordenFila },
          });
          await tx.documentoOperativoTablaCelda.createMany({
            data: columnas.map((c, i) => ({ filaId, columnaId: c.id, valor: String(valores[i]) })),
          });
        }
      }
    }
  }

  private async herramienta(
    tx: Prisma.TransactionClient,
    documentoId: string,
    h: HerramientaOperativaDto,
    orden: number,
  ) {
    const id = uuidv7();
    await tx.documentoOperativoHerramienta.create({
      data: {
        id,
        documentoId,
        orden,
        nombre: h.nombre,
        serie: h.serie ?? null,
        codigo: h.codigo ?? null,
        unidad: h.unidad ?? null,
        cantidad: h.cantidad ?? null,
      },
    });
    const unicos = new Map(h.usos.map((u) => [u.fecha.slice(0, 10), u.estado]));
    if (unicos.size) {
      await tx.documentoOperativoUso.createMany({
        data: [...unicos].map(([f, estado]) => ({
          id: uuidv7(),
          herramientaId: id,
          fecha: dia(f),
          estado,
        })),
      });
    }
  }

  private async existePedido(id: string) {
    const p = await this.prisma.pedido.findUnique({
      where: { id },
      select: { id: true, estado: true },
    });
    if (!p) throw new NotFoundException('El pedido no existe');
    return p;
  }
}
