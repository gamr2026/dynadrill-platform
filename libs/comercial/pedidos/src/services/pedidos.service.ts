import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Permission } from '@dyn/authz';
import { currentTraceparent, type AuthUser } from '@dyn/common';
import { EventBus } from '@dyn/messaging';
import { uuidv7 } from '@dyn/utils';
import { DirectorioPort } from '../directorio/directorio.port';
import {
  ActualizarPedidoDto,
  CrearPedidoDto,
  ItemPedidoDto,
  PedidosQueryDto,
  ValidarPlantillaDto,
} from '../dto/pedidos.dto';
import { Prisma } from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';
import { ActorFlujo, WorkflowService } from '../workflow/workflow.service';
import { SecuenciasService } from './secuencias.service';
import {
  INCLUDE_NOMBRES,
  PedidoConHijos,
  nombreCliente,
  rucCliente,
  toDetalle,
  toResumen,
} from './pedido-mapper';

export const PROCESO_PEDIDO = 'pedido';

/** Clave del módulo de `archivos` para los adjuntos del pedido y tope por pedido. */
const MODULO_ARCHIVO = 'pedido_documento';
const MAX_DOCUMENTOS = 10;

/** Quién pide y con qué token (se reenvía al directorio de plataforma). */
export interface Contexto {
  actor: AuthUser;
  token: string;
}

/** Estados en los que el pedido todavía se puede editar. Después (prefactura enviada o firmada...) queda congelado. */
const EDITABLES = new Set([
  'borrador',
  'abierto',
  'en_operacion',
  'en_elaboracion_operativa',
  'documentos_completos',
  'en_revision_prefacturacion',
  'en_correccion',
  'prefactura_generada',
]);

const INCLUDE = {
  ...INCLUDE_NOMBRES,
  items: true,
  linea: true,
  tipoOt: true,
  documentos: { include: { archivo: true } },
  tiposServicio: { include: { tipo: true, subtipos: { include: { catalogo: true } } } },
  estadoRef: true,
} as const;

const fechaDia = (iso: string): Date => new Date(`${iso.slice(0, 10)}T00:00:00.000Z`);
/** Tipo de línea que se deduce de la lista de precios: Material, Servicio y, por su descripción, la movilización. */
const tipoLineaDeLista = (
  tipo: 'Material' | 'Servicio',
  descripcion: string,
): 'servicio' | 'material' | 'movilizacion' =>
  /moviliz/i.test(descripcion) ? 'movilizacion' : tipo === 'Material' ? 'material' : 'servicio';
const flujo = (a: AuthUser): ActorFlujo => ({
  id: a.id,
  nombre: a.name,
  rol: a.roleCode,
  permisos: a.permissions,
});

/**
 * Pedido: entidad ancla del ciclo comercial. Lo crea Ventas en el portal (o lo completa a partir de uno de AS2), pasa de
 * "por completar" (`borrador`) a `abierto` cuando tiene todos los datos, y avanza por el proceso `pedido`
 * (`WorkflowService`). Cada dato de catálogo o de personas es una FK (el nombre sale del JOIN). El número `codigo` se
 * emite al abrir, dentro de la misma transacción (`SecuenciasService`). Todo cambio publica su evento en el outbox.
 */
@Injectable()
export class PedidosService {
  private readonly logger = new Logger(PedidosService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly secuencias: SecuenciasService,
    private readonly workflow: WorkflowService,
    private readonly directorio: DirectorioPort,
    private readonly bus: EventBus,
  ) {}

  // =============================================================================================================
  // Consulta
  // =============================================================================================================

