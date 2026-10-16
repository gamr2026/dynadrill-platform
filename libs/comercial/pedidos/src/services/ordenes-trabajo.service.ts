import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { currentTraceparent, type AuthUser } from '@dyn/common';
import { EventBus } from '@dyn/messaging';
import { uuidv7 } from '@dyn/utils';
import { DirectorioPort } from '../directorio/directorio.port';
import { EmitirOrdenTrabajoDto } from '../dto/ordenes-trabajo.dto';
import type { Prisma } from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';
import { PedidoEstadoService } from './pedido-estado.service';
import { SecuenciasService } from './secuencias.service';

export interface ContextoOrden {
  actor: AuthUser;
  token: string;
}

const MS_DIA = 86_400_000;
const round2 = (n: number) => Math.round(n * 100) / 100;
const num = (d: Prisma.Decimal | number | null | undefined) =>
  d === null || d === undefined ? null : Number(d);
const aDia = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

const INCLUDE = {
  items: { orderBy: { orden_: 'asc' } },
  ciudad: true,
  archivoFirmado: true,
} as const;
type OrdenCompleta = Prisma.OrdenTrabajoGetPayload<{ include: typeof INCLUDE }>;

const aDto = (o: OrdenCompleta) => ({
  id: o.id,
  pedidoId: o.pedidoId,
  prefacturaId: o.prefacturaId,
  numero: o.numero,
  codigo: o.codigo,
  ciudad: { id: o.ciudadId, codigo: o.ciudad.codigo, nombre: o.ciudad.nombre },
  anio: o.anio,
  fecha: aDia(o.fecha),
  numeroContrato: o.numeroContrato,
  textoContrato: o.textoContrato,
  descripcionRequerimiento: o.descripcionRequerimiento,
  servicio: o.servicio,
  fechaInicio: aDia(o.fechaInicio),
  fechaTerminacion: aDia(o.fechaTerminacion),
  valorOt: num(o.valorOt),
  representanteContratista: { nombre: o.contratistaNombre, cargo: o.contratistaCargo },
  representanteCliente: { nombre: o.clienteNombre, cargo: o.clienteCargo },
  estado: o.estado,
  generadaAt: o.generadaAt,
  firmada: o.firmadaAt
    ? {
        at: o.firmadaAt,
        archivoId: o.archivoFirmadoId,
        archivoNombre: o.archivoFirmado?.nombreOriginal ?? null,
      }
    : null,
  items: o.items.map((i) => ({
    orden: i.orden_,
    codigo: i.codigo,
    servicioRequerido: i.descripcion,
    unidad: i.unidad,
    tarifaUnitaria: num(i.tarifa),
    cantidad: num(i.cantidad),
    total: num(i.total),
  })),
});

/**
 * Orden de trabajo (OT, "resumen de costos"): se genera de la prefactura firmada, solo para los clientes cuyo contrato la
 * exige, con un número propio que no se reinicia (`{n}-OPR-{pozo}-{ciudad}-{año}`). La firma es física: el portal anota
 * quién la marcó como firmada. Cada cambio de estado del pedido va por el motor de estados.
 */
