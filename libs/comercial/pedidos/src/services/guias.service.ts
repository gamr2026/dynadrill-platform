import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { currentTraceparent, type AuthUser } from '@dyn/common';
import { EventBus } from '@dyn/messaging';
import { uuidv7 } from '@dyn/utils';
import { DirectorioPort } from '../directorio/directorio.port';
import { EmitirGuiaDto, GuiaItemDto } from '../dto/guias.dto';
import type { Prisma } from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';
import { PedidoEstadoService } from './pedido-estado.service';
import { SecuenciasService } from './secuencias.service';

export interface ContextoGuia {
  actor: AuthUser;
  token: string;
}

/** Estados en los que todavía no hay (o ya no hay) nada que despachar. */
const SIN_GUIA = new Set(['borrador', 'anulado', 'facturado']);

const dia = (iso: string) => new Date(`${iso.slice(0, 10)}T00:00:00.000Z`);
const aDia = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const num = (d: Prisma.Decimal | number | null | undefined) =>
  d === null || d === undefined ? null : Number(d);

const INCLUDE = {
  items: { orderBy: { orden: 'asc' } },
  lugarOrigen: true,
  firmasDigitales: { orderBy: { orden: 'asc' } },
  archivoFirmado: true,
} as const;
type GuiaCompleta = Prisma.GuiaRemisionGetPayload<{ include: typeof INCLUDE }>;

export interface AutorizacionGuia {
  numero: string | null;
  desde: string | null;
  hasta: string | null;
}

const aDto = (g: GuiaCompleta, autorizacion: AutorizacionGuia) => ({
  /** Autorización del SRI del bloque de guías (se imprime en el formato). */
  autorizacion,
  id: g.id,
  pedidoId: g.pedidoId,
  numero: g.numero,
  codigo: g.codigo,
  estado: g.estado,
  fecha: aDia(g.fecha),
  clienteNombre: g.clienteNombre,
  clienteRuc: g.clienteRuc,
  lugarOrigen: { id: g.lugarOrigenId, nombre: g.lugarOrigen.nombre },
  solicitadoPorNombre: g.solicitadoPorNombre,
  despachadoPorNombre: g.despachadoPorNombre,
  horaSalida: g.horaSalida,
  horaLlegada: g.horaLlegada,
  transportista: {
    id: g.transportistaId,
    nombre: g.transportistaNombre,
    identificacion: g.transportistaIdentificacion,
  },
  vehiculo:
    g.vehiculoId || g.placa
      ? { id: g.vehiculoId, placa: g.placa, descripcion: g.vehiculoDescripcion }
      : null,
  chofer: g.choferId || g.choferNombre ? { id: g.choferId, nombre: g.choferNombre } : null,
  observaciones: g.observaciones,
  reemplazaAId: g.reemplazaAId,
  emitidaAt: g.emitidaAt,
  anulacion: g.anuladaAt ? { at: g.anuladaAt, motivo: g.anulacionMotivo } : null,
  firmada: g.archivoFirmadoId
    ? {
        archivoId: g.archivoFirmadoId,
        archivoNombre: g.archivoFirmado?.nombreOriginal ?? null,
        at: g.firmadaAt,
      }
    : null,
  /** Lectura de la firma manuscrita del archivo firmado (ayuda para revisar; no certifica). `at` null = sin resultado aún. */
  firmaManuscrita: {
    verificacion: g.firmaManuscrita,
    confianza: num(g.firmaManuscritaConfianza),
    at: g.firmaManuscritaAt,
  },
  /** Validación criptográfica de las firmas digitales del PDF firmado (ayuda para revisar; sin revocación). */
  firmaElectronica: g.firmaElectronicaEstado
    ? {
        estado: g.firmaElectronicaEstado,
        resumen: g.firmaElectronicaResumen,
        at: g.firmaElectronicaAt,
        firmas: g.firmasDigitales.map((f) => ({
          firmanteNombre: f.firmanteNombre,
          firmanteIdentificacion: f.firmanteIdentificacion,
          emisor: f.emisor,
          integridad: f.integridad,
          firmaValida: f.firmaValida,
          firmanteVerificado: f.firmanteVerificado,
          vigenteAlFirmar: f.vigenteAlFirmar,
          fechaFirma: f.fechaFirma,
          origenFecha: f.origenFecha,
          conclusion: f.conclusion,
        })),
      }
    : null,
  items: g.items.map((i) => ({
    orden: i.orden,
    codigo: i.codigo,
    descripcion: i.descripcion,
    cantidad: num(i.cantidad),
    unidad: i.unidad,
    serie: i.serie,
    origen: i.origen,
  })),
});

