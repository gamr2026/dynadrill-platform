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
import type {
  Prisma,
  ResponsableTrabajo,
  ResultadoParte,
  RolFirmaInspeccion,
} from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';
import { RequisitosService } from './requisitos.service';
import { esDelEquipo, nombreDe, TicketsService, type TicketParaMover } from './tickets.service';

const PASO_INSPECCION = 'inspeccion';
const PASO_APROBACION = 'aprobacion_supervisor_operaciones';
const PASO_PREPARACION = 'preparacion_herramientas';
const ROL_SUPERVISOR = 'supervisor';

const FIRMAS: readonly RolFirmaInspeccion[] = ['reparado_por', 'revisado_por', 'liberado_qhse'];
const ETIQUETA_FIRMA: Record<RolFirmaInspeccion, string> = {
  reparado_por: 'Reparado por',
  revisado_por: 'Revisado por',
  liberado_qhse: 'Liberado por QHSE',
};

export interface EncabezadoEntrada {
  fechaInspeccion?: string | null;
  fechaEnvio?: string | null;
  inspeccionadoPor?: ResponsableTrabajo | null;
  reparadoPor?: ResponsableTrabajo | null;
  observaciones?: string | null;
  numeroSerie?: string | null;
}

export interface ParteResultadoEntrada {
  visual?: ResultadoParte | null;
  endResultado?: ResultadoParte | null;
  cambioCantidad?: number | null;
  accion?: string | null;
}

export interface ParteNuevaEntrada {
  descripcion: string;
  codigo?: string;
  cantidadEsperada?: number;
}

const INCLUIR = {
  herramienta: {
    include: {
      articulo: { select: { codigo: true, nombre: true } },
      ticket: { include: { cliente: true, pozo: true } },
    },
  },
  partes: { orderBy: { orden: 'asc' } },
  firmas: { include: { usuario: { select: { id: true, nombre: true } } } },
  enviador: { select: { nombre: true } },
  decisor: { select: { nombre: true } },
} satisfies Prisma.InspeccionHerramientaInclude;
type InspeccionCompleta = Prisma.InspeccionHerramientaGetPayload<{ include: typeof INCLUIR }>;