@Injectable()
export class OrdenesTrabajoService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly secuencias: SecuenciasService,
    private readonly estados: PedidoEstadoService,
    private readonly directorio: DirectorioPort,
    private readonly bus: EventBus,
  ) {}

  /** La OT del pedido (o `null`) y si el contrato del cliente la requiere. */
  async delPedido(pedidoId: string) {
    const p = await this.prisma.pedido.findUnique({
      where: { id: pedidoId },
      select: { id: true },
    });
    if (!p) throw new NotFoundException('El pedido no existe');
    const orden = await this.prisma.ordenTrabajo.findUnique({
      where: { pedidoId },
      include: INCLUDE,
    });
    return {
      requiere: await this.requiere(this.prisma, pedidoId),
      orden: orden ? aDto(orden) : null,
    };
  }

  async ciudades() {
    return this.prisma.ciudadOt.findMany({ where: { activo: true }, orderBy: { codigo: 'asc' } });
  }

  async emitir(pedidoId: string, dto: EmitirOrdenTrabajoDto, ctx: ContextoOrden) {
    const id = uuidv7();
    await this.prisma.$transaction(async (tx) => {
      const pedido = await tx.pedido.findUnique({
        where: { id: pedidoId },
        include: { pozo: true, taladro: true },
      });
      if (!pedido) throw new NotFoundException('El pedido no existe');
      if (await tx.ordenTrabajo.findUnique({ where: { pedidoId }, select: { id: true } })) {
        throw new ConflictException('El pedido ya tiene su orden de trabajo');
      }
      if (pedido.estado !== 'ticket_firmado') {
        throw new ConflictException(
          'La orden de trabajo se genera cuando la prefactura está firmada por el cliente',
        );
      }
      const prefactura = await tx.prefactura.findFirst({
        where: { pedidoId, estado: 'firmada' },
        include: {
          items: { orderBy: { orden: 'asc' } },
          firmas: { orderBy: { createdAt: 'desc' } },
        },
      });
      if (!prefactura) throw new ConflictException('El pedido no tiene una prefactura firmada');
      if (!(await this.requiere(tx, pedidoId))) {
        throw new ConflictException('El contrato de este cliente no requiere orden de trabajo');
      }
      if (!pedido.pozo)
        throw new UnprocessableEntityException(
          'El pedido no tiene pozo: el número de la OT lo lleva',
        );
      if (!pedido.fechaInicioServicio) {
        throw new UnprocessableEntityException(
          'El pedido no tiene fecha de inicio del servicio: la OT lleva el día anterior',
        );
      }

      const ciudad = dto.ciudadId
        ? await tx.ciudadOt.findUnique({ where: { id: dto.ciudadId } })
        : await tx.ciudadOt.findFirst({ where: { activo: true }, orderBy: { codigo: 'asc' } });
      if (!ciudad || !ciudad.activo) throw new BadRequestException('La ciudad indicada no existe');
      const contratista = await tx.firmanteContratista.findFirst({
        where: { activo: true, predeterminado: true },
      });
      if (!contratista)
        throw new ConflictException('No hay un firmante de la contratista predeterminado');
      const firmaCliente = prefactura.firmas.find((f) => f.firmanteTipo === 'cliente');
      const clienteNombre = dto.representanteClienteNombre?.trim() || firmaCliente?.nombre;
      const clienteCargo = dto.representanteClienteCargo?.trim() || firmaCliente?.cargo;
      if (!clienteNombre || !clienteCargo) {
        throw new BadRequestException(
          'Indique el nombre y el cargo del representante del cliente que firma la OT',
        );
      }

      const fecha = new Date(pedido.fechaInicioServicio.getTime() - MS_DIA);
      const anio = fecha.getUTCFullYear();
      const emision = await this.secuencias.emitir(tx, {
        documento: 'orden_trabajo',
        documentoRefId: id,
        actorId: ctx.actor.id,
        fecha,
      });
      const lista = prefactura.listaPreciosId
        ? await tx.listaPrecios.findUnique({
            where: { id: prefactura.listaPreciosId },
            select: { textoContrato: true },
          })
        : null;
      const descripcion =
        dto.descripcionRequerimiento?.trim() || 'Servicio ejecutado según prefactura';
      const items = prefactura.items.map((i, k) => ({
        id: uuidv7(),
        orden_: k + 1,
        codigo: i.codigo,
        descripcion: i.descripcion,
        unidad: i.unidad,
        tarifa: i.precioUnitario,
        cantidad: i.cantidad,
        total: i.precioTotal,
      }));
      await tx.ordenTrabajo.create({
        data: {
          id,
          pedidoId,
          prefacturaId: prefactura.id,
          numero: emision.numero,
          codigo: `${emision.numero}-OPR-${pedido.pozo?.nombreCompleto}-${ciudad.codigo}-${anio}`,
          emisionId: emision.emisionId,
          ciudadId: ciudad.id,
          anio,
          fecha,
          numeroContrato: pedido.numeroContrato,
          textoContrato:
            lista?.textoContrato ??
            (pedido.numeroContrato ? `CONTRATO ${pedido.numeroContrato}` : null),
          descripcionRequerimiento: descripcion,
          servicio: `${descripcion} /${pedido.pozo?.nombreCompleto}/${pedido.rigless ? 'RIGLESS' : (pedido.taladro?.nombre ?? '')}`,
          fechaInicio: pedido.fechaInicioServicio,
          fechaTerminacion: pedido.fechaFinServicio,
          valorOt: round2(items.reduce((s, i) => s + Number(i.total), 0)),
          contratistaNombre: contratista.nombre,
          contratistaCargo: contratista.cargo,
          clienteNombre,
          clienteCargo,
          generadaPor: ctx.actor.id,
          items: { create: items },
        },
      });
      await this.estados.pasar(
        tx,
        pedidoId,
        'ticket_firmado',
        'aot_generada',
        ctx.actor,
        'orden de trabajo generada',
      );
      await this.publicar(tx, 'comercial.orden_trabajo.generada', pedidoId, id, ctx.actor);
    });
    return (await this.delPedido(pedidoId)).orden;
  }

  /** La firma es física: se anota quién la marcó como firmada y, si se sube, el archivo escaneado. */
  async marcarFirmada(id: string, archivoId: string | undefined, ctx: ContextoOrden) {
    const o = await this.prisma.ordenTrabajo.findUnique({ where: { id } });
    if (!o) throw new NotFoundException('La orden de trabajo no existe');
    if (o.estado === 'firmada') throw new ConflictException('La orden de trabajo ya está firmada');
    let archivo: { id: string } | null = null;
    if (archivoId) {
      const a = await this.directorio.archivo(archivoId, ctx.token);
      if (!a) throw new BadRequestException('El archivo indicado no existe');
      if (a.modulo !== 'orden_trabajo_documento') {
        throw new BadRequestException('El archivo no se subió como documento de orden de trabajo');
      }
      if (a.subidoPor !== ctx.actor.id)
        throw new BadRequestException('Solo se puede registrar un archivo que usted mismo subió');
      archivo = { id: a.id };
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.ordenTrabajo.update({
        where: { id },
        data: {
          estado: 'firmada',
          firmadaAt: new Date(),
          firmadaPor: ctx.actor.id,
          archivoFirmadoId: archivo?.id ?? null,
        },
      });
      await this.publicar(tx, 'comercial.orden_trabajo.firmada', o.pedidoId, id, ctx.actor);
    });
    return (await this.delPedido(o.pedidoId)).orden;
  }

  /** ¿El contrato de la prefactura vigente del pedido exige la OT? */
  async requiere(
    db: Pick<PrismaService, 'prefactura' | 'listaPrecios'>,
    pedidoId: string,
  ): Promise<boolean> {
    const pf = await db.prefactura.findFirst({
      where: { pedidoId, estado: { in: ['generada', 'enviada_para_firmas', 'firmada'] } },
      select: { listaPreciosId: true },
      orderBy: { version: 'desc' },
    });
    if (!pf?.listaPreciosId) return false;
    const lista = await db.listaPrecios.findUnique({
      where: { id: pf.listaPreciosId },
      select: { requiereOrdenTrabajo: true },
    });
    return lista?.requiereOrdenTrabajo ?? false;
  }

  private async publicar(
    tx: Prisma.TransactionClient,
    type: string,
    pedidoId: string,
    ordenId: string,
    actor: AuthUser,
  ) {
    await this.bus.publish(
      tx,
      this.bus.create({
        type,
        subject: { type: 'pedido', id: pedidoId },
        data: { pedidoId, ordenTrabajoId: ordenId },
        actor: { userId: actor.id, role: actor.roleCode },
        traceparent: currentTraceparent(),
      }),
    );
  }
}