/**
 * Guía de remisión del pedido: propone lo que sale físicamente (herramientas reportadas con su serie y los ítems
 * Material del pedido, sin precios), se edita antes de emitirla, se numera con el secuencial del portal (el número se
 * puede reasignar con motivo) y se le adjunta el PDF firmado. También lleva las dos marcas de despacho a Bodega.
 */
@Injectable()
export class GuiasService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly secuencias: SecuenciasService,
    private readonly estados: PedidoEstadoService,
    private readonly directorio: DirectorioPort,
    private readonly bus: EventBus,
  ) {}

  // ---- consulta ---------------------------------------------------------------------------------------------

  async listarDePedido(pedidoId: string) {
    await this.pedido(pedidoId);
    const filas = await this.prisma.guiaRemision.findMany({
      where: { pedidoId },
      include: INCLUDE,
      orderBy: { emitidaAt: 'desc' },
    });
    const autorizacion = await this.autorizacion();
    return filas.map((g) => aDto(g, autorizacion));
  }

  async detalle(id: string) {
    return aDto(await this.cargar(id), await this.autorizacion());
  }

  /** Autorización del SRI vigente en la secuencia de guías (número y fechas de autorización y caducidad). */
  private async autorizacion(): Promise<AutorizacionGuia> {
    const sec = await this.prisma.secuencia.findFirst({
      where: { documento: { codigo: 'guia_remision' } },
      select: { autorizacionNumero: true, vigenciaDesde: true, vigenciaHasta: true },
    });
    return {
      numero: sec?.autorizacionNumero ?? null,
      desde: aDia(sec?.vigenciaDesde ?? null),
      hasta: aDia(sec?.vigenciaHasta ?? null),
    };
  }

  async lugares() {
    return this.prisma.lugarDespacho.findMany({
      where: { activo: true },
      orderBy: { nombre: 'asc' },
    });
  }

  async crearLugar(nombre: string) {
    const n = nombre.trim();
    const existe = await this.prisma.lugarDespacho.findUnique({ where: { nombre: n } });
    if (existe) {
      if (existe.activo) throw new ConflictException('Ya existe un lugar con ese nombre');
      return this.prisma.lugarDespacho.update({ where: { id: existe.id }, data: { activo: true } });
    }
    return this.prisma.lugarDespacho.create({ data: { id: uuidv7(), nombre: n } });
  }

  /**
   * Lo que se propone para la guía: las herramientas del Reporte de Herramientas (cantidad 1, con su serie) y los ítems
   * Material del pedido. No incluye personal, horas ni movilización, ni precios. Todo se puede editar antes de emitir.
   */
  async sugerirItems(pedidoId: string): Promise<GuiaItemDto[]> {
    await this.pedido(pedidoId);
    const docs = await this.prisma.documentoOperativoHerramienta.findMany({
      where: { documento: { pedidoId, tipo: 'reporte_herramientas' } },
      orderBy: [{ documento: { recibidoAt: 'asc' } }, { orden: 'asc' }],
    });
    const items: GuiaItemDto[] = [];
    const vistos = new Set<string>();
    const codigosHerramienta = new Set<string>();
    for (const h of docs) {
      const clave = `${h.codigo ?? ''}|${h.serie ?? ''}|${h.nombre}`.toLowerCase();
      if (vistos.has(clave)) continue;
      vistos.add(clave);
      if (h.codigo) codigosHerramienta.add(h.codigo.toLowerCase());
      items.push({
        codigo: h.codigo ?? undefined,
        descripcion: h.nombre,
        cantidad: 1,
        unidad: 'Unidad',
        serie: h.serie ?? undefined,
        origen: 'herramienta',
      });
    }
    const materiales = await this.prisma.pedidoItem.findMany({
      where: { pedidoId, listaPreciosItem: { tipo: 'Material' } },
      orderBy: { orden: 'asc' },
    });
    for (const m of materiales) {
      // la herramienta vendida ya figura con su serie: no se repite como material
      if (codigosHerramienta.has(m.codigo.toLowerCase())) continue;
      items.push({
        codigo: m.codigo,
        descripcion: m.descripcion,
        cantidad: Number(m.cantidad),
        unidad: m.unidad,
        origen: 'material',
      });
    }
    return items;
  }

  // ---- emisión ----------------------------------------------------------------------------------------------

  async emitir(pedidoId: string, dto: EmitirGuiaDto, ctx: ContextoGuia) {
    const transporte = await this.resolverTransporte(dto, ctx.token);
    const id = uuidv7();
    await this.prisma.$transaction(async (tx) => {
      const pedido = await tx.pedido.findUnique({
        where: { id: pedidoId },
        select: {
          id: true,
          estado: true,
          as2EmpresaNombre: true,
          as2EmpresaIdentificacion: true,
          cliente: { select: { nombreFiscal: true, nombreComercial: true, identificacion: true } },
        },
      });
      if (!pedido) throw new NotFoundException('El pedido no existe');
      if (SIN_GUIA.has(pedido.estado)) {
        throw new ConflictException(
          'El pedido no está en una etapa en la que se emita guía de remisión',
        );
      }
      const lugar = await tx.lugarDespacho.findUnique({ where: { id: dto.lugarOrigenId } });
      if (!lugar || !lugar.activo) throw new BadRequestException('El lugar de origen no existe');
      if (dto.reemplazaAId) {
        const previa = await tx.guiaRemision.findUnique({ where: { id: dto.reemplazaAId } });
        if (!previa || previa.pedidoId !== pedidoId) {
          throw new BadRequestException('La guía que se reemplaza no es de este pedido');
        }
        if (previa.estado !== 'anulada') {
          throw new BadRequestException('Solo se reemplaza una guía anulada');
        }
      }
      const fecha = dia(dto.fecha);
      const emision = dto.numero
        ? await this.secuencias.registrarManual(tx, {
            documento: 'guia_remision',
            numero: dto.numero,
            documentoRefId: id,
            actorId: ctx.actor.id,
          })
        : await this.secuencias.emitir(tx, {
            documento: 'guia_remision',
            documentoRefId: id,
            actorId: ctx.actor.id,
            fecha,
          });
      await tx.guiaRemision.create({
        data: {
          id,
          pedidoId,
          numero: emision.numero,
          codigo: emision.codigo,
          emisionId: emision.emisionId,
          fecha,
          // documento emitido: conserva el nombre y el RUC tal como estaban al emitirlo
          clienteNombre: pedido.cliente
            ? (pedido.cliente.nombreFiscal ?? pedido.cliente.nombreComercial)
            : pedido.as2EmpresaNombre,
          clienteRuc: pedido.cliente?.identificacion ?? pedido.as2EmpresaIdentificacion,
          lugarOrigenId: lugar.id,
          solicitadoPorNombre: dto.solicitadoPorNombre?.trim() || null,
          despachadoPorNombre: dto.despachadoPorNombre?.trim() || null,
          horaSalida: dto.horaSalida ?? null,
          horaLlegada: dto.horaLlegada ?? null,
          ...transporte,
          observaciones: dto.observaciones?.trim() || null,
          reemplazaAId: dto.reemplazaAId ?? null,
          emitidaPor: ctx.actor.id,
          items: { create: dto.items.map((it, i) => this.item(it, i)) },
        },
      });
      await this.publicar(tx, 'comercial.guia.emitida', pedidoId, id, ctx.actor, {
        codigo: emision.codigo,
      });
    });
    return this.detalle(id);
  }

  /** Cambia el número de una guía (p. ej. por un error de digitación). El anterior queda anulado y no se reutiliza. */
  async reasignarNumero(id: string, numero: number, motivo: string, actor: AuthUser) {
    if (!motivo.trim()) throw new BadRequestException('El motivo es obligatorio');
    await this.prisma.$transaction(async (tx) => {
      const g = await tx.guiaRemision.findUnique({ where: { id } });
      if (!g) throw new NotFoundException('La guía no existe');
      if (g.estado !== 'emitida')
        throw new ConflictException('Solo se reasigna el número de una guía emitida');
      if (g.archivoFirmadoId) {
        throw new ConflictException('La guía ya está firmada: anúlela y emita otra en su lugar');
      }
      if (g.numero === numero) throw new BadRequestException('Ese ya es el número de la guía');
      await tx.secuenciaEmision.updateMany({
        where: { id: g.emisionId },
        data: { estado: 'anulado', motivo: `Reasignada: ${motivo.trim()}` },
      });
      const nueva = await this.secuencias.registrarManual(tx, {
        documento: 'guia_remision',
        numero,
        documentoRefId: id,
        actorId: actor.id,
      });
      await tx.guiaRemision.update({
        where: { id },
        data: { numero: nueva.numero, codigo: nueva.codigo, emisionId: nueva.emisionId },
      });
      await this.publicar(tx, 'comercial.guia.renumerada', g.pedidoId, id, actor, {
        anterior: g.codigo,
        nuevo: nueva.codigo,
        motivo: motivo.trim(),
      });
    });
    return this.detalle(id);
  }

  async anular(id: string, motivo: string, actor: AuthUser) {
    if (!motivo.trim()) throw new BadRequestException('El motivo es obligatorio');
    await this.prisma.$transaction(async (tx) => {
      const g = await tx.guiaRemision.findUnique({ where: { id } });
      if (!g) throw new NotFoundException('La guía no existe');
      if (g.estado === 'anulada') throw new ConflictException('La guía ya está anulada');
      if (g.archivoFirmadoId)
        throw new ConflictException('La guía ya está firmada y no se puede anular');
      await tx.guiaRemision.update({
        where: { id },
        data: {
          estado: 'anulada',
          anuladaAt: new Date(),
          anuladaPor: actor.id,
          anulacionMotivo: motivo.trim(),
        },
      });
      await tx.secuenciaEmision.updateMany({
        where: { id: g.emisionId },
        data: { estado: 'anulado', motivo: motivo.trim() },
      });
      await this.publicar(tx, 'comercial.guia.anulada', g.pedidoId, id, actor, {
        codigo: g.codigo,
      });
    });
    return this.detalle(id);
  }

  /** Adjunta la guía ya firmada electrónicamente (archivo del módulo `guia_documento` subido por quien registra). */
  async registrarFirmada(id: string, archivoId: string, ctx: ContextoGuia) {
    const g = await this.cargar(id);
    if (g.estado !== 'emitida')
      throw new ConflictException('Solo se registra la firma de una guía emitida');
    const archivo = await this.directorio.archivo(archivoId, ctx.token);
    if (!archivo) throw new BadRequestException('El archivo indicado no existe');
    if (archivo.modulo !== 'guia_documento') {
      throw new BadRequestException('El archivo no se subió como documento de guía de remisión');
    }
    if (archivo.subidoPor !== ctx.actor.id) {
      throw new BadRequestException('Solo se puede registrar un archivo que usted mismo subió');
    }
    await this.prisma.guiaRemision.update({
      where: { id },
      data: {
        archivoFirmadoId: archivo.id,
        firmadaAt: new Date(),
        firmaManuscrita: 'no_verificada',
        firmaManuscritaConfianza: null,
        firmaManuscritaAt: null,
        firmaElectronicaEstado: null,
        firmaElectronicaResumen: null,
        firmaElectronicaAt: null,
      },
    });
    await this.prisma.guiaFirmaDigital.deleteMany({ where: { guiaId: id } });
    // Las validaciones tardan unos segundos: corren aparte y no retrasan ni condicionan el registro.
    void this.validarEnSegundoPlano(id, archivo.id, archivo.mimeType, ctx.token);
    return this.detalle(id);
  }

  /** Vuelve a validar las firmas digitales del PDF firmado (ayuda para revisar; no bloquea nada). */
  async verificarFirmaElectronica(id: string, ctx: ContextoGuia) {
    const g = await this.cargar(id);
    if (!g.archivoFirmadoId)
      throw new ConflictException('La guía todavía no tiene un archivo firmado');
    const archivo = await this.directorio.archivo(g.archivoFirmadoId, ctx.token);
    if (!archivo) throw new BadRequestException('El archivo firmado ya no está disponible');
    await this.validarEnSegundoPlano(id, archivo.id, archivo.mimeType, ctx.token);
    return this.detalle(id);
  }

  /**
   * Dos ayudas independientes sobre el archivo firmado: la lectura de la firma manuscrita (PDF o imagen) y, solo en PDF,
   * la validación de la firma electrónica. Ninguna bloquea ni condiciona nada.
   */
  private async validarEnSegundoPlano(
    id: string,
    archivoId: string,
    mime: string,
    token: string,
  ): Promise<void> {
    await Promise.all([
      this.leerManuscrita(id, archivoId, token),
      mime === 'application/pdf'
        ? this.validarElectronica(id, archivoId, token)
        : Promise.resolve(),
    ]);
  }

  private async leerManuscrita(id: string, archivoId: string, token: string): Promise<void> {
    try {
      const v = await this.directorio.verificarFirma(archivoId, {}, token);
      const resultado = {
        firma_detectada: 'firma_detectada',
        no_detectada: 'firma_no_detectada',
        no_concluyente: 'no_concluyente',
      } as const;
      // si mientras tanto se reemplazó el archivo, el resultado ya no corresponde
      await this.prisma.guiaRemision.updateMany({
        where: { id, archivoFirmadoId: archivoId },
        data: v
          ? {
              firmaManuscrita: resultado[v.resultado],
              firmaManuscritaConfianza: v.confianza,
              firmaManuscritaAt: new Date(),
            }
          : { firmaManuscritaAt: new Date() },
      });
    } catch {
      // es una ayuda: si falla, la guía queda registrada sin resultado y se puede reintentar
    }
  }

  private async validarElectronica(id: string, archivoId: string, token: string): Promise<void> {
    try {
      const r = await this.directorio.verificarFirmaElectronica(archivoId, token);
      if (!r) return;
      await this.prisma.$transaction(async (tx) => {
        // si mientras tanto se reemplazó el archivo, el resultado ya no corresponde
        const g = await tx.guiaRemision.findUnique({
          where: { id },
          select: { archivoFirmadoId: true },
        });
        if (!g || g.archivoFirmadoId !== archivoId) return;
        await tx.guiaFirmaDigital.deleteMany({ where: { guiaId: id } });
        await tx.guiaFirmaDigital.createMany({
          data: r.firmas.map((f, i) => ({
            id: uuidv7(),
            guiaId: id,
            orden: i + 1,
            firmanteNombre: f.firmanteNombre,
            firmanteIdentificacion: f.firmanteIdentificacion,
            emisor: f.emisor,
            integridad: f.integridad,
            firmaValida: f.firmaValida,
            firmanteVerificado: f.firmanteVerificado,
            vigenteAlFirmar: f.vigenteAlFirmar,
            fechaFirma: f.fechaFirma ? new Date(f.fechaFirma) : null,
            origenFecha: f.origenFecha,
            conclusion: f.conclusion,
          })),
        });
        await tx.guiaRemision.update({
          where: { id },
          data: {
            firmaElectronicaEstado: r.estado,
            firmaElectronicaResumen: r.resumen,
            firmaElectronicaAt: new Date(),
          },
        });
      });
    } catch {
      // es una ayuda: si falla, la guía queda registrada sin resultado y se puede reintentar
    }
  }

  // ---- despacho a Bodega ------------------------------------------------------------------------------------

  /** Facturación pide a Bodega que despache: solo una marca (quién y cuándo), sin documento. */
  async solicitarDespacho(pedidoId: string, actor: AuthUser) {
    await this.prisma.$transaction(async (tx) => {
      const p = await tx.pedido.findUnique({ where: { id: pedidoId }, select: { estado: true } });
      if (!p) throw new NotFoundException('El pedido no existe');
      if (p.estado !== 'prefactura_generada') {
        throw new ConflictException(
          'El despacho se solicita cuando la prefactura ya está generada',
        );
      }
      await tx.pedido.update({
        where: { id: pedidoId },
        data: {
          despachoSolicitadoAt: new Date(),
          despachoSolicitadoPor: actor.id,
          despachoRealizadoAt: null,
          despachoRealizadoPor: null,
        },
      });
      await this.estados.pasar(
        tx,
        pedidoId,
        p.estado,
        'por_despachar_bodega',
        actor,
        'despacho solicitado',
      );
    });
    return this.estadoDespacho(pedidoId);
  }

  /** Bodega confirma que despachó. El pedido vuelve a la etapa de prefactura. */
  async realizarDespacho(pedidoId: string, actor: AuthUser) {
    await this.prisma.$transaction(async (tx) => {
      const p = await tx.pedido.findUnique({ where: { id: pedidoId }, select: { estado: true } });
      if (!p) throw new NotFoundException('El pedido no existe');
      if (p.estado !== 'por_despachar_bodega') {
        throw new ConflictException('El pedido no tiene un despacho pendiente');
      }
      await tx.pedido.update({
        where: { id: pedidoId },
        data: {
          despachoRealizadoAt: new Date(),
          despachoRealizadoPor: actor.id,
        },
      });
      await this.estados.pasar(
        tx,
        pedidoId,
        p.estado,
        'prefactura_generada',
        actor,
        'despacho realizado',
      );
    });
    return this.estadoDespacho(pedidoId);
  }

  async estadoDespacho(pedidoId: string) {
    const p = await this.prisma.pedido.findUnique({
      where: { id: pedidoId },
      select: {
        despachoSolicitadoAt: true,
        despachoSolicitante: { select: { nombre: true } },
        despachoRealizadoAt: true,
        despachoEjecutor: { select: { nombre: true } },
      },
    });
    if (!p) throw new NotFoundException('El pedido no existe');
    return {
      solicitado: p.despachoSolicitadoAt
        ? { at: p.despachoSolicitadoAt, por: p.despachoSolicitante?.nombre ?? null }
        : null,
      realizado: p.despachoRealizadoAt
        ? { at: p.despachoRealizadoAt, por: p.despachoEjecutor?.nombre ?? null }
        : null,
    };
  }

  // =============================================================================================================

  private item(it: GuiaItemDto, i: number): Prisma.GuiaRemisionItemCreateWithoutGuiaInput {
    return {
      id: uuidv7(),
      orden: i + 1,
      codigo: it.codigo?.trim() || null,
      descripcion: it.descripcion.trim(),
      cantidad: it.cantidad,
      unidad: it.unidad.trim(),
      serie: it.serie?.trim() || null,
      origen: it.origen,
    };
  }

  private async resolverTransporte(dto: EmitirGuiaDto, token: string) {
    const t = await this.directorio.transportista(dto.transportistaId, token);
    if (!t) throw new BadRequestException('El transportista no existe');
    let vehiculoId: string | null = null;
    let placa: string | null = null;
    let vehiculoDescripcion: string | null = null;
    if (dto.vehiculoId) {
      const v = await this.directorio.vehiculo(dto.vehiculoId, token);
      if (!v) throw new BadRequestException('El vehículo no existe');
      // un vehículo con dueño solo viaja con su transportista (uno sin dueño en el catálogo se acepta)
      if (v.transportistaId && v.transportistaId !== t.id) {
        throw new BadRequestException('El vehículo no pertenece al transportista indicado');
      }
      vehiculoId = v.id;
      placa = v.placa;
      vehiculoDescripcion = v.descripcion;
    }
    let choferId: string | null = null;
    let choferNombre: string | null = null;
    if (dto.choferId) {
      const c = await this.directorio.chofer(dto.choferId, token);
      if (!c) throw new BadRequestException('El chofer no existe');
      if (c.transportistaId !== t.id) {
        throw new BadRequestException('El chofer no pertenece al transportista indicado');
      }
      choferId = c.id;
      choferNombre = c.nombre;
    }
    return {
      transportistaId: t.id,
      transportistaNombre: t.nombre,
      transportistaIdentificacion: t.identificacion,
      vehiculoId,
      placa,
      vehiculoDescripcion,
      choferId,
      choferNombre,
    };
  }

  private async publicar(
    tx: Prisma.TransactionClient,
    type: string,
    pedidoId: string,
    guiaId: string,
    actor: AuthUser,
    data: Record<string, unknown>,
  ) {
    await this.bus.publish(
      tx,
      this.bus.create({
        type,
        subject: { type: 'pedido', id: pedidoId },
        data: { pedidoId, guiaId, ...data },
        actor: { userId: actor.id, role: actor.roleCode },
        traceparent: currentTraceparent(),
      }),
    );
  }

  private async cargar(id: string): Promise<GuiaCompleta> {
    const g = await this.prisma.guiaRemision.findUnique({ where: { id }, include: INCLUDE });
    if (!g) throw new NotFoundException('La guía no existe');
    return g;
  }

  private async pedido(id: string) {
    const p = await this.prisma.pedido.findUnique({ where: { id }, select: { id: true } });
    if (!p) throw new NotFoundException('El pedido no existe');
    return p;
  }
}