  async listar(q: PedidosQueryDto) {
    const page = q.page ?? 1;
    const limit = q.limit ?? 20;
    const where: Prisma.PedidoWhereInput = {};
    const estados = [q.estado, ...(q.estados?.split(',') ?? [])]
      .map((e) => e?.trim())
      .filter(Boolean) as string[];
    if (estados.length) where.estado = { in: estados };
    if (q.linea) where.linea = { codigo: q.linea };
    if (q.origen) where.origen = q.origen;
    if (q.clienteId) where.clienteId = q.clienteId;
    if (q.as2Sync) where.as2SyncEstado = q.as2Sync;
    if (q.sinAnalista === 'true') where.analistaFacturacionId = null;
    if (q.q) {
      const t = q.q.trim();
      where.OR = [
        { codigo: { contains: t, mode: 'insensitive' } },
        { as2Numero: { contains: t, mode: 'insensitive' } },
        {
          cliente: {
            OR: [
              { nombreFiscal: { contains: t, mode: 'insensitive' } },
              { nombreComercial: { contains: t, mode: 'insensitive' } },
            ],
          },
        },
        { as2EmpresaNombre: { contains: t, mode: 'insensitive' } },
        { campo: { nombre: { contains: t, mode: 'insensitive' } } },
        { pozo: { nombreCompleto: { contains: t, mode: 'insensitive' } } },
        { numeroContrato: { contains: t, mode: 'insensitive' } },
      ];
    }
    const [total, filas] = await Promise.all([
      this.prisma.pedido.count({ where }),
      this.prisma.pedido.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
        include: {
          ...INCLUDE_NOMBRES,
          estadoRef: true,
          linea: true,
          tipoOt: true,
          tiposServicio: { include: { tipo: true } },
        },
      }),
    ]);
    return { items: filas.map(toResumen), total, page, limit };
  }

  async detalle(id: string, ctx: Contexto) {
    const p = await this.cargar(this.prisma, id);
    const [historial, siguientes] = await Promise.all([
      this.workflow.historial(PROCESO_PEDIDO, id),
      this.workflow.disponibles(PROCESO_PEDIDO, p.estado, { permisos: ctx.actor.permissions }),
    ]);
    return {
      ...toDetalle(p),
      editable: EDITABLES.has(p.estado),
      historial,
      siguientes,
      puedeForzar: ctx.actor.permissions.includes(Permission.PEDIDOS_FORZAR_ESTADO),
    };
  }

  /** Catálogo de estados del proceso (nombre, macro-estado y responsable) para etiquetas y filtros del frontend. */
  estados() {
    return this.workflow.estados(PROCESO_PEDIDO);
  }

  /** Tipos de OT del catálogo (venta, servicio...), solo los activos. */
  async tiposOt() {
    const filas = await this.prisma.tipoOt.findMany({
      where: { activo: true },
      orderBy: [{ orden: 'asc' }, { nombre: 'asc' }],
    });
    return filas.map((t) => ({ codigo: t.codigo, nombre: t.nombre }));
  }

  /** Catálogo de servicios: líneas → tipos → subtipos (solo los activos, en su orden). */
  async catalogoServicios() {
    const lineas = await this.prisma.servicioLinea.findMany({
      where: { activo: true },
      orderBy: [{ orden: 'asc' }, { nombre: 'asc' }],
      include: {
        tipos: {
          where: { activo: true },
          orderBy: [{ orden: 'asc' }, { nombre: 'asc' }],
          include: {
            subtipos: { where: { activo: true }, orderBy: [{ orden: 'asc' }, { nombre: 'asc' }] },
          },
        },
      },
    });
    return {
      lineas: lineas.map((l) => ({
        linea: l.codigo,
        nombre: l.nombre,
        tipos: l.tipos.map((t) => ({
          codigo: t.codigo,
          nombre: t.nombre,
          subtipos: t.subtipos.map((x) => x.nombre),
        })),
      })),
    };
  }

  /** Qué pedidos de AS2 ya existen en el portal (para marcar la lista de AS2 sin guardar nada de AS2). */
  async vinculosAs2(ids: number[]) {
    const validos = [...new Set(ids)].filter((n) => Number.isInteger(n) && n > 0).slice(0, 100);
    if (validos.length === 0) return [];
    const filas = await this.prisma.pedido.findMany({
      where: { as2IdPedidoCliente: { in: validos } },
      select: { id: true, codigo: true, estado: true, as2IdPedidoCliente: true },
    });
    return filas.map((f) => ({
      as2IdPedidoCliente: f.as2IdPedidoCliente,
      id: f.id,
      codigo: f.codigo,
      estado: f.estado,
    }));
  }

  // =============================================================================================================
  // Crear y editar
  // =============================================================================================================

  async crear(dto: CrearPedidoDto, ctx: Contexto) {
    const id = uuidv7();
    const resuelto = await this.resolver(dto, null, ctx);
    const items = await this.prepararItems(dto.items, resuelto.clienteId, id, ctx);

    await this.prisma.$transaction(async (tx) => {
      await tx.pedido.create({
        data: {
          id,
          ...resuelto.data,
          origen: 'portal',
          as2SyncEstado: 'pendiente_de_crear_en_as2',
          proceso: PROCESO_PEDIDO,
          estado: 'borrador',
          // por defecto, el agente comercial es quien lo crea
          ...(resuelto.data.agenteComercialId === undefined
            ? { agenteComercialId: ctx.actor.id }
            : {}),
          createdBy: ctx.actor.id,
          updatedBy: ctx.actor.id,
        } as Prisma.PedidoUncheckedCreateInput,
      });
      await this.escribirHijos(tx, id, resuelto.tipos, resuelto.subtipos, items);
      await this.workflow.iniciar(tx, {
        proceso: PROCESO_PEDIDO,
        entidadId: id,
        estado: 'borrador',
        actor: flujo(ctx.actor),
        origen: 'manual',
      });
      if (dto.abrir) await this.abrirEnTx(tx, id, ctx);
    });
    return this.detalle(id, ctx);
  }

  async editar(id: string, dto: ActualizarPedidoDto, ctx: Contexto) {
    const actual = await this.cargar(this.prisma, id);
    if (!EDITABLES.has(actual.estado)) {
      throw new ConflictException(
        `Un pedido en "${actual.estadoRef.nombre}" ya no se puede editar`,
      );
    }
    if (dto.version !== actual.version) {
      throw new ConflictException(
        'Otra persona modificó este pedido mientras usted lo editaba. Recargue y vuelva a intentarlo.',
      );
    }
    if (actual.as2IdPedidoCliente !== null) {
      // Datos que vinieron de AS2 (no hay API para escribirlos allá): el portal no los cambia.
      // solo se bloquea lo que AS2 trajo y quedó enlazado a su catálogo (sin id sí se puede elegir)
      const cambia = (nuevo: string | null | undefined, vigente: string | null) =>
        vigente !== null && nuevo !== undefined && nuevo !== vigente;
      const bloqueados = [
        // un cliente que AS2 trae y no está en el catálogo (sin id) sí se puede elegir
        actual.clienteId !== null &&
        dto.clienteId !== undefined &&
        dto.clienteId !== actual.clienteId
          ? 'cliente'
          : null,
        cambia(dto.bodegaId, actual.bodegaId) ? 'bodega' : null,
        cambia(dto.condicionPagoId, actual.condicionPagoId) ? 'condición de pago' : null,
      ].filter(Boolean);
      if (bloqueados.length) {
        throw new BadRequestException(
          `Estos datos vienen de AS2 y no se pueden cambiar desde el portal: ${bloqueados.join(', ')}`,
        );
      }
    }
    const resuelto = await this.resolver(dto, actual, ctx);
    const clienteFinal = resuelto.clienteId === undefined ? actual.clienteId : resuelto.clienteId;
    const items =
      dto.items === undefined
        ? undefined
        : await this.prepararItems(dto.items, clienteFinal, id, ctx);
    if (
      dto.clienteId !== undefined &&
      dto.clienteId !== actual.clienteId &&
      dto.items === undefined &&
      actual.items.length
    ) {
      throw new BadRequestException(
        'Al cambiar de cliente hay que volver a elegir los ítems de la lista de precios del cliente nuevo',
      );
    }

    await this.prisma.$transaction(async (tx) => {
      const r = await tx.pedido.updateMany({
        where: { id, version: dto.version },
        data: {
          ...(resuelto.data as Prisma.PedidoUncheckedUpdateManyInput),
          version: { increment: 1 },
          updatedBy: ctx.actor.id,
        },
      });
      if (r.count === 0)
        throw new ConflictException('El pedido cambió mientras se guardaba; recargue');
      await this.escribirHijos(tx, id, resuelto.tipos, resuelto.subtipos, items);
      if (actual.estado !== 'borrador') {
        await this.publicar(tx, 'comercial.pedido.actualizado', id, ctx, {
          codigo: actual.codigo,
          campos: Object.keys(resuelto.data).sort(),
          itemsModificados: items !== undefined,
          ...(await this.datosParaOperaciones(tx, id, items !== undefined)),
        });
      }
    });
    return this.detalle(id, ctx);
  }

  /**
   * Reemplaza los ítems del pedido con un cambio que Operaciones propuso y su Supervisor aprobó (Pumping, contrato 4.13). Los
   * ítems siguen saliendo de la lista de precios del cliente (precio y descripción no los pone quien propone). Solo mientras el
   * pedido es editable y ya está abierto; no pide la versión (el cambio ya fue autorizado por quien corresponde).
   */
  async aplicarCambioDeItems(
    pedidoId: string,
    items: ItemPedidoDto[],
    ctx: Contexto,
  ): Promise<void> {
    const actual = await this.cargar(this.prisma, pedidoId);
    if (actual.estado === 'borrador' || !EDITABLES.has(actual.estado)) {
      throw new ConflictException(
        `Un pedido en "${actual.estadoRef.nombre}" ya no admite cambios de ítems`,
      );
    }
    if (!items.length) throw new BadRequestException('El cambio debe dejar al menos un ítem');
    const elegidos = (await this.prepararItems(items, actual.clienteId, pedidoId, ctx)) ?? [];
    // Los ítems que no vienen de la lista (los que trajo AS2) no se pueden proponer desde Operaciones: se conservan al final.
    const sinLista = actual.items
      .filter((i) => i.listaPreciosItemId === null)
      .map((i, k) => ({
        id: uuidv7(),
        pedidoId,
        orden: elegidos.length + k + 1,
        codigo: i.codigo,
        descripcion: i.descripcion,
        unidad: i.unidad,
        cantidad: i.cantidad,
        valorUnitario: i.valorUnitario,
        descuentoPct: i.descuentoPct,
        origenItem: i.origenItem,
        listaPreciosItemId: null,
        tipoLinea: i.tipoLinea,
      }));
    const nuevos = [...elegidos, ...sinLista];
    await this.prisma.$transaction(async (tx) => {
      await tx.pedido.update({
        where: { id: pedidoId },
        data: { version: { increment: 1 }, updatedBy: ctx.actor.id },
      });
      await this.escribirHijos(tx, pedidoId, undefined, undefined, nuevos);
      await this.publicar(tx, 'comercial.pedido.actualizado', pedidoId, ctx, {
        codigo: actual.codigo,
        campos: [],
        itemsModificados: true,
        origenCambio: 'operaciones',
        ...(await this.datosParaOperaciones(tx, pedidoId, true)),
      });
    });
  }

  /** Valida todo, emite el código y abre el pedido. Desde `borrador` o desde `en_correccion`. */
  async abrir(id: string, ctx: Contexto) {
    await this.prisma.$transaction((tx) => this.abrirEnTx(tx, id, ctx));
    return this.detalle(id, ctx);
  }

  // =============================================================================================================
  // Estados
  // =============================================================================================================

  /** Paso manual validado contra el catálogo de transiciones (permiso y motivo). */
  async transicionar(
    id: string,
    hacia: string,
    motivo: string | undefined,
    ctx: Contexto,
    forzar = false,
  ) {
    await this.prisma.$transaction(async (tx) => {
      const p = await this.cargar(tx, id);
      if (hacia === 'abierto' && !forzar) {
        // abrir exige validar que el pedido esté completo: tiene su propio camino
        await this.abrirEnTx(tx, id, ctx);
        return;
      }
      await this.cambiarEstadoEnTx(tx, p, hacia, motivo, ctx, forzar ? 'forzado' : 'manual');
    });
    return this.detalle(id, ctx);
  }

  anular(id: string, motivo: string, ctx: Contexto) {
    return this.transicionar(id, 'anulado', motivo, ctx);
  }

  /** Facturación devuelve el pedido a Ventas para corrección. */
  rechazar(id: string, motivo: string, ctx: Contexto) {
    return this.transicionar(id, 'en_correccion', motivo, ctx);
  }

  async asignarAnalista(id: string, analistaId: string, ctx: Contexto) {
    const p = await this.cargar(this.prisma, id);
    if (p.estado === 'anulado') throw new ConflictException('Un pedido anulado no admite cambios');
    const [analista] = await this.directorio.usuarios([analistaId], ctx.token);
    if (!analista || !analista.activo)
      throw new BadRequestException('El analista indicado no existe o está inactivo');
    if (analista.roleCode !== 'facturacion') {
      throw new BadRequestException('El analista de facturación debe tener el rol de Facturación');
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.pedido.update({
        where: { id },
        data: {
          analistaFacturacionId: analista.id,
          analistaAsignadoPor: ctx.actor.id,
          analistaAsignadoAt: new Date(),
          version: { increment: 1 },
          updatedBy: ctx.actor.id,
        },
      });
      await this.publicar(tx, 'comercial.pedido.analista_asignado', id, ctx, {
        codigo: p.codigo,
        analistaId: analista.id,
        reasignado: p.analistaFacturacionId !== null,
      });
    });
    return this.detalle(id, ctx);
  }

  // =============================================================================================================
  // Pedidos de AS2
  // =============================================================================================================

  /** Toma un pedido de AS2 y lo deja "por completar" (borrador) en el portal, para que Ventas lo complete y lo abra. */
  async desdeAs2(as2Id: number, ctx: Contexto) {
    const existente = await this.prisma.pedido.findUnique({
      where: { as2IdPedidoCliente: as2Id },
      select: { id: true, codigo: true },
    });
    if (existente) {
      throw new ConflictException(
        `El pedido de AS2 ${as2Id} ya está en el portal${existente.codigo ? ` (código ${existente.codigo})` : ''}`,
      );
    }
    const as2 = await this.directorio.as2Pedido(as2Id, ctx.token);
    if (!as2) throw new NotFoundException(`El pedido ${as2Id} no existe en AS2`);
    const cliente = as2.empresaIdentificacion
      ? await this.directorio.clientePorRuc(as2.empresaIdentificacion, ctx.token)
      : null;

    // bodega y condición de pago de AS2 → su registro en el catálogo, por nombre (si no existe queda solo el nombre)
    const [bodega, condicion] = await Promise.all([
      as2.bodega ? this.directorio.bodegaPorNombre(as2.bodega, ctx.token) : null,
      as2.condicionPago
        ? this.directorio.condicionPagoPorNombre(as2.condicionPago, ctx.token)
        : null,
    ]);

    const id = uuidv7();
    await this.prisma.$transaction(async (tx) => {
      await tx.pedido.create({
        data: {
          id,
          origen: 'as2',
          proceso: PROCESO_PEDIDO,
          estado: 'borrador',
          as2IdPedidoCliente: as2.idPedidoCliente,
          as2Numero: as2.numero,
          as2Estado: as2.estado,
          as2Fecha: as2.fecha ? fechaDia(as2.fecha) : null,
          as2Total: as2.total,
          as2Descuento: as2.descuento,
          as2Impuesto: as2.impuesto,
          as2Descripcion: as2.descripcion,
          as2SyncEstado: 'vinculado',
          as2VinculoMetodo: 'api',
          as2SincronizadoAt: new Date(),
          clienteId: cliente?.id ?? null,
          // lo que AS2 trae se conserva como dato de AS2 (el catálogo propio manda cuando existe el registro)
          as2EmpresaNombre: as2.empresaNombre,
          as2EmpresaIdentificacion: as2.empresaIdentificacion,
          bodegaId: bodega?.id ?? null,
          as2Bodega: as2.bodega,
          condicionPagoId: condicion?.id ?? null,
          as2CondicionPago: as2.condicionPago,
          as2Zona: as2.zona,
          agenteComercialId: ctx.actor.id,
          createdBy: ctx.actor.id,
          updatedBy: ctx.actor.id,
        },
      });
      await this.workflow.iniciar(tx, {
        proceso: PROCESO_PEDIDO,
        entidadId: id,
        estado: 'borrador',
        actor: flujo(ctx.actor),
        origen: 'sincronizacion',
        motivo: `Cargado desde AS2 (${as2.numero})`,
      });
      await this.secuencias.observarAs2(tx, 'pedido_cliente_as2', as2.numero);
      await this.publicar(tx, 'comercial.pedido.cargado_desde_as2', id, ctx, {
        as2IdPedidoCliente: as2.idPedidoCliente,
        as2Numero: as2.numero,
        clienteResuelto: cliente !== null,
      });
    });
    // Si AS2 entrega líneas y el cliente está en el catálogo, se cargan como ítems (solo los códigos que están en su
    // lista de precios, con el precio de la lista). Un fallo aquí no deshace la creación del pedido.
    let lineasAs2: { importados: number; sinCoincidencia: string[] } | null = null;
    if (cliente && (as2.lineas?.length ?? 0) > 0) {
      try {
        const r = await this.importarLineasAs2(id, ctx);
        lineasAs2 = { importados: r.importados, sinCoincidencia: r.sinCoincidencia };
      } catch (e) {
        this.logger.warn(
          `No se pudieron cargar las líneas de AS2 ${as2Id}: ${(e as Error).message}`,
        );
      }
    }
    return { ...(await this.detalle(id, ctx)), lineasAs2 };
  }

  /** Vincula un pedido creado en el portal con el que se registró en AS2 (vinculación manual). */
  async vincularAs2(id: string, as2Id: number, ctx: Contexto) {
    const p = await this.cargar(this.prisma, id);
    if (p.as2IdPedidoCliente !== null)
      throw new ConflictException('Este pedido ya está vinculado con AS2');
    const otro = await this.prisma.pedido.findUnique({
      where: { as2IdPedidoCliente: as2Id },
      select: { codigo: true },
    });
    if (otro)
      throw new ConflictException(
        `El pedido de AS2 ${as2Id} ya está vinculado a otro pedido del portal`,
      );
    const as2 = await this.directorio.as2Pedido(as2Id, ctx.token);
    if (!as2) throw new NotFoundException(`El pedido ${as2Id} no existe en AS2`);

    await this.prisma.$transaction(async (tx) => {
      await tx.pedido.update({
        where: { id },
        data: {
          as2IdPedidoCliente: as2.idPedidoCliente,
          as2Numero: as2.numero,
          as2Estado: as2.estado,
          as2Fecha: as2.fecha ? fechaDia(as2.fecha) : null,
          as2Total: as2.total,
          as2Descuento: as2.descuento,
          as2Impuesto: as2.impuesto,
          as2Descripcion: as2.descripcion,
          as2SyncEstado: 'vinculado',
          as2VinculoMetodo: 'manual',
          as2SincronizadoAt: new Date(),
          version: { increment: 1 },
          updatedBy: ctx.actor.id,
        },
      });
      await this.secuencias.observarAs2(tx, 'pedido_cliente_as2', as2.numero);
      await this.publicar(tx, 'comercial.pedido.vinculado_as2', id, ctx, {
        codigo: p.codigo,
        as2IdPedidoCliente: as2.idPedidoCliente,
        as2Numero: as2.numero,
        metodo: 'manual',
      });
    });
    return this.detalle(id, ctx);
  }

  /**
   * Trae las líneas del pedido de AS2 y las deja como ítems del pedido, **solo las que existen en la lista de precios del
   * cliente** (el precio y el descuento son los de la lista, no los de AS2). Las que no coinciden se informan.
   */
  async importarLineasAs2(id: string, ctx: Contexto) {
    const p = await this.cargar(this.prisma, id);
    if (p.as2IdPedidoCliente === null)
      throw new BadRequestException('Este pedido no está vinculado con AS2');
    if (!EDITABLES.has(p.estado)) throw new ConflictException('Este pedido ya no se puede editar');
    if (!p.clienteId)
      throw new BadRequestException('Elija primero el cliente para usar su lista de precios');
    const as2 = await this.directorio.as2Pedido(p.as2IdPedidoCliente, ctx.token);
    if (!as2) throw new NotFoundException('El pedido ya no existe en AS2');
    const lineas = as2.lineas ?? [];
    if (lineas.length === 0) {
      throw new ConflictException(
        'AS2 no entrega líneas para este pedido (ver pedidos en estado ELABORADO)',
      );
    }

    const codigos = lineas.map((l) => l.codigo).filter((c): c is string => !!c);
    const enLista = await this.itemsDeLista(p.clienteId, codigos);
    const aceptadas: ItemPedidoDto[] = [];
    const sinCoincidencia: string[] = [];
    for (const l of lineas) {
      const it = l.codigo ? enLista.get(l.codigo) : undefined;
      if (!it) {
        sinCoincidencia.push(l.codigo ?? '(sin código)');
        continue;
      }
      aceptadas.push({ listaPreciosItemId: it.id, cantidad: l.cantidad } as ItemPedidoDto);
    }
    if (aceptadas.length === 0) {
      return { importados: 0, sinCoincidencia, pedido: await this.detalle(id, ctx) };
    }
    const items = await this.prepararItems(aceptadas, p.clienteId, id, ctx, 'as2');
    await this.prisma.$transaction(async (tx) => {
      await tx.pedido.update({
        where: { id },
        data: { version: { increment: 1 }, updatedBy: ctx.actor.id },
      });
      await this.escribirHijos(tx, id, undefined, undefined, items);
    });
    return { importados: aceptadas.length, sinCoincidencia, pedido: await this.detalle(id, ctx) };
  }

  /**
   * Adjunta al pedido un archivo ya subido al módulo `archivos` (módulo `pedido_documento`). Solo el archivo que subió la
   * misma persona, mientras el pedido es editable. El contenido no pasa por aquí: se guarda su id y una copia de nombre,
   * tipo y tamaño.
   */
  async adjuntarDocumento(id: string, archivoId: string, ctx: Contexto) {
    const p = await this.cargar(this.prisma, id);
    if (!EDITABLES.has(p.estado)) throw new ConflictException('Este pedido ya no se puede editar');
    if (p.documentos.length >= MAX_DOCUMENTOS) {
      throw new BadRequestException(`Un pedido admite hasta ${MAX_DOCUMENTOS} documentos`);
    }
    if (p.documentos.some((d) => d.archivoId === archivoId)) {
      throw new ConflictException('Ese archivo ya está adjunto al pedido');
    }
    const a = await this.directorio.archivo(archivoId, ctx.token);
    if (!a) throw new BadRequestException('El archivo indicado no existe');
    if (a.modulo !== MODULO_ARCHIVO) {
      throw new BadRequestException('El archivo no se subió como documento de pedido');
    }
    if (a.subidoPor !== ctx.actor.id) {
      throw new BadRequestException('Solo se puede adjuntar un archivo que usted mismo subió');
    }
    await this.prisma.pedidoDocumento.create({
      data: {
        id: uuidv7(),
        pedidoId: id,
        archivoId: a.id,
      },
    });
    return this.detalle(id, ctx);
  }

  async quitarDocumento(id: string, documentoId: string, ctx: Contexto) {
    const p = await this.cargar(this.prisma, id);
    if (!EDITABLES.has(p.estado)) throw new ConflictException('Este pedido ya no se puede editar');
    const doc = p.documentos.find((d) => d.id === documentoId);
    if (!doc) throw new NotFoundException('El documento no existe en este pedido');
    await this.prisma.pedidoDocumento.delete({ where: { id: documentoId } });
    await this.directorio.eliminarArchivo(doc.archivoId, ctx.token);
    return this.detalle(id, ctx);
  }

  /** Valida las filas del Excel de AS2 contra la lista de precios del cliente (no guarda nada). */
  async validarPlantilla(dto: ValidarPlantillaDto) {
    const enLista = await this.itemsDeLista(
      dto.clienteId,
      dto.filas.map((f) => f.codigo),
    );
    const items: unknown[] = [];
    const errores: { fila: number; codigo: string; motivo: string }[] = [];
    dto.filas.forEach((f, i) => {
      const it = enLista.get(f.codigo.trim());
      if (!it) {
        errores.push({
          fila: i + 1,
          codigo: f.codigo,
          motivo: 'El código no existe en la lista de precios del cliente',
        });
        return;
      }
      const precioLista = Number(it.precio);
      items.push({
        fila: i + 1,
        listaPreciosItemId: it.id,
        codigo: it.codigo,
        descripcion: it.descripcion,
        unidad: it.unidad,
        cantidad: f.cantidad,
        precioLista,
        descuentoPct: f.descuentoPct ?? null,
        // el precio válido es el de la lista; si el archivo traía otro, se avisa la diferencia
        diferenciaPrecio:
          f.precio !== undefined && Math.abs(f.precio - precioLista) > 0.005
            ? Math.round((f.precio - precioLista) * 100) / 100
            : null,
        origen: 'plantilla',
      });
    });
    return { items, errores };
  }

  // =============================================================================================================
  // Internos
  // =============================================================================================================

  private async cargar(
    db: Prisma.TransactionClient | PrismaService,
    id: string,
  ): Promise<PedidoConHijos> {
    const p = await db.pedido.findUnique({ where: { id }, include: INCLUDE });
    if (!p) throw new NotFoundException(`El pedido ${id} no existe`);
    return p;
  }

  private async abrirEnTx(tx: Prisma.TransactionClient, id: string, ctx: Contexto): Promise<void> {
    const p = await this.cargar(tx, id);
    if (p.estado !== 'borrador' && p.estado !== 'en_correccion') {
      throw new ConflictException(`Un pedido en "${p.estadoRef.nombre}" no se puede abrir`);
    }
    const faltan = this.faltantes(p);
    if (faltan.length) {
      throw new BadRequestException({
        message: `El pedido está incompleto. Falta: ${faltan.join(', ')}`,
        code: 'PEDIDO_INCOMPLETO',
      });
    }
    // técnico HSE: debe seguir activo y con el rol correcto al momento de abrir
    const [hse] = await this.directorio.usuarios([p.tecnicoHseId as string], ctx.token);
    if (!hse || !hse.activo || hse.roleCode !== 'tecnico_hse') {
      throw new BadRequestException(
        'El técnico HSE responsable debe ser un usuario activo con el rol de Técnico HSE',
      );
    }

    // El código del pedido ES el número del pedido de AS2 (`PEC-004675`): el de AS2 si el pedido viene de allá; si se creó en
    // el portal, se reserva el siguiente del secuencial de AS2 (el que AS2 debe usar al crearlo allá).
    const primeraVez = p.codigo === null;
    let codigo = p.codigo as string;
    if (primeraVez) {
      if (p.as2Numero) {
        codigo = p.as2Numero;
        await this.secuencias.observarAs2(tx, 'pedido_cliente_as2', p.as2Numero);
      } else {
        codigo = (
          await this.secuencias.reservarSiguiente(tx, {
            documento: 'pedido_cliente_as2',
            documentoRefId: id,
            actorId: ctx.actor.id,
          })
        ).codigo;
      }
      if (await tx.pedido.findFirst({ where: { codigo, NOT: { id } }, select: { id: true } })) {
        throw new ConflictException(`El número ${codigo} ya lo tiene otro pedido del portal`);
      }
    }

    // El ticket (la prefactura que vendrá) ya tiene su número desde que el pedido nace: se toma del secuencial de la prefactura.
    const ticket = primeraVez
      ? await this.secuencias.reservarSiguiente(tx, {
          documento: 'prefactura',
          documentoRefId: id,
          actorId: ctx.actor.id,
        })
      : null;

    await this.workflow.aplicar(tx, {
      proceso: PROCESO_PEDIDO,
      entidadId: id,
      desde: p.estado,
      hacia: 'abierto',
      actor: flujo(ctx.actor),
      origen: 'manual',
    });
    await tx.pedido.update({
      where: { id },
      data: {
        estado: 'abierto',
        codigo,
        version: { increment: 1 },
        updatedBy: ctx.actor.id,
        ...(ticket ? { ticketNumero: ticket.numero, ticketEmisionId: ticket.emisionId } : {}),
      },
    });

    if (primeraVez) {
      await this.publicar(tx, 'comercial.pedido.abierto', id, ctx, {
        codigo,
        ticketNumero: ticket?.numero ?? null,
        origen: p.origen,
        lineaServicio: p.linea?.codigo ?? null,
        tipoOt: p.tipoOt?.codigo ?? null,
        tiposServicio: p.tiposServicio.map((t) => t.tipo.codigo).sort(),
        // solo ids: quien necesite el nombre lo obtiene de los catálogos (FK), no del evento
        clienteId: p.clienteId,
        campoId: p.campoId,
        bloqueId: p.bloqueId,
        pozoId: p.pozoId,
        taladroId: p.taladroId,
        rigless: p.rigless,
        numeroContrato: p.numeroContrato,
        // el Company Man: Pumping lo muestra en el reporte diario (solo el id; el nombre sale del catálogo)
        representanteCampoId: p.representanteCampoId,
        fechaInicioServicio: p.fechaInicioServicio?.toISOString().slice(0, 10) ?? null,
        fechaFinServicio: p.fechaFinServicio?.toISOString().slice(0, 10) ?? null,
        as2Numero: p.as2Numero,
        // las líneas cotizadas, para que Operaciones arme su precarga (FCR: herramientas; Pumping: químicos)
        lineas: p.items.map((it) => ({
          codigo: it.codigo,
          descripcion: it.descripcion,
          unidad: it.unidad,
          cantidad: Number(it.cantidad),
          tipoLinea: it.tipoLinea,
        })),
      });
    } else {
      await this.publicar(tx, 'comercial.pedido.estado_cambiado', id, ctx, {
        codigo,
        estadoAnterior: p.estado,
        estadoNuevo: 'abierto',
      });
    }
  }

  private async cambiarEstadoEnTx(
    tx: Prisma.TransactionClient,
    p: PedidoConHijos,
    hacia: string,
    motivo: string | undefined,
    ctx: Contexto,
    origen: 'manual' | 'forzado',
  ): Promise<void> {
    const cambio = await this.workflow.aplicar(tx, {
      proceso: PROCESO_PEDIDO,
      entidadId: p.id,
      desde: p.estado,
      hacia,
      motivo,
      actor: flujo(ctx.actor),
      origen,
      permisoForzar: Permission.PEDIDOS_FORZAR_ESTADO,
    });
    // compare-and-set: si otro cambió el estado entre la lectura y este UPDATE, no se pisa
    const r = await tx.pedido.updateMany({
      where: { id: p.id, estado: p.estado },
      data: {
        estado: hacia,
        version: { increment: 1 },
        updatedBy: ctx.actor.id,
        ...(hacia === 'anulado'
          ? { motivoAnulacion: motivo?.trim() ?? null, anuladoAt: new Date() }
          : {}),
      },
    });
    if (r.count === 0)
      throw new ConflictException('El estado del pedido cambió mientras se guardaba; recargue');

    await this.publicar(tx, 'comercial.pedido.estado_cambiado', p.id, ctx, {
      codigo: p.codigo,
      estadoAnterior: p.estado,
      estadoNuevo: hacia,
      macroEstado: cambio.macroEstado,
      motivo: motivo?.trim() ?? null,
      origen,
    });
    if (hacia === 'anulado') {
      // el número de ticket de un pedido anulado no se reutiliza
      if (p.ticketEmisionId)
        await this.secuencias.anularEn(tx, p.ticketEmisionId, `Pedido ${p.codigo ?? ''} anulado`);
      await this.publicar(tx, 'comercial.pedido.anulado', p.id, ctx, {
        codigo: p.codigo,
        motivo: motivo?.trim(),
      });
    }
    if (hacia === 'en_correccion') {
      await this.publicar(tx, 'comercial.pedido.rechazado', p.id, ctx, {
        codigo: p.codigo,
        motivo: motivo?.trim(),
      });
    }
    if (hacia === 'documentos_completos') {
      // el pedido terminó su fase operativa: se avisa a la jefa de Facturación para que asigne analista
      await this.publicar(tx, 'comercial.pedido.listo_para_facturacion', p.id, ctx, {
        codigo: p.codigo,
        sinAnalista: p.analistaFacturacionId === null,
      });
    }
  }

  /** Lo que le falta a un pedido para poder abrirse (mensajes para la persona, no códigos). */
  private faltantes(p: PedidoConHijos): string[] {
    const f: string[] = [];
    if (!p.clienteId) f.push('cliente');
    if (!p.lineaId) f.push('línea de servicio');
    if (!p.tipoOtId) f.push('tipo de OT');
    if (p.tiposServicio.length === 0) f.push('tipo de servicio');
    else if (p.lineaId) {
      const ajenos = p.tiposServicio.filter((t) => t.tipo.lineaId !== p.lineaId);
      if (ajenos.length)
        f.push(
          `tipos de servicio que no corresponden a ${p.linea?.nombre ?? 'la línea'} (${ajenos.map((t) => t.tipo.codigo).join(', ')})`,
        );
    }
    if (!p.campoId) f.push('campo');
    if (!p.pozoId) f.push('pozo');
    if (!p.rigless && !p.taladroId) f.push('taladro (o marcar "rigless")');
    if (!p.numeroContrato) f.push('número de contrato');
    if (!p.fechaInicioServicio) f.push('fecha de inicio del servicio');
    if (!p.fechaFinServicio) f.push('fecha de fin del servicio');
    if (!p.agenteComercialId) f.push('agente comercial');
    if (!p.tecnicoHseId) f.push('técnico HSE');
    if (!p.bodegaId) f.push('bodega');
    if (p.items.length === 0) f.push('al menos un ítem de la lista de precios');
    return f;
  }

  /**
   * Valida los ids de catálogo y de personas (existen, están activos, son coherentes entre sí; el nombre se obtiene luego con JOIN). Solo toca lo
   * que viene en el DTO; `null` borra el dato. Devuelve el `data` parcial para Prisma.
   */
  private async resolver(
    dto: Partial<CrearPedidoDto & ActualizarPedidoDto>,
    actual: PedidoConHijos | null,
    ctx: Contexto,
  ) {
    const data: Record<string, unknown> = {};
    const t = ctx.token;
    let clienteId: string | null | undefined;

    if (dto.clienteId !== undefined) {
      if (dto.clienteId === null) {
        Object.assign(data, { clienteId: null });
        clienteId = null;
      } else {
        const c = await this.directorio.cliente(dto.clienteId, t);
        if (!c) throw new BadRequestException('El cliente indicado no existe');
        Object.assign(data, { clienteId: c.id });
        clienteId = c.id;
      }
    }

    // ubicación
    const rigless = dto.rigless ?? actual?.rigless ?? false;
    if (dto.rigless === true && dto.taladroId) {
      throw new BadRequestException('Un trabajo "rigless" no lleva taladro');
    }
    let campoId = dto.campoId === undefined ? actual?.campoId : dto.campoId;
    let bloqueId = dto.bloqueId === undefined ? actual?.bloqueId : dto.bloqueId;
    if (dto.pozoId !== undefined) {
      if (dto.pozoId === null) Object.assign(data, { pozoId: null });
      else {
        const pz = await this.directorio.pozo(dto.pozoId, t);
        if (!pz) throw new BadRequestException('El pozo indicado no existe');
        if (pz.campoId && campoId && pz.campoId !== campoId) {
          throw new BadRequestException('El pozo no pertenece al campo indicado');
        }
        if (pz.bloqueId && bloqueId && pz.bloqueId !== bloqueId) {
          throw new BadRequestException('El pozo no pertenece al bloque indicado');
        }
        Object.assign(data, { pozoId: pz.id });
        // si no se eligió campo o bloque, se toman del pozo
        campoId = campoId ?? pz.campoId ?? undefined;
        bloqueId = bloqueId ?? pz.bloqueId ?? undefined;
        if (dto.campoId === undefined && campoId) dto = { ...dto, campoId };
        if (dto.bloqueId === undefined && bloqueId) dto = { ...dto, bloqueId };
      }
    }
    const simple = async (
      clave: 'campoId' | 'bloqueId' | 'taladroId',
      buscar: (id: string, token: string) => Promise<{ id: string; nombre: string } | null>,
      etiqueta: string,
    ) => {
      const v = dto[clave];
      if (v === undefined) return;
      if (v === null) {
        Object.assign(data, { [clave]: null });
        return;
      }
      const r = await buscar(v, t);
      if (!r) throw new BadRequestException(`El ${etiqueta} indicado no existe`);
      Object.assign(data, { [clave]: r.id });
    };
    // La zona es la del campo: no se guarda en el pedido, se obtiene del campo.
    await simple('campoId', (i, k) => this.directorio.campo(i, k), 'campo');
    await simple('bloqueId', (i, k) => this.directorio.bloque(i, k), 'bloque');
    await simple('taladroId', (i, k) => this.directorio.taladro(i, k), 'taladro');
    if (dto.rigless !== undefined) {
      data['rigless'] = dto.rigless;
      if (dto.rigless) Object.assign(data, { taladroId: null });
    }
    if (rigless && dto.taladroId)
      throw new BadRequestException('Un trabajo "rigless" no lleva taladro');

    // personas
    const ids = [dto.agenteComercialId, dto.tecnicoHseId].filter(
      (x): x is string => typeof x === 'string',
    );
    const usuarios = await this.directorio.usuarios(ids, t);
    const usuario = (id: string, etiqueta: string) => {
      const u = usuarios.find((x) => x.id === id);
      if (!u || !u.activo)
        throw new BadRequestException(`El ${etiqueta} indicado no existe o está inactivo`);
      return u;
    };
    if (dto.agenteComercialId !== undefined) {
      if (dto.agenteComercialId === null) Object.assign(data, { agenteComercialId: null });
      else {
        const u = usuario(dto.agenteComercialId, 'agente comercial');
        Object.assign(data, { agenteComercialId: u.id });
      }
    }
    if (dto.tecnicoHseId !== undefined) {
      if (dto.tecnicoHseId === null) Object.assign(data, { tecnicoHseId: null });
      else {
        const u = usuario(dto.tecnicoHseId, 'técnico HSE');
        if (u.roleCode !== 'tecnico_hse')
          throw new BadRequestException('El técnico HSE debe tener el rol de Técnico HSE');
        Object.assign(data, { tecnicoHseId: u.id });
      }
    }
    for (const [clave, etiqueta] of [
      ['representanteCampoId', 'representante de campo'],
      ['representanteQuitoId', 'representante de Quito'],
    ] as const) {
      const v = dto[clave];
      if (v === undefined) continue;
      if (v === null) {
        Object.assign(data, { [clave]: null });
        continue;
      }
      const r = await this.directorio.persona(v, t);
      if (!r) throw new BadRequestException(`El ${etiqueta} indicado no existe`);
      Object.assign(data, { [clave]: r.id });
    }

    // datos simples
    for (const k of ['subcliente', 'numeroContrato', 'solicitudMedio'] as const) {
      if (dto[k] !== undefined) data[k] = dto[k];
    }
    if (dto.tipoOt !== undefined) {
      const tipo = await this.prisma.tipoOt.findFirst({
        where: { codigo: dto.tipoOt, activo: true },
        select: { id: true },
      });
      if (!tipo) throw new BadRequestException(`El tipo de OT "${dto.tipoOt}" no existe`);
      data['tipoOtId'] = tipo.id;
    }
    // bodega y condición de pago: FK al catálogo
    for (const [clave, etiqueta, buscar] of [
      ['bodegaId', 'bodega', (i: string) => this.directorio.bodega(i, t)],
      ['condicionPagoId', 'condición de pago', (i: string) => this.directorio.condicionPago(i, t)],
    ] as const) {
      const v = dto[clave];
      if (v === undefined) continue;
      if (v === null) {
        Object.assign(data, { [clave]: null });
        continue;
      }
      const r = await buscar(v);
      if (!r) throw new BadRequestException(`La ${etiqueta} indicada no existe`);
      Object.assign(data, { [clave]: r.id });
    }
    if (dto.fechaInicioServicio !== undefined) {
      data['fechaInicioServicio'] = dto.fechaInicioServicio
        ? fechaDia(dto.fechaInicioServicio)
        : null;
    }
    if (dto.fechaFinServicio !== undefined) {
      data['fechaFinServicio'] = dto.fechaFinServicio ? fechaDia(dto.fechaFinServicio) : null;
    }
    const ini =
      (data['fechaInicioServicio'] as Date | null | undefined) ??
      actual?.fechaInicioServicio ??
      null;
    const fin =
      (data['fechaFinServicio'] as Date | null | undefined) ?? actual?.fechaFinServicio ?? null;
    if (ini && fin && fin < ini)
      throw new BadRequestException('La fecha de fin no puede ser anterior a la de inicio');

    // línea, tipos y subtipos de servicio: catálogo en base de datos (hacia afuera se usan los códigos)
    let lineaId = actual?.lineaId ?? null;
    if (dto.lineaServicio !== undefined) {
      const linea = await this.prisma.servicioLinea.findFirst({
        where: { codigo: dto.lineaServicio, activo: true },
        select: { id: true },
      });
      if (!linea)
        throw new BadRequestException(`La línea de servicio "${dto.lineaServicio}" no existe`);
      lineaId = linea.id;
      data['lineaId'] = linea.id;
    }
    const servicios = await this.validarServicios(
      lineaId,
      dto.tiposServicio,
      dto.subtiposServicio,
      actual,
    );
    return {
      data: data as Prisma.PedidoUncheckedUpdateInput,
      clienteId,
      tipos: servicios?.tipoIds,
      subtipos: servicios?.subtipos,
    };
  }

  /** Ítems de la lista de precios activa del cliente por código (la lista vigente más reciente gana). */
  private async itemsDeLista(clienteId: string, codigos: string[]) {
    const filas = await this.prisma.listaPreciosItem.findMany({
      where: {
        codigo: { in: [...new Set(codigos.map((c) => c.trim()))] },
        listaPrecios: { clienteId, activa: true },
      },
      include: { listaPrecios: { select: { vigenteDesde: true } } },
      orderBy: { listaPrecios: { vigenteDesde: 'desc' } },
    });
    const m = new Map<string, (typeof filas)[number]>();
    for (const f of filas) if (!m.has(f.codigo)) m.set(f.codigo, f);
    return m;
  }

  /** Valida y copia los ítems elegidos desde la lista de precios del cliente. */
  private async prepararItems(
    items: ItemPedidoDto[] | undefined,
    clienteId: string | null | undefined,
    pedidoId: string,
    ctx: Contexto,
    origenForzado?: 'as2',
  ): Promise<Prisma.PedidoItemCreateManyInput[] | undefined> {
    void ctx;
    if (items === undefined) return undefined;
    if (items.length === 0) return [];
    if (!clienteId)
      throw new BadRequestException(
        'Elija primero el cliente: los ítems salen de su lista de precios',
      );
    const filas = await this.prisma.listaPreciosItem.findMany({
      where: { id: { in: items.map((i) => i.listaPreciosItemId) } },
      include: { listaPrecios: { select: { clienteId: true, activa: true } } },
    });
    const porId = new Map(filas.map((f) => [f.id, f]));
    return items.map((i, idx) => {
      const li = porId.get(i.listaPreciosItemId);
      if (!li) throw new BadRequestException(`El ítem ${idx + 1} no existe en la lista de precios`);
      if (!li.listaPrecios.activa || li.listaPrecios.clienteId !== clienteId) {
        throw new BadRequestException(
          `El ítem ${li.codigo} no pertenece a la lista de precios activa del cliente`,
        );
      }
      return {
        id: uuidv7(),
        pedidoId,
        orden: idx + 1,
        codigo: li.codigo,
        descripcion: li.descripcion,
        unidad: li.unidad,
        cantidad: i.cantidad,
        valorUnitario: li.precio,
        descuentoPct: i.descuentoPct ?? null,
        origenItem: origenForzado ?? i.origen ?? 'lista',
        listaPreciosItemId: li.id,
        tipoLinea: i.tipoLinea ?? tipoLineaDeLista(li.tipo, li.descripcion),
      };
    });
  }

  /**
   * Valida línea, tipos y subtipos contra el catálogo y devuelve lo que se guardará (undefined = no tocar), ya en ids.
   * Reglas: los tipos pertenecen a la línea; cada subtipo pertenece al tipo que se indica y ese tipo está elegido en el
   * mismo pedido. Si cambian los tipos y no se envían subtipos, se conservan solo los de los tipos que siguen.
   */
  private async validarServicios(
    lineaId: string | null,
    tiposDto: string[] | undefined,
    subtiposDto: Array<{ tipo: string; subtipo: string }> | undefined,
    actual: PedidoConHijos | null,
  ): Promise<
    { tipoIds: string[]; subtipos: Array<{ tipoId: string; subtipoId: string }> } | undefined
  > {
    if (tiposDto === undefined && subtiposDto === undefined) return undefined;

    // tipos elegidos: código -> id
    const codigos = [...new Set(tiposDto ?? actual?.tiposServicio.map((t) => t.tipo.codigo) ?? [])];
    const catalogo = codigos.length
      ? await this.prisma.servicioTipo.findMany({
          where: { codigo: { in: codigos }, activo: true },
        })
      : [];
    const tipoPorCodigo = new Map(catalogo.map((t) => [t.codigo, t]));
    if (tiposDto !== undefined) {
      const desconocidos = codigos.filter((c) => !tipoPorCodigo.has(c));
      if (desconocidos.length) {
        throw new BadRequestException(`Tipos de servicio inexistentes: ${desconocidos.join(', ')}`);
      }
      const ajenos = lineaId ? catalogo.filter((t) => t.lineaId !== lineaId) : [];
      if (ajenos.length) {
        throw new BadRequestException(
          `Los tipos de servicio ${ajenos.map((t) => t.codigo).join(', ')} no corresponden a la línea elegida`,
        );
      }
    }
    const tipoIds = catalogo.map((t) => t.id);

    // subtipos pedidos (o los actuales, si solo cambiaron los tipos)
    const base =
      subtiposDto ??
      (actual?.tiposServicio ?? []).flatMap((t) =>
        t.subtipos.map((x) => ({ tipo: t.tipo.codigo, subtipo: x.catalogo.nombre })),
      );
    const clave = (s: { tipo: string; subtipo: string }) => `${s.tipo}|${s.subtipo}`;
    const vistos = new Set<string>();
    const pedidos = base
      .map((s) => ({ tipo: s.tipo.trim(), subtipo: s.subtipo.trim() }))
      .filter((s) => s.subtipo && !vistos.has(clave(s)) && vistos.add(clave(s)));
    if (subtiposDto === undefined) {
      // solo los de los tipos que siguen elegidos
      const conservar = pedidos.filter((s) => tipoPorCodigo.has(s.tipo));
      return { tipoIds, subtipos: await this.subtiposAIds(conservar, tipoPorCodigo) };
    }

    const fueraDeTipo = pedidos.filter((s) => !tipoPorCodigo.has(s.tipo));
    if (fueraDeTipo.length) {
      throw new BadRequestException(
        `Los subtipos ${fueraDeTipo.map((s) => `"${s.subtipo}"`).join(', ')} indican un tipo que el pedido no tiene elegido`,
      );
    }
    return { tipoIds, subtipos: await this.subtiposAIds(pedidos, tipoPorCodigo, true) };
  }

  /** Traduce (código de tipo, nombre de subtipo) a ids del catálogo; con `estricto`, rechaza los que no existan. */
  private async subtiposAIds(
    pares: Array<{ tipo: string; subtipo: string }>,
    tipoPorCodigo: Map<string, { id: string }>,
    estricto = false,
  ) {
    if (pares.length === 0) return [];
    const existentes = await this.prisma.servicioSubtipo.findMany({
      where: {
        activo: true,
        OR: pares.map((s) => ({ tipoId: tipoPorCodigo.get(s.tipo)?.id, nombre: s.subtipo })),
      },
    });
    const porClave = new Map(existentes.map((e) => [`${e.tipoId}|${e.nombre}`, e.id]));
    const resultado: Array<{ tipoId: string; subtipoId: string }> = [];
    const malos: string[] = [];
    for (const s of pares) {
      const tipoId = tipoPorCodigo.get(s.tipo)?.id as string;
      const subtipoId = porClave.get(`${tipoId}|${s.subtipo}`);
      if (subtipoId) resultado.push({ tipoId, subtipoId });
      else malos.push(`"${s.subtipo}" (${s.tipo})`);
    }
    if (estricto && malos.length) {
      throw new BadRequestException(
        `Los subtipos ${malos.join(', ')} no pertenecen a su tipo de servicio`,
      );
    }
    return resultado;
  }

  /** Reemplaza tipos, subtipos e ítems cuando vienen (undefined = no tocar). */
  private async escribirHijos(
    tx: Prisma.TransactionClient,
    pedidoId: string,
    tipoIds: string[] | undefined,
    subtipos: Array<{ tipoId: string; subtipoId: string }> | undefined,
    items: Prisma.PedidoItemCreateManyInput[] | undefined,
  ) {
    // Los subtipos cuelgan de los tipos del mismo pedido: se borran primero y se crean al final.
    if (tipoIds !== undefined || subtipos !== undefined) {
      await tx.pedidoSubtipoServicio.deleteMany({ where: { pedidoId } });
    }
    if (tipoIds !== undefined) {
      await tx.pedidoTipoServicio.deleteMany({ where: { pedidoId } });
      const unicos = [...new Set(tipoIds)];
      if (unicos.length) {
        await tx.pedidoTipoServicio.createMany({
          data: unicos.map((tipoId) => ({ id: uuidv7(), pedidoId, tipoId })),
        });
      }
    }
    if (subtipos?.length) {
      await tx.pedidoSubtipoServicio.createMany({
        data: subtipos.map((x) => ({
          id: uuidv7(),
          pedidoId,
          tipoId: x.tipoId,
          subtipoId: x.subtipoId,
        })),
      });
    }
    if (items !== undefined) {
      await tx.pedidoItem.deleteMany({ where: { pedidoId } });
      if (items.length) await tx.pedidoItem.createMany({ data: items });
    }
  }

  /**
   * Lo que Operaciones (FCR) necesita saber cuando un pedido abierto cambia (campos compatibles del evento `comercial.pedido.actualizado`):
   * las fechas del servicio y, si cambiaron los ítems, las líneas cotizadas vigentes (mismo formato que `comercial.pedido.abierto`).
   */
  private async datosParaOperaciones(
    tx: Prisma.TransactionClient,
    pedidoId: string,
    conLineas: boolean,
  ) {
    const p = await tx.pedido.findUniqueOrThrow({
      where: { id: pedidoId },
      select: { fechaInicioServicio: true, fechaFinServicio: true },
    });
    const items = conLineas
      ? await tx.pedidoItem.findMany({ where: { pedidoId }, orderBy: { orden: 'asc' } })
      : null;
    return {
      fechaInicioServicio: p.fechaInicioServicio?.toISOString().slice(0, 10) ?? null,
      fechaFinServicio: p.fechaFinServicio?.toISOString().slice(0, 10) ?? null,
      ...(items
        ? {
            lineas: items.map((it) => ({
              codigo: it.codigo,
              descripcion: it.descripcion,
              unidad: it.unidad,
              cantidad: Number(it.cantidad),
              tipoLinea: it.tipoLinea,
            })),
          }
        : {}),
    };
  }

  private publicar(
    tx: Prisma.TransactionClient,
    type: string,
    pedidoId: string,
    ctx: Contexto,
    data: Record<string, unknown>,
  ) {
    return this.bus.publish(
      tx,
      this.bus.create({
        type,
        subject: { type: 'pedido', id: pedidoId },
        data: { pedidoId, ...data },
        actor: { userId: ctx.actor.id, role: ctx.actor.roleCode },
        traceparent: currentTraceparent(),
      }),
    );
  }
}