const aDia = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const deDia = (f: string | null | undefined): Date | null => {
  if (!f) return null;
  const d = new Date(`${f}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== f)
    throw new BadRequestException('La fecha no es válida');
  return d;
};
const hoy = () => new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);

/**
 * Inspección y reparación de herramientas (entrada SERVICIOS). Una por herramienta del ticket: al iniciarla se COPIAN las partes del
 * artículo (un cambio posterior al catálogo no altera una inspección iniciada); si la herramienta no trae partes, o falta una, quien
 * inspecciona agrega partes a mano y solo esas se pueden quitar. Resultado visual y por END (ok o defectuoso) y cambio de elemento
 * (informativo: no mueve el kardex). Tres firmas en orden: reparado por (el operador que inspecciona), revisado por (el Supervisor del
 * ticket) y liberado por QHSE. Con las tres se envía; el Supervisor de Operaciones FCR aprueba o rechaza. Una inspección rechazada es
 * historia (inmutable) y se rehace como versión nueva con el mismo contenido y sin firmas.
 */
@Injectable()
export class InspeccionesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: EventBus,
    private readonly tickets: TicketsService,
    private readonly requisitos: RequisitosService,
  ) {}

  // ── lectura ─────────────────────────────────────────────────────────────────────────────────

  /** Cada herramienta del ticket con el resumen de su inspección vigente (o sin ella). */
  async listar(ticketId: string) {
    await this.existeTicket(ticketId);
    const herramientas = await this.prisma.ticketHerramienta.findMany({
      where: { ticketId },
      include: {
        articulo: { select: { codigo: true, nombre: true } },
        inspecciones: {
          orderBy: { version: 'desc' },
          take: 1,
          include: { firmas: { select: { rol: true } } },
        },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return herramientas.map((h) => {
      const i = h.inspecciones[0];
      return {
        herramientaId: h.id,
        codigo: h.articulo.codigo,
        nombre: h.articulo.nombre,
        inspeccion: i
          ? {
              id: i.id,
              version: i.version,
              estado: i.estado,
              firmas: i.firmas.map((f) => f.rol),
              motivoRechazo: i.motivoRechazo,
            }
          : null,
      };
    });
  }

  async obtener(ticketId: string, inspeccionId: string) {
    return this.vista(await this.cargar(this.prisma, ticketId, inspeccionId));
  }

  // ── de quien inspecciona ────────────────────────────────────────────────────────────────────

  /**
   * Inicia (o continúa) la inspección de una herramienta. Idempotente: si ya hay una vigente la devuelve tal cual. Si la última fue
   * rechazada, crea la versión siguiente con su contenido y sin firmas.
   */
  async iniciar(ticketId: string, herramientaId: string, actor: AuthUser) {
    const id = await this.prisma.$transaction(async (tx) => {
      const t = await this.tickets.cargarEnTx(tx, ticketId);
      this.exigirInspector(t, actor);
      const h = await tx.ticketHerramienta.findFirst({
        where: { id: herramientaId, ticketId },
        include: { articulo: true },
      });
      if (!h) throw new NotFoundException('La herramienta no existe en este ticket');
      const ultima = await tx.inspeccionHerramienta.findFirst({
        where: { herramientaId },
        orderBy: { version: 'desc' },
        include: { partes: { orderBy: { orden: 'asc' } } },
      });
      if (ultima && ultima.estado !== 'rechazada') return ultima.id;

      const nueva = uuidv7();
      if (ultima) {
        // la rechazada es historia: se rehace con el mismo contenido (resultados incluidos) y sin firmas
        await tx.inspeccionHerramienta.create({
          data: {
            id: nueva,
            herramientaId,
            version: ultima.version + 1,
            versionAnteriorId: ultima.id,
            fechaInspeccion: hoy(),
            fechaEnvio: ultima.fechaEnvio,
            inspeccionadoPor: ultima.inspeccionadoPor,
            reparadoPor: ultima.reparadoPor,
            observaciones: ultima.observaciones,
            createdBy: actor.id,
            updatedBy: actor.id,
          },
        });
        if (ultima.partes.length) {
          await tx.inspeccionParte.createMany({
            data: ultima.partes.map((p) => ({
              id: uuidv7(),
              inspeccionId: nueva,
              orden: p.orden,
              articuloParteId: p.articuloParteId,
              manual: p.manual,
              item: p.item,
              codigo: p.codigo,
              descripcion: p.descripcion,
              cantidadEsperada: p.cantidadEsperada,
              visual: p.visual,
              endResultado: p.endResultado,
              cambioCantidad: p.cambioCantidad,
              accion: p.accion,
            })),
          });
        }
      } else {
        await tx.inspeccionHerramienta.create({
          data: {
            id: nueva,
            herramientaId,
            fechaInspeccion: hoy(),
            createdBy: actor.id,
            updatedBy: actor.id,
          },
        });
        const partes = await tx.invArticuloParte.findMany({
          where: { articuloId: h.articuloId },
          orderBy: { orden: 'asc' },
        });
        if (partes.length) {
          await tx.inspeccionParte.createMany({
            data: partes.map((p) => ({
              id: uuidv7(),
              inspeccionId: nueva,
              orden: p.orden,
              articuloParteId: p.id,
              item: p.item,
              codigo: p.codigo,
              descripcion: p.descripcion,
              cantidadEsperada: p.cantidadEsperada,
            })),
          });
        }
      }
      await this.requisitos.sincronizarInspecciones(tx, ticketId, actor.id);
      return nueva;
    });
    return this.obtener(ticketId, id);
  }

  /** Guarda la cabecera (fechas, quién inspeccionó y reparó, nota y número de serie de la herramienta). */
  async guardarEncabezado(
    ticketId: string,
    inspeccionId: string,
    e: EncabezadoEntrada,
    actor: AuthUser,
  ) {
    await this.prisma.$transaction(async (tx) => {
      const t = await this.tickets.cargarEnTx(tx, ticketId);
      this.exigirInspector(t, actor);
      const i = await this.cargar(tx, ticketId, inspeccionId);
      this.exigirEditable(i);
      const data: Prisma.InspeccionHerramientaUncheckedUpdateInput = { updatedBy: actor.id };
      if (e.fechaInspeccion !== undefined) data.fechaInspeccion = deDia(e.fechaInspeccion);
      if (e.fechaEnvio !== undefined) data.fechaEnvio = deDia(e.fechaEnvio);
      if (e.inspeccionadoPor !== undefined) data.inspeccionadoPor = e.inspeccionadoPor;
      if (e.reparadoPor !== undefined) data.reparadoPor = e.reparadoPor;
      if (e.observaciones !== undefined) data.observaciones = e.observaciones?.trim() || null;
      await tx.inspeccionHerramienta.update({ where: { id: inspeccionId }, data });
      if (e.numeroSerie !== undefined) {
        await tx.ticketHerramienta.update({
          where: { id: i.herramientaId },
          data: { numeroSerie: e.numeroSerie?.trim() || null, updatedBy: actor.id },
        });
      }
    });
    return this.obtener(ticketId, inspeccionId);
  }

  async guardarParte(
    ticketId: string,
    inspeccionId: string,
    parteId: string,
    c: ParteResultadoEntrada,
    actor: AuthUser,
  ) {
    await this.prisma.$transaction(async (tx) => {
      const t = await this.tickets.cargarEnTx(tx, ticketId);
      this.exigirInspector(t, actor);
      this.exigirEditable(await this.cargar(tx, ticketId, inspeccionId));
      const parte = await tx.inspeccionParte.findFirst({ where: { id: parteId, inspeccionId } });
      if (!parte) throw new NotFoundException('La parte no existe en esta inspección');
      await tx.inspeccionParte.update({
        where: { id: parteId },
        data: {
          ...(c.visual !== undefined ? { visual: c.visual } : {}),
          ...(c.endResultado !== undefined ? { endResultado: c.endResultado } : {}),
          ...(c.cambioCantidad !== undefined ? { cambioCantidad: c.cambioCantidad } : {}),
          ...(c.accion !== undefined ? { accion: c.accion?.trim() || null } : {}),
        },
      });
    });
    return this.obtener(ticketId, inspeccionId);
  }

  /** Agrega una parte que la herramienta no traía en el catálogo. */
  async agregarParte(
    ticketId: string,
    inspeccionId: string,
    n: ParteNuevaEntrada,
    actor: AuthUser,
  ) {
    await this.prisma.$transaction(async (tx) => {
      const t = await this.tickets.cargarEnTx(tx, ticketId);
      this.exigirInspector(t, actor);
      this.exigirEditable(await this.cargar(tx, ticketId, inspeccionId));
      const descripcion = n.descripcion?.trim();
      if (!descripcion) throw new BadRequestException('La descripción de la parte es obligatoria');
      const ultima = await tx.inspeccionParte.findFirst({
        where: { inspeccionId },
        orderBy: { orden: 'desc' },
        select: { orden: true },
      });
      const orden = (ultima?.orden ?? 0) + 1;
      await tx.inspeccionParte.create({
        data: {
          id: uuidv7(),
          inspeccionId,
          orden,
          manual: true,
          item: `M${orden}`,
          codigo: n.codigo?.trim() || null,
          descripcion,
          cantidadEsperada: n.cantidadEsperada ?? 1,
        },
      });
    });
    return this.obtener(ticketId, inspeccionId);
  }

  /** Quita una parte agregada a mano (las copiadas del artículo no se quitan). */
  async quitarParte(ticketId: string, inspeccionId: string, parteId: string, actor: AuthUser) {
    await this.prisma.$transaction(async (tx) => {
      const t = await this.tickets.cargarEnTx(tx, ticketId);
      this.exigirInspector(t, actor);
      this.exigirEditable(await this.cargar(tx, ticketId, inspeccionId));
      const parte = await tx.inspeccionParte.findFirst({ where: { id: parteId, inspeccionId } });
      if (!parte) throw new NotFoundException('La parte no existe en esta inspección');
      if (!parte.manual) {
        throw new ConflictException('Solo se pueden quitar las partes agregadas a mano');
      }
      await tx.inspeccionParte.delete({ where: { id: parteId } });
    });
    return this.obtener(ticketId, inspeccionId);
  }

  // ── firmas y envío ──────────────────────────────────────────────────────────────────────────

  /**
   * Deja una de las tres firmas con la cuenta de quien firma y la hora del servidor. Cada firma exige la anterior y a quien corresponde
   * (la base lo exige además). «Reparado por» certifica los datos y las partes: desde ahí nadie los cambia.
   */
  async firmar(ticketId: string, inspeccionId: string, rol: RolFirmaInspeccion, actor: AuthUser) {
    await this.prisma.$transaction(async (tx) => {
      const t = await this.tickets.cargarEnTx(tx, ticketId);
      if (t.pasoCodigo !== PASO_INSPECCION) {
        throw new ConflictException('Las inspecciones se firman en el paso «Inspección»');
      }
      const i = await this.cargar(tx, ticketId, inspeccionId);
      this.exigirFirmable(i);
      const permitidos = await tx.firmaRolPermitido.findMany({ where: { rolFirma: rol } });
      if (!permitidos.some((p) => p.rolCodigo === actor.roleCode)) {
        throw new ForbiddenException(
          `La firma «${ETIQUETA_FIRMA[rol]}» la deja ${permitidos.map((p) => p.rolCodigo).join(' o ')}`,
        );
      }
      // quien repara es el operador que inspecciona; quien revisa, el Supervisor del ticket
      if (rol === 'reparado_por' && t.inspectorId !== actor.id) {
        throw new ForbiddenException(
          'Solo el operador asignado a la inspección firma «Reparado por»',
        );
      }
      if (rol === 'revisado_por' && !esDelEquipo(t, actor.id)) {
        throw new ForbiddenException('Solo el Supervisor de este ticket firma «Revisado por»');
      }
      const previa = FIRMAS[FIRMAS.indexOf(rol) - 1];
      if (previa && !i.firmas.some((f) => f.rol === previa)) {
        throw new ConflictException(`Primero debe firmar «${ETIQUETA_FIRMA[previa]}»`);
      }
      if (i.firmas.some((f) => f.rol === rol))
        throw new ConflictException('Esa firma ya está dejada');
      if (rol === 'reparado_por') {
        if (!i.inspeccionadoPor || !i.reparadoPor) {
          throw new BadRequestException('Indique quién inspeccionó y quién reparó antes de firmar');
        }
        // la fecha de revisión se fija sola y antes de la firma (después la base bloquea la cabecera)
        await tx.inspeccionHerramienta.update({
          where: { id: inspeccionId },
          data: { fechaReparacion: hoy(), updatedBy: actor.id },
        });
      }
      await tx.inspeccionFirma.create({
        data: { inspeccionId, rol, usuarioId: actor.id },
      });
    });
    return this.obtener(ticketId, inspeccionId);
  }

  /** Envía la inspección con sus tres firmas. */
  async enviar(ticketId: string, inspeccionId: string, actor: AuthUser) {
    await this.prisma.$transaction(async (tx) => {
      const t = await this.tickets.cargarEnTx(tx, ticketId);
      this.exigirInspector(t, actor);
      const i = await this.cargar(tx, ticketId, inspeccionId);
      this.exigirFirmable(i);
      const faltan = FIRMAS.filter((r) => !i.firmas.some((f) => f.rol === r));
      if (faltan.length) {
        throw new ConflictException(
          `Faltan firmas para enviar: ${faltan.map((r) => ETIQUETA_FIRMA[r]).join(', ')}`,
        );
      }
      await tx.inspeccionHerramienta.update({
        where: { id: inspeccionId },
        data: {
          estado: 'enviada',
          enviadaAt: new Date(),
          enviadaPor: actor.id,
          updatedBy: actor.id,
        },
      });
      await this.requisitos.sincronizarInspecciones(tx, ticketId, actor.id);
    });
    return this.obtener(ticketId, inspeccionId);
  }

  // ── del Supervisor de Operaciones FCR ───────────────────────────────────────────────────────

  /** Aprueba todas las inspecciones enviadas y pasa el ticket a la preparación de herramientas (donde confluyen las dos entradas). */
  async aprobar(ticketId: string, actor: AuthUser) {
    await this.prisma.$transaction(async (tx) => {
      const t = await this.tickets.cargarEnTx(tx, ticketId);
      this.exigirAprobador(t, actor);
      const vigentes = await tx.inspeccionHerramienta.findMany({
        where: { herramienta: { ticketId }, estado: { not: 'rechazada' } },
      });
      const herramientas = await tx.ticketHerramienta.count({ where: { ticketId } });
      if (
        !herramientas ||
        vigentes.length !== herramientas ||
        vigentes.some((v) => v.estado === 'borrador')
      ) {
        throw new ConflictException(
          'Todas las herramientas deben tener su inspección enviada para aprobar',
        );
      }
      await tx.inspeccionHerramienta.updateMany({
        where: { id: { in: vigentes.filter((v) => v.estado === 'enviada').map((v) => v.id) } },
        data: {
          estado: 'aprobada',
          decididaAt: new Date(),
          decididaPor: actor.id,
          updatedBy: actor.id,
        },
      });
      await this.tickets.moverPaso(tx, t, PASO_PREPARACION, actor, { exigirRequisitos: false });
    });
    return this.tickets.detalle(ticketId, actor);
  }

  /**
   * Rechaza las inspecciones enviadas (todas, o las de las herramientas indicadas) con el motivo, y devuelve el ticket a la inspección.
   * Las rechazadas quedan como historia; el operador las rehace como versión nueva. Se le avisa a quien inspecciona.
   */
  async rechazar(
    ticketId: string,
    motivo: string,
    herramientaIds: string[] | undefined,
    actor: AuthUser,
  ) {
    const texto = motivo?.trim();
    if (!texto) throw new BadRequestException('El motivo es obligatorio');
    await this.prisma.$transaction(async (tx) => {
      const t = await this.tickets.cargarEnTx(tx, ticketId);
      this.exigirAprobador(t, actor);
      const enviadas = await tx.inspeccionHerramienta.findMany({
        where: {
          herramienta: { ticketId },
          estado: 'enviada',
          ...(herramientaIds?.length ? { herramientaId: { in: herramientaIds } } : {}),
        },
      });
      if (herramientaIds?.length && enviadas.length !== new Set(herramientaIds).size) {
        throw new BadRequestException('Alguna herramienta no tiene una inspección enviada');
      }
      if (!enviadas.length)
        throw new ConflictException('No hay inspecciones enviadas que rechazar');
      await tx.inspeccionHerramienta.updateMany({
        where: { id: { in: enviadas.map((e) => e.id) } },
        data: {
          estado: 'rechazada',
          decididaAt: new Date(),
          decididaPor: actor.id,
          motivoRechazo: texto,
          updatedBy: actor.id,
        },
      });
      await this.requisitos.sincronizarInspecciones(tx, ticketId, actor.id);
      await this.tickets.moverPaso(tx, t, PASO_INSPECCION, actor, {
        motivo: texto,
        exigirRequisitos: false,
      });
      const n = await tx.ticket.findUniqueOrThrow({
        where: { id: ticketId },
        include: { cliente: true, pozo: true },
      });
      await this.bus.publish(
        tx,
        this.bus.create({
          type: 'operaciones.fcr.inspeccion_rechazada',
          subject: { type: 'fcr_ticket', id: ticketId },
          data: {
            ticketId,
            ticketNumero: n.ticketNumero,
            pedidoId: n.pedidoId,
            pedidoCodigo: n.pedidoCodigo,
            cliente: nombreDe(n.cliente),
            pozo: n.pozo?.nombreCompleto ?? null,
            cantidad: enviadas.length,
            motivo: texto,
            rechazadoPor: actor.name,
            asignados: n.inspectorId ? [{ usuarioId: n.inspectorId, rolCodigo: 'operador' }] : [],
          },
          actor: { userId: actor.id, role: actor.roleCode },
          traceparent: currentTraceparent(),
        }),
      );
    });
    return this.tickets.detalle(ticketId, actor);
  }

  // ── piezas internas ─────────────────────────────────────────────────────────────────────────

  /** El operador que inspecciona (SERVICIOS), con el ticket en el paso de inspección. */
  private exigirInspector(t: TicketParaMover, actor: AuthUser): void {
    if (t.tipoOt !== 'servicio') {
      throw new ConflictException(
        'Solo los tickets de servicios llevan inspección de herramientas',
      );
    }
    if (t.pasoCodigo !== PASO_INSPECCION) {
      throw new ConflictException('La inspección se hace en el paso «Inspección»');
    }
    if (actor.roleCode !== 'superadmin' && t.inspectorId !== actor.id) {
      throw new ForbiddenException('Solo el operador asignado a la inspección puede hacerlo');
    }
  }

  private exigirAprobador(t: TicketParaMover, actor: AuthUser): void {
    if (t.pasoCodigo !== PASO_APROBACION) {
      throw new ConflictException(`El ticket no está en «${PASO_APROBACION}»`);
    }
    this.tickets.exigirActuar(t, actor);
  }

  /** Se puede firmar mientras la inspección esté en borrador. */
  private exigirFirmable(i: { estado: string }): void {
    if (i.estado !== 'borrador')
      throw new ConflictException('La inspección ya fue enviada: no se puede cambiar');
  }

  /** Se puede editar en borrador y hasta que «Reparado por» firma: esa firma certifica los datos y las partes. */
  private exigirEditable(i: { estado: string; firmas: Array<{ rol: string }> }): void {
    this.exigirFirmable(i);
    if (i.firmas.some((f) => f.rol === 'reparado_por')) {
      throw new ConflictException(
        '«Reparado por» ya firmó: los datos y las partes quedaron bloqueados',
      );
    }
  }

  private async existeTicket(id: string): Promise<void> {
    if (!(await this.prisma.ticket.findUnique({ where: { id }, select: { id: true } })))
      throw new NotFoundException('El ticket no existe');
  }

  private async cargar(
    db: Prisma.TransactionClient | PrismaService,
    ticketId: string,
    inspeccionId: string,
  ): Promise<InspeccionCompleta> {
    const i = await db.inspeccionHerramienta.findUnique({
      where: { id: inspeccionId },
      include: INCLUIR,
    });
    if (!i || i.herramienta.ticketId !== ticketId) {
      throw new NotFoundException('La inspección no existe en este ticket');
    }
    return i;
  }

  /** La inspección como la ve la pantalla: la cabecera sale del ticket, del artículo y de la herramienta (JOIN). */
  private vista(i: InspeccionCompleta) {
    const t = i.herramienta.ticket;
    const firma = (rol: RolFirmaInspeccion) => {
      const f = i.firmas.find((x) => x.rol === rol);
      return f
        ? { usuarioId: f.usuarioId, nombre: f.usuario.nombre, firmadaAt: f.firmadaAt }
        : null;
    };
    return {
      id: i.id,
      herramientaId: i.herramientaId,
      version: i.version,
      estado: i.estado,
      cliente: nombreDe(t.cliente),
      pozo: t.pozo?.nombreCompleto ?? null,
      descripcionHerramienta: i.herramienta.articulo.nombre,
      codigoHerramienta: i.herramienta.articulo.codigo,
      numeroSerie: i.herramienta.numeroSerie,
      fechaInspeccion: aDia(i.fechaInspeccion),
      fechaReparacion: aDia(i.fechaReparacion),
      fechaEnvio: aDia(i.fechaEnvio),
      inspeccionadoPor: i.inspeccionadoPor,
      reparadoPor: i.reparadoPor,
      observaciones: i.observaciones,
      enviadaAt: i.enviadaAt,
      enviadaPor: i.enviador?.nombre ?? null,
      decididaAt: i.decididaAt,
      decididaPor: i.decisor?.nombre ?? null,
      motivoRechazo: i.motivoRechazo,
      firmas: Object.fromEntries(FIRMAS.map((r) => [r, firma(r)])),
      partes: i.partes.map((p) => ({
        id: p.id,
        orden: p.orden,
        item: p.item,
        codigo: p.codigo,
        descripcion: p.descripcion,
        cantidadEsperada: p.cantidadEsperada,
        visual: p.visual,
        endResultado: p.endResultado,
        cambioCantidad: p.cambioCantidad,
        accion: p.accion,
        manual: p.manual,
      })),
    };
  }
}
