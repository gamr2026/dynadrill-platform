import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { currentTraceparent } from '@dyn/common';
import { EventBus } from '@dyn/messaging';
import { Prisma } from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';
import { nombreDe } from './tickets.service';
import { etiquetaDeUnidad, UNIDAD_CON_PLACA } from './unidad-etiqueta';

/** Cuántos requisitos vencidos se marcan por revisión; si hay más, siguen en la revisión siguiente. */
const LIMITE = 200;
/** Roles responsables que nunca forman parte del equipo del ticket (p. ej. QHSE): se avisa por `rolResponsable`, no al equipo. */
const ROLES_FUERA_DEL_EQUIPO: ReadonlySet<string> = new Set(['gerente_hse']);
const aFecha = (d: Date) => d.toISOString().slice(0, 10);
const dmy = (f: string) => `${f.slice(8, 10)}/${f.slice(5, 7)}/${f.slice(0, 4)}`;

export interface ResumenRequisitosVencidos {
  /** Requisitos marcados como vencidos (y avisados) en esta revisión. */
  vencidos: number;
}

/**
 * Detección de requisitos vencidos. Un requisito pendiente cuya fecha de vencimiento (`vence_at`) ya pasó se marca con `vencido_at` y se publica
 * `operaciones.pumping.requisito_vencido`, una sola vez por requisito: la marca y el evento van en la misma transacción, y solo se marcan los que
 * todavía no tienen `vencido_at`. Esa marca se conserva cuando el requisito se cumple después (queda como «cumplido tarde»). No se revisan los
 * requisitos de un día cuya jornada ya no se exige (sin operación, no aplica o cerrada).
 */
@Injectable()
export class RequisitosVencidosService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(RequisitosVencidosService.name);
  private readonly intervaloMin: number;
  private timer?: NodeJS.Timeout;
  private enCurso = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: EventBus,
    cfg: ConfigService,
  ) {
    // 0 apaga la revisión (en pruebas está apagada por defecto); sin valor, cada 15 minutos
    const configurado = cfg.get('PUMPING_REQUISITOS_VENCIDOS_MINUTES');
    this.intervaloMin =
      configurado !== undefined && configurado !== ''
        ? Number(configurado)
        : process.env['NODE_ENV'] === 'test'
          ? 0
          : 15;
  }

  onApplicationBootstrap(): void {
    if (!(this.intervaloMin > 0)) return;
    this.timer = setInterval(() => {
      this.emitir().catch((e: Error) =>
        this.logger.warn(`La revisión de requisitos vencidos falló: ${e.message}`),
      );
    }, this.intervaloMin * 60_000);
    this.timer.unref();
    this.logger.log(`Revisión de requisitos vencidos cada ${this.intervaloMin} min`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * Marca y avisa los requisitos pendientes vencidos antes de `ahora` (solo se cambia en pruebas).
   * `tickets`: limita la revisión a esos tickets (pruebas); sin valor, revisa todos.
   */
  async emitir(
    ahora: Date = new Date(),
    tickets?: readonly string[],
  ): Promise<ResumenRequisitosVencidos> {
    if (this.enCurso) return { vencidos: 0 };
    this.enCurso = true;
    try {
      const filtroTickets = tickets
        ? Prisma.sql`AND r."ticket_id" = ANY(${[...tickets]}::uuid[])`
        : Prisma.empty;
      // lo vencido de un ticket anulado, o de un día cuya jornada ya no se exige (sin operación, no aplica, cerrada), no se avisa
      const candidatos = await this.prisma.$queryRaw<Array<{ id: string }>>`
        SELECT r."id"
          FROM "pumping"."ticket_requisito" r
         WHERE r."estado" = 'pendiente' AND r."vencido_at" IS NULL AND r."vence_at" < ${ahora}
           AND NOT EXISTS (SELECT 1 FROM "pumping"."ticket" t WHERE t."id" = r."ticket_id" AND t."paso_codigo" = 'anulado')
           AND (r."fecha" IS NULL OR EXISTS (
                 SELECT 1 FROM "pumping"."ticket_jornada" j
                  WHERE j."ticket_id" = r."ticket_id" AND j."fecha" = r."fecha" AND j."estado" IN ('pendiente', 'abierta')))
           ${filtroTickets}
         ORDER BY r."vence_at", r."id"
         LIMIT ${LIMITE}`;
      let vencidos = 0;
      for (const { id } of candidatos) {
        try {
          if (await this.marcar(id, ahora)) vencidos++;
        } catch (e) {
          this.logger.warn(
            `No se pudo marcar el requisito ${id} como vencido: ${(e as Error).message}`,
          );
        }
      }
      if (vencidos) this.logger.log(`Requisitos vencidos avisados: ${vencidos}`);
      return { vencidos };
    } finally {
      this.enCurso = false;
    }
  }

  /** Marca un requisito como vencido y publica el aviso en la misma transacción; falso si otra revisión (o el cumplimiento) se le adelantó. */
  private async marcar(id: string, ahora: Date): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const marcado = await tx.ticketRequisito.updateMany({
        where: { id, estado: 'pendiente', vencidoAt: null },
        data: { vencidoAt: ahora },
      });
      if (marcado.count === 0) return false;
      const f = await tx.ticketRequisito.findUniqueOrThrow({
        where: { id },
        include: { requisito: true, unidad: UNIDAD_CON_PLACA, usuario: true },
      });
      const t = await tx.ticket.findUniqueOrThrow({
        where: { id: f.ticketId },
        include: { cliente: true, pozo: true, personas: true },
      });
      const jornada = f.fecha
        ? await tx.ticketJornada.findUnique({
            where: { ticketId_fecha: { ticketId: f.ticketId, fecha: f.fecha } },
            select: { numero: true },
          })
        : null;
      // a quien le toca cumplirlo: si el rol es ajeno al equipo (QHSE), `asignados` va vacío y se avisa por `rolResponsable`;
      // si el catálogo no lo dice (o nadie tiene ese papel en el ticket), al equipo del ticket
      const rol = f.requisito.rolResponsable;
      const delRol = rol ? t.personas.filter((p) => p.rol === rol) : [];
      const equipo = t.personas.filter((p) => p.rol === 'supervisor' || p.rol === 'operador');
      const asignados = (
        rol && ROLES_FUERA_DEL_EQUIPO.has(rol) ? [] : delRol.length ? delRol : equipo
      ).map((p) => ({ usuarioId: p.usuarioId, rolCodigo: p.rol }));
      const fecha = f.fecha ? aFecha(f.fecha) : null;
      await this.bus.publish(
        tx,
        this.bus.create({
          type: 'operaciones.pumping.requisito_vencido',
          subject: { type: 'pumping_ticket', id: f.ticketId },
          data: {
            ticketId: f.ticketId,
            ticketNumero: t.ticketNumero,
            pedidoId: t.pedidoId,
            pedidoCodigo: t.pedidoCodigo,
            cliente: nombreDe(t.cliente),
            pozo: t.pozo?.nombreCompleto ?? null,
            requisitoId: f.id,
            requisitoCodigo: f.requisitoCodigo,
            requisito: f.requisito.nombre,
            para: (f.unidad ? etiquetaDeUnidad(f.unidad) : null) ?? f.usuario?.nombre ?? null,
            fecha,
            dia: fecha ? dmy(fecha) : null,
            numero: jornada?.numero ?? null,
            venceAt: f.venceAt?.toISOString() ?? null,
            vencidoAt: ahora.toISOString(),
            rolResponsable: f.requisito.rolResponsable,
            asignados,
          },
          traceparent: currentTraceparent(),
        }),
      );
      return true;
    });
  }
}
