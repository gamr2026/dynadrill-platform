import { CanActivate, ConflictException, ExecutionContext, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/** Código del paso terminal al que pasa el ticket cuando se anula su pedido. */
export const PASO_ANULADO = 'anulado';

/** El 409 de toda acción de escritura sobre un ticket anulado. */
export const ticketAnulado = () =>
  new ConflictException({
    message: 'El ticket está anulado (su pedido se anuló): ya no admite cambios',
    code: 'TICKET_ANULADO',
  });

const METODOS_DE_LECTURA = ['GET', 'HEAD', 'OPTIONS'];
/** Las rutas de un ticket: `/operaciones/pumping/tickets/:id/...` (la guardia no mira las que usan `:id` para otra cosa, como `cambios-items/:id`). */
const RUTA_DE_TICKET =
  /\/operaciones\/pumping\/tickets\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[/?]|$)/i;

/**
 * Un ticket anulado (su pedido se anuló en Comercial) no admite ninguna acción de escritura: 409 `TICKET_ANULADO`. Es el único lugar donde se
 * comprueba, para todas las rutas de `tickets/:id/...` de los controladores de Pumping (se aplica con `@UseGuards` en cada uno), en vez de
 * repetirlo en cada servicio. Las lecturas siguen abiertas: el ticket anulado se puede consultar. Corre después de la autenticación y los
 * permisos (guardias globales), así que quien no tiene permiso no se entera del estado del ticket.
 */
@Injectable()
export class TicketNoAnuladoGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context
      .switchToHttp()
      .getRequest<{ method: string; originalUrl?: string; url: string }>();
    if (METODOS_DE_LECTURA.includes(req.method.toUpperCase())) return true;
    const id = RUTA_DE_TICKET.exec(req.originalUrl ?? req.url)?.[1];
    if (!id) return true;
    const t = await this.prisma.ticket.findUnique({ where: { id }, select: { pasoCodigo: true } });
    if (t?.pasoCodigo === PASO_ANULADO) throw ticketAnulado();
    return true;
  }
}
