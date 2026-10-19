import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AuthUser } from '@dyn/common';
import { MovimientosService, type LineaDeTicket } from '@dyn/inventario';
import { PrismaService } from '../prisma/prisma.service';
import { puedeActuar, puedeActuarEn } from './tickets.service';

const PASO_EJECUCION = 'ejecucion_operativa';
const PASO_RETORNO = 'control_retorno';

/**
 * Químicos de un ticket después de la asignación (que los saca de bodega): el Operador registra lo usado en la ejecución y el
 * Supervisor devuelve a bodega lo que sobró en el control de retorno. Todo el movimiento vive en Inventario (kardex y consumo):
 * Pumping no guarda cantidades, las pide con el balance del ticket.
 */
@Injectable()
export class QuimicosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventario: MovimientosService,
  ) {}

  /** Lo asignado, usado, devuelto y pendiente de cada químico, y los documentos del ticket (mezcla). */
  async detalle(ticketId: string) {
    const t = await this.prisma.ticket.findUnique({
      where: { id: ticketId },
      select: { id: true, documentos: { orderBy: { createdAt: 'asc' } } },
    });
    if (!t) throw new NotFoundException('El ticket no existe');
    return {
      quimicos: await this.inventario.quimicosDeTicket(ticketId),
      documentos: t.documentos.map((d) => ({
        id: d.id,
        tipo: d.tipo,
        archivoId: d.archivoId,
        createdAt: d.createdAt,
      })),
    };
  }

  /** El Operador registra cuánto usó de un químico (no mueve stock; no puede superar lo que el ticket tiene a su cargo). */
  async consumir(ticketId: string, articuloId: string, cantidad: number, actor: AuthUser) {
    await this.exigirPaso(
      ticketId,
      PASO_EJECUCION,
      actor,
      'El consumo se registra en la Ejecución operativa',
    );
    await this.inventario.registrarConsumoDeTicket(ticketId, articuloId, cantidad, actor);
    return this.detalle(ticketId);
  }

  /** El Supervisor devuelve a bodega lo que sobró (no puede devolver más de lo que sigue a cargo del ticket). */
  async devolver(ticketId: string, lineas: LineaDeTicket[], actor: AuthUser) {
    await this.exigirPaso(
      ticketId,
      PASO_RETORNO,
      actor,
      'Las devoluciones se registran en el Control de retorno',
    );
    await this.inventario.devolverDeTicket(
      ticketId,
      lineas,
      actor,
      'Devolución en el control de retorno',
    );
    return this.detalle(ticketId);
  }

  /** El ticket está en el paso que corresponde, y quien actúa es del rol del paso y del equipo asignado. */
  private async exigirPaso(
    ticketId: string,
    paso: string,
    actor: AuthUser,
    mensajeSiOtroPaso: string,
  ) {
    const t = await this.prisma.ticket.findUnique({
      where: { id: ticketId },
      select: {
        pasoCodigo: true,
        paso: { select: { nombre: true, roles: true } },
        personas: { select: { usuarioId: true } },
      },
    });
    if (!t) throw new NotFoundException('El ticket no existe');
    if (t.pasoCodigo !== paso) throw new ConflictException(mensajeSiOtroPaso);
    if (!puedeActuar(t.paso.roles, actor.roleCode)) {
      throw new ForbiddenException(`El paso "${t.paso.nombre}" lo atiende otro rol`);
    }
    if (!puedeActuarEn(t, actor)) {
      throw new ForbiddenException('Solo el equipo asignado a este ticket puede hacerlo');
    }
  }
}
