import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AuthUser } from '@dyn/common';
import { REQ } from '../catalog/sembrar-pasos';
import type { Prisma } from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';
import { BitacoraService } from './bitacora.service';
import { RequisitosService } from './requisitos.service';
import { ROLES_SUPERVISAN, TicketsService } from './tickets.service';

/** Requisitos que se calculan a partir de las herramientas: al revertir la exoneración se vuelven a evaluar contra lo que hay. */
const DE_HERRAMIENTAS: string[] = [
  REQ.herramientasRecibidas,
  REQ.herramientasDevueltas,
  REQ.inspeccionesEnviadas,
];

/**
 * Exoneración de requisitos: el Supervisor (o quien coordina) dispensa con motivo un requisito pendiente para que no bloquee la salida del paso.
 * Un exonerado no lo reabre ni lo cumple ningún recálculo o evento tardío; solo se revierte desde aquí (vuelve a pendiente y, si se puede, se
 * vuelve a evaluar). Todo cambio queda en el historial del requisito, que escribe la base de datos.
 */
@Injectable()
export class ExoneracionesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tickets: TicketsService,
    private readonly requisitos: RequisitosService,
    private readonly bitacora: BitacoraService,
  ) {}

  async exonerar(ticketId: string, requisitoId: string, motivo: string, actor: AuthUser) {
    this.exigirSupervisa(actor);
    const texto = motivo?.trim();
    if (!texto) throw new BadRequestException('El motivo es obligatorio');
    await this.prisma.$transaction(async (tx) => {
      await this.exigirAbierto(tx, ticketId);
      const fila = await this.fila(tx, ticketId, requisitoId);
      if (fila.estado !== 'pendiente') {
        throw new ConflictException({
          message:
            fila.estado === 'exonerado'
              ? 'El requisito ya está exonerado'
              : 'Solo se puede exonerar un requisito pendiente: este ya está cumplido',
          code: 'REQUISITO_NO_PENDIENTE',
        });
      }
      const r = await tx.ticketRequisito.updateMany({
        where: { id: requisitoId, estado: 'pendiente' },
        data: {
          estado: 'exonerado',
          exoneradoAt: new Date(),
          exoneradoPor: actor.id,
          motivo: texto,
        },
      });
      if (r.count === 0) throw this.cambio();
    });
    return this.vista(ticketId, requisitoId);
  }

  /** Deshace la exoneración: el requisito vuelve a pendiente (o a cumplido si lo que lo cumple ya está en regla). El motivo es opcional. */
  async revertir(
    ticketId: string,
    requisitoId: string,
    motivo: string | undefined,
    actor: AuthUser,
  ) {
    this.exigirSupervisa(actor);
    await this.prisma.$transaction(async (tx) => {
      await this.exigirAbierto(tx, ticketId);
      const fila = await this.fila(tx, ticketId, requisitoId);
      if (fila.estado !== 'exonerado') {
        throw new ConflictException({
          message: 'El requisito no está exonerado',
          code: 'REQUISITO_NO_EXONERADO',
        });
      }
      // el trigger del historial toma de aquí quién revirtió (la fila ya no guarda al exonerador)
      await tx.$queryRaw`SELECT set_config('fcr.actor_id', ${actor.id}, true)`;
      const r = await tx.ticketRequisito.updateMany({
        where: { id: requisitoId, estado: 'exonerado' },
        data: {
          estado: 'pendiente',
          exoneradoAt: null,
          exoneradoPor: null,
          motivo: motivo?.trim() || 'Exoneración revertida',
        },
      });
      if (r.count === 0) throw this.cambio();
      // un requisito que depende de datos del ticket se vuelve a evaluar contra lo que hay (podría estar cumplido ya)
      if (fila.requisitoCodigo === REQ.bitacoraEnviada)
        await this.bitacora.recalcularRequisito(tx, ticketId, actor.id);
      else if (DE_HERRAMIENTAS.includes(fila.requisitoCodigo))
        await this.requisitos.sincronizarDeHerramientas(tx, ticketId, actor.id);
    });
    return this.vista(ticketId, requisitoId);
  }

  /** Historia del requisito, de la más antigua a la más reciente. */
  async historial(ticketId: string, requisitoId: string) {
    const fila = await this.fila(this.prisma, ticketId, requisitoId);
    const filas = await this.prisma.ticketRequisitoHistorial.findMany({
      where: { ticketRequisitoId: requisitoId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    // `actor_id` es una FK solo de la base de datos: los nombres se buscan aparte
    const ids = [...new Set(filas.flatMap((f) => (f.actorId ? [f.actorId] : [])))];
    const nombres = new Map(
      (ids.length
        ? await this.prisma.idUsuario.findMany({
            where: { id: { in: ids } },
            select: { id: true, nombre: true },
          })
        : []
      ).map((u) => [u.id, u.nombre]),
    );
    return {
      requisitoId,
      codigo: fila.requisitoCodigo,
      historial: filas.map((f) => ({
        estadoAnterior: f.estadoAnterior,
        estadoNuevo: f.estadoNuevo,
        vencido: f.vencido,
        origen: f.origen,
        actor: f.actorId ? { id: f.actorId, nombre: nombres.get(f.actorId) ?? null } : null,
        motivo: f.motivo,
        at: f.createdAt,
      })),
    };
  }

  // ── piezas internas ─────────────────────────────────────────────────────────────────────────

  private exigirSupervisa(actor: AuthUser): void {
    if (!(ROLES_SUPERVISAN as readonly string[]).includes(actor.roleCode)) {
      throw new ForbiddenException('Solo el Supervisor o quien coordina puede exonerar requisitos');
    }
  }

  /** El ticket existe, no está anulado (lo valida la carga) ni cerrado. */
  private async exigirAbierto(tx: Prisma.TransactionClient, ticketId: string): Promise<void> {
    const t = await this.tickets.cargarEnTx(tx, ticketId);
    if (t.paso.terminal)
      throw new ConflictException('El ticket está cerrado: solo se puede consultar');
  }

  private async fila(
    db: Prisma.TransactionClient | PrismaService,
    ticketId: string,
    requisitoId: string,
  ) {
    const f = await db.ticketRequisito.findFirst({ where: { id: requisitoId, ticketId } });
    if (!f) throw new NotFoundException('El requisito no existe en este ticket');
    return f;
  }

  private cambio(): ConflictException {
    return new ConflictException('El requisito cambió de estado; vuelva a intentarlo');
  }

  private async vista(ticketId: string, requisitoId: string) {
    return (await this.requisitos.estado(ticketId)).find((r) => r.id === requisitoId);
  }
}
