import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { currentTraceparent, type AuthUser } from '@dyn/common';
import { EventBus } from '@dyn/messaging';
import type { Prisma } from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';
import { OrdenesTrabajoService } from './ordenes-trabajo.service';
import { PedidoEstadoService } from './pedido-estado.service';

/**
 * Cierre del pedido después de la prefactura firmada: control de costos → listo para facturar → facturado (con el número
 * de la factura emitida en AS2). Si el contrato exige la orden de trabajo, esta va antes del control de costos. Todo
 * cambio de estado va por el motor de estados.
 */
@Injectable()
export class CierrePedidoService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly estados: PedidoEstadoService,
    private readonly ordenes: OrdenesTrabajoService,
    private readonly bus: EventBus,
  ) {}

  async enviarControlCostos(pedidoId: string, actor: AuthUser) {
    await this.prisma.$transaction(async (tx) => {
      const p = await this.pedido(tx, pedidoId);
      if (p.estado === 'ticket_firmado') {
        if (await this.ordenes.requiere(tx, pedidoId)) {
          throw new ConflictException(
            'El contrato de este cliente exige la orden de trabajo: generela antes de enviar a control de costos',
          );
        }
      } else if (p.estado !== 'aot_generada') {
        throw new ConflictException('El pedido todavía no está listo para control de costos');
      }
      await this.estados.pasar(
        tx,
        pedidoId,
        p.estado,
        'enviado_a_control_de_costos',
        actor,
        'enviado a control de costos',
      );
      await this.publicar(tx, 'comercial.pedido.enviado_a_control_de_costos', pedidoId, actor, {});
    });
    return this.estado(pedidoId);
  }

  async listoParaFacturar(pedidoId: string, actor: AuthUser) {
    await this.prisma.$transaction(async (tx) => {
      const p = await this.pedido(tx, pedidoId);
      if (p.estado !== 'enviado_a_control_de_costos') {
        throw new ConflictException(
          'El pedido debe estar en control de costos para quedar listo para facturar',
        );
      }
      await this.estados.pasar(
        tx,
        pedidoId,
        p.estado,
        'listo_para_facturar',
        actor,
        'control de costos aprobado',
      );
      await this.publicar(tx, 'comercial.pedido.listo_para_facturar', pedidoId, actor, {});
    });
    return this.estado(pedidoId);
  }

  /** Registra la factura emitida en AS2 y cierra el pedido. */
  async facturado(pedidoId: string, numeroFactura: string, actor: AuthUser) {
    const numero = numeroFactura.trim();
    await this.prisma.$transaction(async (tx) => {
      const p = await this.pedido(tx, pedidoId);
      if (p.estado !== 'listo_para_facturar') {
        throw new ConflictException('El pedido debe estar listo para facturar');
      }
      await tx.pedido.update({
        where: { id: pedidoId },
        data: { facturaNumero: numero, facturadoAt: new Date(), facturadoPor: actor.id },
      });
      await this.estados.pasar(tx, pedidoId, p.estado, 'facturado', actor, `factura ${numero}`);
      await this.publicar(tx, 'comercial.pedido.facturado', pedidoId, actor, {
        numeroFactura: numero,
      });
    });
    return this.estado(pedidoId);
  }

  async estado(pedidoId: string) {
    const p = await this.prisma.pedido.findUnique({
      where: { id: pedidoId },
      select: { estado: true, facturaNumero: true, facturadoAt: true },
    });
    if (!p) throw new NotFoundException('El pedido no existe');
    return { estado: p.estado, facturaNumero: p.facturaNumero, facturadoAt: p.facturadoAt };
  }

  private async pedido(tx: Prisma.TransactionClient, id: string) {
    const p = await tx.pedido.findUnique({ where: { id }, select: { id: true, estado: true } });
    if (!p) throw new NotFoundException('El pedido no existe');
    return p;
  }

  private async publicar(
    tx: Prisma.TransactionClient,
    type: string,
    pedidoId: string,
    actor: AuthUser,
    data: Record<string, unknown>,
  ) {
    await this.bus.publish(
      tx,
      this.bus.create({
        type,
        subject: { type: 'pedido', id: pedidoId },
        data: { pedidoId, ...data },
        actor: { userId: actor.id, role: actor.roleCode },
        traceparent: currentTraceparent(),
      }),
    );
  }
}
