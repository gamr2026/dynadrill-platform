import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { currentTraceparent, type AuthUser } from '@dyn/common';
import { EventBus } from '@dyn/messaging';
import { uuidv7 } from '@dyn/utils';
import { DirectorioPort } from '../directorio/directorio.port';
import {
  AgregarFirmaDto,
  EnviarPrefacturaDto,
  FirmaCompanyManDto,
  FirmarPrefacturaDto,
  RechazarPrefacturaDto,
} from '../dto/prefacturas.dto';
import type { Prisma } from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';
import { calcularPrefactura, ItemLista, TasasAplicadas } from '../prefacturas/calculo';
import { filasParaAs2 } from '../prefacturas/exportacion-as2';
import { DocumentosOperativosService } from './documentos-operativos.service';
import { PedidoEstadoService } from './pedido-estado.service';
import { SecuenciasService } from './secuencias.service';

export interface ContextoPrefactura {
  actor: AuthUser;
  token: string;
}

/** Estados en los que la prefactura está vigente (solo una por pedido). */
const VIGENTES = ['generada', 'enviada_para_firmas', 'firmada'] as const;
/** Pedido listo para generar la prefactura. Los de operación pasan solos a "documentos completos" si la documentación está completa. */
const EN_OPERACION = ['abierto', 'en_operacion', 'en_elaboracion_operativa'];
const PUEDEN_GENERAR = ['documentos_completos', 'en_revision_prefacturacion', ...EN_OPERACION];

const num = (d: Prisma.Decimal | number | null | undefined) =>
  d === null || d === undefined ? null : Number(d);
const dia = (iso: string) => new Date(`${iso.slice(0, 10)}T00:00:00.000Z`);
const aDia = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

const INCLUDE = {
  items: { orderBy: { orden: 'asc' } },
  advertencias: { orderBy: { orden: 'asc' } },
  firmas: { orderBy: { createdAt: 'asc' }, include: { archivo: true } },
} as const;

type PrefacturaCompleta = Prisma.PrefacturaGetPayload<{ include: typeof INCLUDE }>;

const aDto = (p: PrefacturaCompleta) => ({
  id: p.id,
  pedidoId: p.pedidoId,
  version: p.version,
  estado: p.estado,
  ticketNumero: p.ticketNumero,
  totales: {
    subtotalServicios: num(p.subtotalServicios),
    subtotalMateriales: num(p.subtotalMateriales),
    subtotal: num(p.subtotal),
    iva: num(p.iva),
    retencionIr: num(p.retencionIr),
    retencionIva: num(p.retencionIva),
    netoCobrar: num(p.netoCobrar),
  },
  tasas: {
    ivaPct: num(p.ivaPct),
    retencionIrPct: num(p.retencionIrPct),
    retencionIvaPct: num(p.retencionIvaPct),
  },
  generadaAt: p.generadaAt,
  enviadaAt: p.enviadaAt,
  medioEnvio: p.medioEnvio,
  razonRetraso: p.razonRetraso,
  firmadaAt: p.firmadaAt,
  rechazo: p.rechazadaAt
    ? { at: p.rechazadaAt, motivo: p.rechazoMotivo, devueltoA: p.rechazoDevueltoA }
    : null,
  items: p.items.map((i) => ({
    orden: i.orden,
    codigo: i.codigo,
    descripcion: i.descripcion,
    unidad: i.unidad,
    serie: i.serie,
    cantidad: num(i.cantidad),
    precioUnitario: num(i.precioUnitario),
    descuentoPct: num(i.descuentoPct),
    precioTotal: num(i.precioTotal),
    tipo: i.tipo,
    fuente: i.fuente,
  })),
  advertencias: p.advertencias.map((a) => a.mensaje),
  firmas: p.firmas.map((f) => ({
    id: f.id,
    firmanteTipo: f.firmanteTipo,
    personaId: f.personaId,
    nombre: f.nombre,
    cargo: f.cargo,
    firmadoAt: aDia(f.firmadoAt),
    /** Cuándo se registró en el portal (el día de la firma está en `firmadoAt`). */
    registradaAt: f.createdAt,
    archivoId: f.archivoId,
    archivoNombre: f.archivo.nombreOriginal,
    verificacion: f.verificacion,
    verificacionConfianza: num(f.verificacionConfianza),
    verificacionAt: f.verificacionAt,
    nombreCoincide: f.nombreCoincide,
  })),
});

