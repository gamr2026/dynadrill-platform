import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AuthUser } from '@dyn/common';
import { uuidv7 } from '@dyn/utils';
import type { CausaFaltante, Prisma } from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';
import { HerramientasService } from './herramientas.service';
import { RequisitosService } from './requisitos.service';
import { nombreDe, TicketsService } from './tickets.service';

const PASO = 'control_retorno';

/**
 * Control de retorno de las herramientas (Bodega): cada herramienta recibida vuelve («devuelta») o se da por faltante con su causa
 * (venta complementaria al cliente, pérdida, daño u otro) y su detalle. Cada marca deja su evento inmutable. Cuando todas tienen su
 * retorno se cumple `herramientas_devueltas`. No mueve el kardex (consulta F-10).
 */
@Injectable()
export class RetornoService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tickets: TicketsService,
    private readonly requisitos: RequisitosService,
    private readonly herramientas: HerramientasService,
  ) {}

  /** Lo que Bodega tiene por retornar, de todos los tickets que están en el control de retorno. */
  async pendientes() {
    const filas = await this.prisma.ticketHerramienta.findMany({
      where: {
        devueltaAt: null,
        faltanteAt: null,
        recibidaAt: { not: null },
        ticket: { pasoCodigo: PASO },
      },
      include: {
        articulo: { select: { codigo: true, nombre: true } },
        ticket: { include: { cliente: true, pozo: true } },
      },
      orderBy: [{ recibidaAt: 'asc' }, { id: 'asc' }],
      take: 500,
    });
    return filas.map((f) => ({
      id: f.id,
      codigo: f.articulo.codigo,
      nombre: f.articulo.nombre,
      ticket: {
        id: f.ticketId,
        ticketNumero: f.ticket.ticketNumero,
        pedidoCodigo: f.ticket.pedidoCodigo,
        cliente: nombreDe(f.ticket.cliente),
        pozo: f.ticket.pozo?.nombreCompleto ?? null,
      },
    }));
  }

  /** Registra como devueltas las herramientas indicadas (o todas las recibidas que aún no tienen retorno). */
  async devolver(ticketId: string, herramientaIds: string[] | undefined, actor: AuthUser) {
    await this.prisma.$transaction(async (tx) => {
      await this.exigirPaso(tx, ticketId);
      const filas = await tx.ticketHerramienta.findMany({
        where: {
          ticketId,
          recibidaAt: { not: null },
          devueltaAt: null,
          faltanteAt: null,
          ...(herramientaIds?.length ? { id: { in: herramientaIds } } : {}),
        },
        select: { id: true },
      });
      if (herramientaIds?.length && filas.length !== new Set(herramientaIds).size) {
        throw new BadRequestException(
          'Alguna herramienta no existe en este ticket, no fue recibida o ya tiene su retorno',
        );
      }
      if (!filas.length) throw new ConflictException('No hay herramientas por devolver');
      await tx.ticketHerramienta.updateMany({
        where: { id: { in: filas.map((f) => f.id) } },
        data: { devueltaAt: new Date(), devueltaPor: actor.id, updatedBy: actor.id },
      });
      await tx.ticketHerramientaEvento.createMany({
        data: filas.map((f) => ({
          id: uuidv7(),
          herramientaId: f.id,
          tipo: 'devuelta' as const,
          actorId: actor.id,
        })),
      });
      await this.requisitos.sincronizarDeHerramientas(tx, ticketId, actor.id);
    });
    return this.herramientas.detalle(ticketId);
  }

  /** Da una herramienta por faltante con su causa y el detalle de lo ocurrido. */
  async faltante(
    ticketId: string,
    herramientaId: string,
    causa: CausaFaltante,
    detalle: string,
    actor: AuthUser,
  ) {
    const texto = detalle?.trim();
    if (!texto) throw new BadRequestException('El detalle del faltante es obligatorio');
    await this.prisma.$transaction(async (tx) => {
      await this.exigirPaso(tx, ticketId);
      const h = await tx.ticketHerramienta.findFirst({ where: { id: herramientaId, ticketId } });
      if (!h) throw new NotFoundException('La herramienta no existe en este ticket');
      if (!h.recibidaAt)
        throw new ConflictException('La herramienta nunca fue recibida: no puede faltar');
      if (h.devueltaAt || h.faltanteAt)
        throw new ConflictException('La herramienta ya tiene su retorno');
      await tx.ticketHerramienta.update({
        where: { id: herramientaId },
        data: {
          faltanteAt: new Date(),
          faltantePor: actor.id,
          faltanteCausa: causa,
          faltanteMotivo: texto,
          updatedBy: actor.id,
        },
      });
      await tx.ticketHerramientaEvento.create({
        data: {
          id: uuidv7(),
          herramientaId,
          tipo: 'faltante',
          detalle: `${causa}: ${texto}`,
          actorId: actor.id,
        },
      });
      await this.requisitos.sincronizarDeHerramientas(tx, ticketId, actor.id);
    });
    return this.herramientas.detalle(ticketId);
  }

  private async exigirPaso(tx: Prisma.TransactionClient, ticketId: string): Promise<void> {
    const t = await this.tickets.cargarEnTx(tx, ticketId);
    if (t.pasoCodigo !== PASO) {
      throw new ConflictException(
        'El retorno de las herramientas se registra en el «Control de retorno»',
      );
    }
  }
}
