import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { currentTraceparent, type AuthUser } from '@dyn/common';
import { EventBus } from '@dyn/messaging';
import { uuidv7 } from '@dyn/utils';
import { TipoDocumentoPedido, type Prisma } from '../generated/client';
import { texto, type Tx } from '../epi/epi-tipos';
import { PrismaService } from '../prisma/prisma.service';
import { codigoPtw } from '../ptw/ptw-documentos';

/** Código del módulo de archivos que guarda cada tipo (el archivo debe haberse subido por ahí: así se verifica el permiso de subida). */
export const MODULO_ARCHIVO_ACTA = 'qhse_acta_entrega';
export const MODULO_ARCHIVO_DOCUMENTO = 'qhse_documento_pedido';

/** Vigencia legal del ART (días desde su emisión). */
export const VIGENCIA_ART_DIAS = 15;

const FECHA = /^\d{4}-\d{2}-\d{2}$/;

export interface CargarDocumentoEntrada {
  pedidoId: string;
  ticketId?: string | null;
  tipo: TipoDocumentoPedido;
  archivoId: string;
  referencia?: string | null;
  /** AAAA-MM-DD. ART: emisión. PT: día de operación. */
  fecha?: string | null;
  /** Solo el Acta, cuando la sube alguien que no es el supervisor asignado. */
  motivoSuplencia?: string | null;
}

const aFecha = (s: string): Date => new Date(`${s}T00:00:00.000Z`);
const enActor = (a: AuthUser) => ({ userId: a.id, role: a.roleCode });

/**
 * Documentos de seguridad de un pedido (contrato 4.11): formato de recepción, ART, PT, SFI y Acta de Entrega de Locación. Son historia:
 * se cargan y se anulan (con motivo), nunca se editan ni se borran (la base lo garantiza con privilegios por columna). El Acta, además,
 * publica `qhse.acta_entrega.cargada|anulada`, que Pumping usa para cumplir o reabrir el requisito de cierre del ticket.
 */