/**
 * Prefactura del pedido: la calcula (lista de precios + reportes operativos + ítems del pedido), la lleva por su ciclo
 * (generada → enviada → firmada | rechazada) y mueve el estado del pedido por el motor de estados. Una prefactura
 * rechazada se conserva; regenerar crea una versión nueva.
 */
@Injectable()
export class PrefacturasService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly documentos: DocumentosOperativosService,
    private readonly estados: PedidoEstadoService,
    private readonly secuencias: SecuenciasService,
    private readonly directorio: DirectorioPort,
    private readonly bus: EventBus,
  ) {}

  async listarDePedido(pedidoId: string) {
    await this.pedido(pedidoId);
    const filas = await this.prisma.prefactura.findMany({
      where: { pedidoId },
      include: INCLUDE,
      orderBy: { version: 'desc' },
    });
    return filas.map(aDto);
  }

  async detalle(id: string) {
    return aDto(await this.cargar(id));
  }

  /** Líneas de la prefactura firmada en el formato de la plantilla de carga de AS2. */
  async exportacionAs2(id: string) {
    const p = await this.cargar(id);
    if (p.estado !== 'firmada') {
      throw new ConflictException('Solo se exporta a AS2 una prefactura firmada por el cliente');
    }
    const { filas, advertencias } = filasParaAs2(
      p.items.map((i) => ({
        codigo: i.codigo,
        descripcion: i.descripcion,
        unidad: i.unidad,
        cantidad: Number(i.cantidad),
        precioUnitario: Number(i.precioUnitario),
        descuentoPct: i.descuentoPct === null ? null : Number(i.descuentoPct),
      })),
    );
    return { prefacturaId: p.id, ticketNumero: p.ticketNumero, filas, advertencias };
  }

  async generar(pedidoId: string, ctx: ContextoPrefactura) {
    const id = await this.prisma.$transaction(async (tx) => {
      const pedido = await tx.pedido.findUnique({
        where: { id: pedidoId },
        include: { items: true, linea: true },
      });
      if (!pedido) throw new NotFoundException('El pedido no existe');
      if (!PUEDEN_GENERAR.includes(pedido.estado)) {
        throw new ConflictException(
          'La prefactura se genera cuando el pedido tiene su documentación operativa completa',
        );
      }
      const previas = await tx.prefactura.findMany({
        where: { pedidoId },
        select: { version: true, estado: true, ticketNumero: true },
        orderBy: { version: 'desc' },
      });
      if (previas.some((p) => (VIGENTES as readonly string[]).includes(p.estado))) {
        throw new ConflictException('El pedido ya tiene una prefactura vigente');
      }
      const avance = await this.documentos.avance(pedidoId);
      if (!avance.completo) {
        throw new UnprocessableEntityException({
          message: `La documentación de respaldo está incompleta. Falta: ${avance.pendientes.join(', ')}`,
          code: 'DOCUMENTACION_INCOMPLETA',
        });
      }

      const calculo = await this.calcular(tx, pedido);
      const id = uuidv7();
      const ultima = previas[0];
      await tx.prefactura.create({
        data: {
          id,
          pedidoId,
          version: (ultima?.version ?? 0) + 1,
          // el número de ticket es el mismo en todas las versiones del pedido
          // el número de ticket del pedido (reservado al abrirlo) es el de la prefactura, igual en todas sus versiones
          ticketNumero:
            pedido.ticketNumero ??
            previas.find((p) => p.ticketNumero !== null)?.ticketNumero ??
            null,
          listaPreciosId: calculo.listaId,
          ...this.columnasTotales(calculo),
          generadaPor: ctx.actor.id,
        },
      });
      await this.escribirDetalle(tx, id, calculo);

      // El estado del pedido: de operación pasa primero a "documentos completos", y de ahí a "prefactura generada".
      let estado = pedido.estado;
      if (EN_OPERACION.includes(estado)) {
        await this.estados.pasar(
          tx,
          pedidoId,
          estado,
          'documentos_completos',
          ctx.actor,
          'documentación completa',
        );
        estado = 'documentos_completos';
      }
      await this.estados.pasar(tx, pedidoId, estado, 'prefactura_generada', ctx.actor);
      await this.publicar(tx, 'comercial.prefactura.generada', pedidoId, id, ctx.actor, {
        version: (ultima?.version ?? 0) + 1,
        netoCobrar: calculo.totales.netoCobrar,
      });
      return id;
    });
    return this.detalle(id);
  }

  /**
   * «Ver prefactura» desde el ticket: la vigente o, si no existe o fue rechazada, una preliminar calculada al vuelo con
   * lo cotizado y los documentos generados hasta el momento. No guarda nada ni cambia el estado del pedido.
   */
  async vista(pedidoId: string) {
    await this.pedido(pedidoId);
    const vigente = await this.prisma.prefactura.findFirst({
      where: { pedidoId, estado: { in: [...VIGENTES] } },
      include: INCLUDE,
    });
    const avance = await this.documentos.avance(pedidoId);
    if (vigente) return { preliminar: false, prefactura: aDto(vigente), avance };
    const calculo = await this.prisma.$transaction(async (tx) => {
      const pedido = await tx.pedido.findUniqueOrThrow({
        where: { id: pedidoId },
        include: { items: true, linea: true },
      });
      return this.calcular(tx, pedido);
    });
    return {
      preliminar: true,
      prefactura: {
        totales: calculo.totales,
        tasas: calculo.tasas,
        items: calculo.items,
        advertencias: calculo.advertencias,
      },
      avance,
    };
  }

  /**
   * El Supervisor sube, desde el ticket y antes de finalizar, el documento firmado por el Company Man. Solo con la
   * documentación completa. Si no hay prefactura se genera en ese momento; si ya estaba generada se recalcula con los datos
   * actuales. La prefactura queda firmada y el pedido pasa a «ticket firmado» (ya se puede generar la orden de trabajo).
   */
  async firmarDesdeTicket(pedidoId: string, dto: FirmaCompanyManDto, ctx: ContextoPrefactura) {
    const pedido = await this.prisma.pedido.findUnique({
      where: { id: pedidoId },
      select: { estado: true },
    });
    if (!pedido) throw new NotFoundException('El pedido no existe');
    const avance = await this.documentos.avance(pedidoId);
    if (!avance.completo) {
      throw new UnprocessableEntityException({
        message: `La documentación de respaldo está incompleta. Falta: ${avance.pendientes.join(', ')}`,
        code: 'DOCUMENTACION_INCOMPLETA',
      });
    }
    let vigente = await this.prisma.prefactura.findFirst({
      where: { pedidoId, estado: { in: [...VIGENTES] } },
      select: { id: true, estado: true },
    });
    if (vigente?.estado === 'firmada') {
      throw new ConflictException('La prefactura de este pedido ya está firmada');
    }
    if (!vigente) {
      const nueva = await this.generar(pedidoId, ctx);
      vigente = { id: nueva.id, estado: 'generada' };
    } else if (vigente.estado === 'generada') {
      await this.recalcular(vigente.id, ctx);
    }
    await this.agregarFirma(
      vigente.id,
      {
        firmanteTipo: 'company_man',
        personaId: dto.personaId,
        nombre: dto.nombre,
        cargo: dto.cargo,
        firmadoAt: dto.firmadoAt,
        archivoId: dto.archivoId,
      },
      ctx,
    );
    if (vigente.estado === 'enviada_para_firmas') {
      return this.firmar(vigente.id, { razonRetraso: dto.razonRetraso }, ctx);
    }
    const id = vigente.id;
    await this.prisma.$transaction(async (tx) => {
      const p = await tx.pedido.findUniqueOrThrow({
        where: { id: pedidoId },
        select: { estado: true },
      });
      const ahora = new Date();
      await tx.prefactura.update({
        where: { id },
        data: {
          // la firma se tomó en campo: queda como entregada para firmas y firmada en el mismo acto
          estado: 'firmada',
          enviadaAt: ahora,
          enviadaPor: ctx.actor.id,
          medioEnvio: 'portal',
          firmadaAt: ahora,
          razonRetraso: dto.razonRetraso?.trim() || null,
        },
      });
      await this.estados.pasar(
        tx,
        pedidoId,
        p.estado,
        'enviado_para_firmas',
        ctx.actor,
        'firma del Company Man desde el ticket',
      );
      await this.estados.pasar(
        tx,
        pedidoId,
        'enviado_para_firmas',
        'ticket_firmado',
        ctx.actor,
        'firma del Company Man desde el ticket',
      );
      await this.publicar(tx, 'comercial.prefactura.firmada', pedidoId, id, ctx.actor, {
        firmas: 1,
        origen: 'ticket',
      });
    });
    return this.detalle(id);
  }

  /** Vuelve a calcular una prefactura "generada" (p. ej. cambió el pedido o llegaron más reportes). */
  async recalcular(id: string, ctx: ContextoPrefactura) {
    const p = await this.cargar(id);
    if (p.estado !== 'generada') {
      throw new ConflictException(
        'Solo se recalcula una prefactura recién generada (aún no enviada al cliente)',
      );
    }
    await this.prisma.$transaction(async (tx) => {
      const pedido = await tx.pedido.findUniqueOrThrow({
        where: { id: p.pedidoId },
        include: { items: true, linea: true },
      });
      const calculo = await this.calcular(tx, pedido);
      await tx.prefactura.update({
        where: { id },
        data: { listaPreciosId: calculo.listaId, ...this.columnasTotales(calculo) },
      });
      await tx.prefacturaItem.deleteMany({ where: { prefacturaId: id } });
      await tx.prefacturaAdvertencia.deleteMany({ where: { prefacturaId: id } });
      await this.escribirDetalle(tx, id, calculo);
    });
    return this.detalle(id);
  }

  /**
   * Registra el número que AS2 asignó a la prefactura (`PRC-`). El ticket de Dynadrill ES la prefactura: este es su número.
   * Se anota en el espejo del secuencial de AS2 (no se repite nunca, ni de una prefactura rechazada) y, una vez puesto, no
   * cambia: las versiones nuevas del mismo pedido lo heredan.
   */
  async registrarTicket(id: string, numero: number, actor: AuthUser) {
    const p = await this.cargar(id);
    if (!(VIGENTES as readonly string[]).includes(p.estado)) {
      throw new ConflictException('Solo se registra el número de ticket de una prefactura vigente');
    }
    const pedido = await this.prisma.pedido.findUniqueOrThrow({
      where: { id: p.pedidoId },
      select: { ticketNumero: true },
    });
    if (pedido.ticketNumero !== null) {
      // el ticket ya tiene número desde que se abrió el pedido: AS2 debe usar ese; si entrega otro, se avisa
      if (numero === pedido.ticketNumero) return this.detalle(id);
      throw new ConflictException(
        `El ticket de este pedido ya tiene el número ${pedido.ticketNumero}, que es el de la prefactura; el ${numero} que entregó AS2 no coincide`,
      );
    }
    if (p.ticketNumero !== null) {
      throw new ConflictException(`Esta prefactura ya tiene el número de ticket ${p.ticketNumero}`);
    }
    await this.prisma.$transaction(async (tx) => {
      await this.secuencias.registrarExterno(tx, {
        documento: 'prefactura',
        numero,
        documentoRefId: id,
        actorId: actor.id,
      });
      await tx.prefactura.update({ where: { id }, data: { ticketNumero: numero } });
    });
    return this.detalle(id);
  }

  async enviar(id: string, dto: EnviarPrefacturaDto, ctx: ContextoPrefactura) {
    const p = await this.cargar(id);
    if (p.estado !== 'generada')
      throw new ConflictException('Solo se envía una prefactura recién generada');
    await this.prisma.$transaction(async (tx) => {
      await tx.prefactura.update({
        where: { id },
        data: {
          estado: 'enviada_para_firmas',
          enviadaAt: new Date(),
          enviadaPor: ctx.actor.id,
          medioEnvio: dto.medio,
        },
      });
      await this.estados.pasar(
        tx,
        p.pedidoId,
        'prefactura_generada',
        'enviado_para_firmas',
        ctx.actor,
      );
      await this.publicar(tx, 'comercial.prefactura.enviada', p.pedidoId, id, ctx.actor, {
        medio: dto.medio,
      });
    });
    return this.detalle(id);
  }

  /** Agrega una firma (con su archivo firmado). Pueden ser varias: company man en campo, cliente, Dynadrill. */
  async agregarFirma(id: string, dto: AgregarFirmaDto, ctx: ContextoPrefactura) {
    const p = await this.cargar(id);
    // La firma del company man se toma en campo, antes de enviar la prefactura al cliente; también se registran después.
    if (p.estado !== 'generada' && p.estado !== 'enviada_para_firmas') {
      throw new ConflictException(
        'Las firmas se registran mientras la prefactura está generada o enviada',
      );
    }
    if (p.firmas.some((f) => f.archivoId === dto.archivoId)) {
      throw new ConflictException('Ese archivo ya está registrado como firma de esta prefactura');
    }
    const archivo = await this.directorio.archivo(dto.archivoId, ctx.token);
    if (!archivo) throw new BadRequestException('El archivo indicado no existe');
    if (archivo.modulo !== 'prefactura_documento' && archivo.modulo !== 'prefactura_company_man') {
      throw new BadRequestException('El archivo no se subió como documento de prefactura');
    }
    if (archivo.subidoPor !== ctx.actor.id) {
      throw new BadRequestException('Solo se puede registrar un archivo que usted mismo subió');
    }
    let nombre = dto.nombre?.trim();
    let cargo = dto.cargo?.trim() ?? null;
    if (dto.personaId) {
      const persona = await this.directorio.persona(dto.personaId, ctx.token);
      if (!persona) throw new BadRequestException('La persona indicada no existe');
      nombre = persona.nombre;
    }
    if (!nombre) throw new BadRequestException('Indique el nombre de quien firma');
    if (dto.firmanteTipo === 'company_man') {
      // el company man es quien Ventas asignó al pedido
      const pedido = await this.prisma.pedido.findUniqueOrThrow({
        where: { id: p.pedidoId },
        select: { representanteCampoId: true },
      });
      if (
        pedido.representanteCampoId &&
        dto.personaId &&
        dto.personaId !== pedido.representanteCampoId
      ) {
        throw new BadRequestException('El company man que firma debe ser el asignado al pedido');
      }
      cargo = cargo ?? 'Company man';
    }
    const firmaId = uuidv7();
    await this.prisma.prefacturaFirma.create({
      data: {
        id: firmaId,
        prefacturaId: id,
        firmanteTipo: dto.firmanteTipo,
        personaId: dto.personaId ?? null,
        nombre,
        cargo,
        firmadoAt: dia(dto.firmadoAt),
        archivoId: archivo.id,
        registradoPor: ctx.actor.id,
      },
    });
    // La lectura de la firma tarda unos segundos: se lanza aparte y no retrasa ni condiciona el registro.
    void this.verificarEnSegundoPlano(firmaId, archivo.id, nombre, cargo, ctx.token);
    return this.detalle(id);
  }

  /** Vuelve a leer la firma de un archivo ya registrado (ayuda para revisar; no certifica la autenticidad). */
  async verificarFirma(id: string, firmaId: string, ctx: ContextoPrefactura) {
    const firma = await this.prisma.prefacturaFirma.findFirst({
      where: { id: firmaId, prefacturaId: id },
    });
    if (!firma) throw new NotFoundException('La firma no existe en esta prefactura');
    await this.verificarEnSegundoPlano(
      firma.id,
      firma.archivoId,
      firma.nombre,
      firma.cargo,
      ctx.token,
    );
    return this.detalle(id);
  }

  /**
   * Pide la lectura de la firma y guarda el resultado. Si el servicio no responde, deja constancia del intento (sin
   * resultado) y NO falla: la verificación es una ayuda, nunca un requisito.
   */
  private async verificarEnSegundoPlano(
    firmaId: string,
    archivoId: string,
    nombre: string,
    cargo: string | null,
    token: string,
  ): Promise<void> {
    try {
      const v = await this.directorio.verificarFirma(
        archivoId,
        { nombreEsperado: nombre, ...(cargo ? { cargoEsperado: cargo } : {}) },
        token,
      );
      const resultado = {
        firma_detectada: 'firma_detectada',
        no_detectada: 'firma_no_detectada',
        no_concluyente: 'no_concluyente',
      } as const;
      await this.prisma.prefacturaFirma.update({
        where: { id: firmaId },
        data: v
          ? {
              verificacion: resultado[v.resultado],
              verificacionConfianza: v.confianza,
              nombreCoincide: v.nombreCoincide,
              verificacionAt: new Date(),
            }
          : { verificacionAt: new Date() },
      });
    } catch {
      // la ayuda de verificación nunca interrumpe el flujo de la prefactura
    }
  }

  /** Da la prefactura por firmada: exige al menos una firma con su archivo. */
  async firmar(id: string, dto: FirmarPrefacturaDto, ctx: ContextoPrefactura) {
    const p = await this.cargar(id);
    if (p.estado !== 'enviada_para_firmas')
      throw new ConflictException('La prefactura aún no se envió');
    if (p.firmas.length === 0) {
      throw new UnprocessableEntityException('Registre primero la firma con su archivo firmado');
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.prefactura.update({
        where: { id },
        data: {
          estado: 'firmada',
          firmadaAt: new Date(),
          razonRetraso: dto.razonRetraso?.trim() || null,
        },
      });
      await this.estados.pasar(tx, p.pedidoId, 'enviado_para_firmas', 'ticket_firmado', ctx.actor);
      await this.publicar(tx, 'comercial.prefactura.firmada', p.pedidoId, id, ctx.actor, {
        firmas: p.firmas.length,
      });
    });
    return this.detalle(id);
  }

  /** El cliente rechazó la prefactura: se conserva, el pedido pasa a corrección y se devuelve al área indicada. */
  async rechazar(id: string, dto: RechazarPrefacturaDto, ctx: ContextoPrefactura) {
    const p = await this.cargar(id);
    if (p.estado !== 'enviada_para_firmas')
      throw new ConflictException('Solo se rechaza una prefactura enviada al cliente');
    await this.prisma.$transaction(async (tx) => {
      await tx.prefactura.update({
        where: { id },
        data: {
          estado: 'rechazada',
          rechazadaAt: new Date(),
          rechazadaPor: ctx.actor.id,
          rechazoMotivo: dto.motivo.trim(),
          rechazoDevueltoA: dto.devueltoA,
        },
      });
      await this.estados.pasar(
        tx,
        p.pedidoId,
        'enviado_para_firmas',
        'rechazado_por_cliente',
        ctx.actor,
        dto.motivo.trim(),
      );
      await this.estados.pasar(
        tx,
        p.pedidoId,
        'rechazado_por_cliente',
        'en_correccion',
        ctx.actor,
        `Devuelto a ${dto.devueltoA}`,
      );
      await this.publicar(tx, 'comercial.prefactura.rechazada', p.pedidoId, id, ctx.actor, {
        devueltoA: dto.devueltoA,
      });
    });
    return this.detalle(id);
  }

  // =============================================================================================================

  private async calcular(
    tx: Prisma.TransactionClient,
    pedido: Prisma.PedidoGetPayload<{ include: { items: true; linea: true } }>,
  ) {
    const lista = pedido.clienteId
      ? await tx.listaPrecios.findFirst({
          where: { clienteId: pedido.clienteId, activa: true },
          orderBy: { vigenteDesde: 'desc' },
          include: { items: true },
        })
      : null;
    const itemsLista: ItemLista[] | null = lista
      ? lista.items.map((i) => ({
          codigo: i.codigo,
          descripcion: i.descripcion,
          unidad: i.unidad,
          precio: Number(i.precio),
          tipo: i.tipo,
        }))
      : null;

    const reportes = await tx.documentoOperativo.findMany({
      where: { pedidoId: pedido.id },
      include: { herramientas: { orderBy: { orden: 'asc' }, include: { usos: true } } },
    });
    const diasJob = new Set(
      reportes.filter((r) => r.tipo === 'reporte_job').map((r) => aDia(r.fecha)),
    ).size;
    const herramientas = reportes
      .filter((r) => r.tipo === 'reporte_herramientas')
      .flatMap((r) => r.herramientas)
      .map((h) => ({
        nombre: h.nombre,
        serie: h.serie,
        codigo: h.codigo,
        usos: h.usos.map((u) => ({ estado: u.estado })),
      }));

    const tasas = await this.tasas(tx);
    const resultado = calcularPrefactura({
      itemsPedido: pedido.items.map((i) => ({
        codigo: i.codigo,
        descripcion: i.descripcion,
        unidad: i.unidad,
        cantidad: Number(i.cantidad),
        valorUnitario: Number(i.valorUnitario),
        descuentoPct: Number(i.descuentoPct ?? 0),
      })),
      herramientas,
      diasReporteJob: diasJob,
      lista: itemsLista,
      nombreLista: lista?.numeroContrato ?? null,
      tasas,
    });
    return { ...resultado, listaId: lista?.id ?? null, tasas };
  }

  /** Las tasas vigentes hoy (la más reciente con vigencia ya iniciada de cada tipo). */
  private async tasas(tx: Prisma.TransactionClient): Promise<TasasAplicadas> {
    const hoy = new Date();
    const vigente = async (tipo: 'iva' | 'retencion_ir' | 'retencion_iva') => {
      const t = await tx.tasaImpuesto.findFirst({
        where: { tipo, vigenteDesde: { lte: hoy } },
        orderBy: { vigenteDesde: 'desc' },
      });
      if (!t) throw new InternalServerErrorException(`Falta configurar la tasa "${tipo}"`);
      return Number(t.porcentaje);
    };
    return {
      ivaPct: await vigente('iva'),
      retencionIrPct: await vigente('retencion_ir'),
      retencionIvaPct: await vigente('retencion_iva'),
    };
  }

  private columnasTotales(c: Awaited<ReturnType<PrefacturasService['calcular']>>) {
    return {
      subtotalServicios: c.totales.subtotalServicios,
      subtotalMateriales: c.totales.subtotalMateriales,
      subtotal: c.totales.subtotal,
      iva: c.totales.iva,
      retencionIr: c.totales.retencionIr,
      retencionIva: c.totales.retencionIva,
      netoCobrar: c.totales.netoCobrar,
      ivaPct: c.tasas.ivaPct,
      retencionIrPct: c.tasas.retencionIrPct,
      retencionIvaPct: c.tasas.retencionIvaPct,
    };
  }

  private async escribirDetalle(
    tx: Prisma.TransactionClient,
    prefacturaId: string,
    c: Awaited<ReturnType<PrefacturasService['calcular']>>,
  ) {
    if (c.items.length) {
      await tx.prefacturaItem.createMany({
        data: c.items.map((i) => ({
          id: uuidv7(),
          prefacturaId,
          orden: i.orden,
          codigo: i.codigo,
          descripcion: i.descripcion,
          unidad: i.unidad,
          serie: i.serie,
          cantidad: i.cantidad,
          precioUnitario: i.precioUnitario,
          descuentoPct: i.descuentoPct,
          precioTotal: i.precioTotal,
          tipo: i.tipo,
          fuente: i.fuente,
        })),
      });
    }
    if (c.advertencias.length) {
      await tx.prefacturaAdvertencia.createMany({
        data: c.advertencias.map((mensaje, orden) => ({
          id: uuidv7(),
          prefacturaId,
          orden,
          mensaje,
        })),
      });
    }
  }

  private async cargar(id: string) {
    const p = await this.prisma.prefactura.findUnique({ where: { id }, include: INCLUDE });
    if (!p) throw new NotFoundException('La prefactura no existe');
    return p;
  }

  private async pedido(id: string) {
    const p = await this.prisma.pedido.findUnique({ where: { id }, select: { id: true } });
    if (!p) throw new NotFoundException('El pedido no existe');
  }

  private publicar(
    tx: Prisma.TransactionClient,
    type: string,
    pedidoId: string,
    prefacturaId: string,
    actor: AuthUser,
    data: Record<string, unknown>,
  ) {
    return this.bus.publish(
      tx,
      this.bus.create({
        type,
        subject: { type: 'pedido', id: pedidoId },
        data: { pedidoId, prefacturaId, ...data },
        actor: { userId: actor.id, role: actor.roleCode },
        traceparent: currentTraceparent(),
      }),
    );
  }
}