@Injectable()
export class DocumentosPedidoService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: EventBus,
  ) {}

  /** Documentos de un pedido, o de un ticket (el Acta). Por defecto solo los vigentes. */
  async listar(filtro: {
    pedidoId?: string;
    ticketId?: string;
    tipo?: TipoDocumentoPedido;
    incluirAnulados?: boolean;
  }) {
    if (!filtro.pedidoId && !filtro.ticketId)
      throw new BadRequestException('Indique el pedido o el ticket');
    return this.consultar({
      ...(filtro.pedidoId ? { pedidoId: filtro.pedidoId } : {}),
      ...(filtro.ticketId ? { ticketId: filtro.ticketId } : {}),
      ...(filtro.tipo ? { tipo: filtro.tipo } : {}),
      ...(filtro.incluirAnulados ? {} : { anuladoAt: null }),
    });
  }

  private async consultar(where: Prisma.DocumentoPedidoWhereInput) {
    const filas = await this.prisma.documentoPedido.findMany({
      where,
      orderBy: [{ tipo: 'asc' }, { createdAt: 'desc' }],
      include: {
        ticket: { select: { ticketNumero: true, pedidoCodigo: true, supervisorId: true } },
        creador: { select: { nombre: true } },
        anulador: { select: { nombre: true } },
      },
    });
    const hoy = new Date().toISOString().slice(0, 10);
    return filas.map((d) => ({
      id: d.id,
      pedidoId: d.pedidoId,
      pedidoCodigo: d.ticket?.pedidoCodigo ?? null,
      ticketId: d.ticketId,
      ticketNumero: d.ticket?.ticketNumero ?? null,
      tipo: d.tipo,
      archivoId: d.archivoId,
      referencia: d.referencia,
      motivoSuplencia: d.motivoSuplencia,
      fecha: d.fecha?.toISOString().slice(0, 10) ?? null,
      vigenteHasta: d.vigenteHasta?.toISOString().slice(0, 10) ?? null,
      // solo el ART vence; se calcula (no se guarda) contra el día de hoy
      vencido: d.vigenteHasta ? d.vigenteHasta.toISOString().slice(0, 10) < hoy : false,
      cargadoPor: d.creador.nombre,
      createdAt: d.createdAt,
      anulado: d.anuladoAt !== null,
      anuladoAt: d.anuladoAt,
      anuladoPor: d.anulador?.nombre ?? null,
      motivoAnulacion: d.motivoAnulacion,
    }));
  }

  /** El Acta de un ticket (vigente y anuladas) con el supervisor asignado, para que la pantalla sepa si quien sube es suplente. */
  async actaDelTicket(ticketId: string) {
    const t = await this.prisma.ticketRef.findUnique({
      where: { ticketId },
      select: { supervisor: { select: { id: true, nombre: true } } },
    });
    if (!t) throw new NotFoundException('QHSE no conoce ese ticket');
    const documentos = await this.listar({
      ticketId,
      tipo: TipoDocumentoPedido.formato_entrega,
      incluirAnulados: true,
    });
    return { supervisorAsignado: t.supervisor, documentos };
  }

  /** Carga ART, PT, SFI o el formato de recepción (el Acta tiene su propio camino: `cargarActa`). */
  async cargar(entrada: CargarDocumentoEntrada, actor: AuthUser) {
    if (entrada.tipo === TipoDocumentoPedido.formato_entrega)
      throw new BadRequestException(
        'El Acta de Entrega de Locación se carga desde el ticket (cargarActa)',
      );
    const id = await this.prisma.$transaction(async (tx) => {
      const id = await this.insertar(tx, entrada, MODULO_ARCHIVO_DOCUMENTO, actor);
      await this.publicar(tx, 'qhse.documento_pedido.cargado', id, actor);
      return id;
    });
    return this.uno(id);
  }

  /** El Supervisor sube el Acta al finalizar el ticket (una vigente por pedido). */
  async cargarActa(
    ticketId: string,
    entrada: { archivoId: string; referencia?: string | null; motivoSuplencia?: string | null },
    actor: AuthUser,
  ) {
    const id = await this.prisma.$transaction(async (tx) => {
      const t = await tx.ticketRef.findUnique({ where: { ticketId } });
      if (!t)
        throw new NotFoundException('QHSE no conoce ese ticket (aún no se creó o no se asignó)');
      // la sube el supervisor asignado; si es otra persona debe decir por qué el asignado no pudo (lo exige también la base)
      const motivo = texto(entrada.motivoSuplencia);
      const esSuplente = t.supervisorId !== null && t.supervisorId !== actor.id;
      if (esSuplente && !motivo)
        throw new BadRequestException(
          'El Acta la sube el supervisor asignado al ticket. Si la sube usted, indique por qué el supervisor asignado no pudo',
        );
      const id = await this.insertar(
        tx,
        {
          pedidoId: t.pedidoId,
          ticketId,
          tipo: TipoDocumentoPedido.formato_entrega,
          archivoId: entrada.archivoId,
          referencia: entrada.referencia,
          motivoSuplencia: esSuplente ? motivo : null,
        },
        MODULO_ARCHIVO_ACTA,
        actor,
      );
      await this.publicar(tx, 'qhse.acta_entrega.cargada', id, actor);
      return id;
    });
    return this.uno(id);
  }

  /** Anula un documento (cualquier tipo) con su motivo; si es el Acta, el ticket vuelve a exigirla. */
  async anular(id: string, motivo: string, actor: AuthUser) {
    const m = texto(motivo);
    if (!m) throw new BadRequestException('Indique el motivo de la anulación');
    await this.prisma.$transaction(async (tx) => {
      const d = await tx.documentoPedido.findUnique({ where: { id } });
      if (!d) throw new NotFoundException('El documento no existe');
      if (d.anuladoAt) throw new ConflictException('El documento ya está anulado');
      // un documento en uso por un PTW vigente no se anula (la base también lo impide: trigger documento_pedido_en_uso)
      const enUso = await tx.ptw.findFirst({
        where: {
          anuladoAt: null,
          OR: [
            { documentoRecepcionId: id },
            { documentoArtId: id },
            { documentoPtId: id },
            { documentoSfiId: id },
          ],
        },
        select: { numero: true },
      });
      if (enUso)
        throw new ConflictException(
          `El documento está en uso por el PTW ${codigoPtw(enUso.numero)}; anule primero ese PTW`,
        );
      await tx.documentoPedido.update({
        where: { id },
        data: {
          anuladoAt: new Date(),
          anuladoPor: actor.id,
          motivoAnulacion: m,
          updatedBy: actor.id,
        },
      });
      await this.publicar(
        tx,
        d.tipo === TipoDocumentoPedido.formato_entrega
          ? 'qhse.acta_entrega.anulada'
          : 'qhse.documento_pedido.anulado',
        id,
        actor,
        m,
      );
    });
    return this.uno(id);
  }

  // ------------------------------------------------------------------------------------------------------- internos

  private async uno(id: string) {
    const [fila] = await this.consultar({ id });
    return fila;
  }

  private async insertar(
    tx: Tx,
    e: CargarDocumentoEntrada,
    moduloArchivo: string,
    actor: AuthUser,
  ): Promise<string> {
    const archivo = await tx.archivoRef.findUnique({
      where: { id: e.archivoId },
      select: { eliminadoAt: true, modulo: { select: { codigo: true } } },
    });
    if (!archivo || archivo.eliminadoAt) throw new BadRequestException('El archivo no existe');
    if (archivo.modulo.codigo !== moduloArchivo)
      throw new BadRequestException(
        'El archivo no se subió como documento de seguridad de este tipo: súbalo de nuevo desde esta pantalla',
      );

    // un pedido solo es válido si QHSE lo conoce por alguno de sus tickets (otro contenedor: no hay FK)
    if (!(await tx.ticketRef.count({ where: { pedidoId: e.pedidoId } })))
      throw new BadRequestException('QHSE no conoce ese pedido (no tiene tickets registrados)');
    if (e.ticketId) {
      const t = await tx.ticketRef.findFirst({
        where: { ticketId: e.ticketId, pedidoId: e.pedidoId },
      });
      if (!t) throw new BadRequestException('El ticket indicado no pertenece a ese pedido');
    }

    const fecha = this.fecha(e.tipo, e.fecha);
    const vigenteHasta =
      e.tipo === TipoDocumentoPedido.art && fecha
        ? new Date(fecha.getTime() + VIGENCIA_ART_DIAS * 86_400_000)
        : null;

    await this.exigirSinVigente(tx, e, fecha);
    const id = uuidv7();
    await tx.documentoPedido.create({
      data: {
        id,
        pedidoId: e.pedidoId,
        ticketId: e.ticketId ?? null,
        tipo: e.tipo,
        archivoId: e.archivoId,
        referencia: texto(e.referencia),
        motivoSuplencia: texto(e.motivoSuplencia),
        fecha,
        vigenteHasta,
        createdBy: actor.id,
      },
    });
    return id;
  }

  /** ART y PT exigen fecha; el resto no la lleva. La fecha debe existir (no el 31 de febrero). */
  private fecha(tipo: TipoDocumentoPedido, valor?: string | null): Date | null {
    const lleva = tipo === TipoDocumentoPedido.art || tipo === TipoDocumentoPedido.pt;
    if (!lleva) return null;
    const crudo = valor?.trim();
    const f = crudo && FECHA.test(crudo) ? aFecha(crudo) : null;
    if (!f || Number.isNaN(f.getTime()) || f.toISOString().slice(0, 10) !== crudo)
      throw new BadRequestException(
        tipo === TipoDocumentoPedido.art
          ? 'Indique la fecha de emisión del ART (AAAA-MM-DD)'
          : 'Indique el día de operación del PT (AAAA-MM-DD)',
      );
    return f;
  }

  /** Mensajes claros antes de que lo rechace el índice único de la base (que sigue siendo la garantía). */
  private async exigirSinVigente(
    tx: Tx,
    e: CargarDocumentoEntrada,
    fecha: Date | null,
  ): Promise<void> {
    const unico: TipoDocumentoPedido[] = [
      TipoDocumentoPedido.formato_entrega,
      TipoDocumentoPedido.formato_recepcion,
      TipoDocumentoPedido.pt,
    ];
    if (!unico.includes(e.tipo)) return;
    const existe = await tx.documentoPedido.count({
      where: {
        pedidoId: e.pedidoId,
        tipo: e.tipo,
        anuladoAt: null,
        ...(e.tipo === TipoDocumentoPedido.pt ? { fecha } : {}),
      },
    });
    if (!existe) return;
    throw new ConflictException(
      e.tipo === TipoDocumentoPedido.formato_entrega
        ? 'Este pedido ya tiene su Acta de Entrega de Locación; para reemplazarla anule la vigente con su motivo'
        : e.tipo === TipoDocumentoPedido.pt
          ? 'Ya hay un PT vigente de ese pedido para ese día; anúlelo para cargar otro'
          : 'Este pedido ya tiene su formato de recepción; anúlelo para cargar otro',
    );
  }

  private async publicar(
    tx: Tx,
    tipo: string,
    documentoId: string,
    actor: AuthUser,
    motivo?: string,
  ): Promise<void> {
    const d = await tx.documentoPedido.findUniqueOrThrow({
      where: { id: documentoId },
      include: { ticket: { select: { ticketNumero: true, pedidoCodigo: true } } },
    });
    await this.bus.publish(
      tx,
      this.bus.create({
        type: tipo,
        subject: { type: 'documento_pedido', id: documentoId },
        data: {
          documentoId,
          tipoDocumento: d.tipo,
          pedidoId: d.pedidoId,
          ticketId: d.ticketId,
          archivoId: d.archivoId,
          ...(d.ticket
            ? { ticketNumero: d.ticket.ticketNumero, pedidoCodigo: d.ticket.pedidoCodigo }
            : {}),
          ...(d.vigenteHasta ? { vigenteHasta: d.vigenteHasta.toISOString().slice(0, 10) } : {}),
          ...(motivo ? { motivo } : {}),
        },
        actor: enActor(actor),
        traceparent: currentTraceparent(),
      }),
    );
  }
}
