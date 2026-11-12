import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { currentTraceparent } from '@dyn/common';
import { EventBus } from '@dyn/messaging';
import { PrismaService } from '../prisma/prisma.service';
import { BitacoraService } from './bitacora.service';
import { hoyEcuador, inicioDelDia, sumarDias } from './dias-servicio';
import { nombreDe } from './tickets.service';
import { REQ } from '../catalog/sembrar-pasos';

const PASO = 'ejecucion_operativa';
const LIMITE = 500;
/** Roles responsables que nunca forman parte del equipo del ticket (p. ej. QHSE): se avisa por `rolResponsable`, no al equipo. */
const ROLES_FUERA_DEL_EQUIPO: ReadonlySet<string> = new Set(['gerente_hse']);

export interface ResumenRevisionRequisitos {
  /** Tickets en ejecución cuyo requisito de bitácora se recalculó. */
  revisados: number;
  /** Requisitos marcados vencidos en esta revisión (uno por requisito: se publicó un evento por cada uno). */
  vencidos: number;
}

/**
 * Revisión periódica de requisitos. Pasa el tiempo y nadie toca el ticket: el requisito de la bitácora podía seguir «cumplido» con días sin
 * enviar, y un requisito con plazo se pasaba de fecha sin que nadie se enterara. Cada cierto tiempo esta revisión
 *  1. recalcula `bitacora_enviada` de los tickets en ejecución contra los días vencidos (hasta ayer, Ecuador), reabriéndolo si falta alguno;
 *  2. marca vencidos (`vencido_at`) los requisitos pendientes cuyo `vence_at` ya pasó y publica `operaciones.fcr.requisito_vencido`, una sola vez
 *     por requisito (la marca y el evento van en la misma transacción y la marca solo se escribe si todavía no estaba).
 * Un ticket cerrado o anulado ya no se revisa. Un requisito exonerado no se toca.
 */
@Injectable()
export class RequisitosRevisionService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(RequisitosRevisionService.name);
  private readonly intervaloMin: number;
  private timer?: NodeJS.Timeout;
  private enCurso = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: EventBus,
    private readonly bitacora: BitacoraService,
    cfg: ConfigService,
  ) {
    // 0 apaga la revisión (en pruebas está apagada por defecto); sin valor, cada 30 minutos
    const configurado = cfg.get('FCR_REVISION_REQUISITOS_MINUTES');
    this.intervaloMin =
      configurado !== undefined && configurado !== ''
        ? Number(configurado)
        : process.env['NODE_ENV'] === 'test'
          ? 0
          : 30;
  }

  onApplicationBootstrap(): void {
    if (!(this.intervaloMin > 0)) return;
    this.timer = setInterval(() => {
      this.emitir().catch((e: Error) =>
        this.logger.warn(`La revisión de requisitos falló: ${e.message}`),
      );
    }, this.intervaloMin * 60_000);
    this.timer.unref();
    this.logger.log(`Revisión de requisitos cada ${this.intervaloMin} min`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * Corre la revisión. `hoy` (AAAA-MM-DD, Ecuador; solo se cambia en pruebas) fija el día de «hoy»: el instante de referencia es el inicio de ese día.
   * `tickets`: limita la revisión a esos tickets (pruebas); sin valor revisa todos.
   */
  async emitir(hoy?: string, tickets?: readonly string[]): Promise<ResumenRevisionRequisitos> {
    if (this.enCurso) return { revisados: 0, vencidos: 0 };
    this.enCurso = true;
    try {
      const dia = hoy ?? hoyEcuador();
      const ahora = hoy ? inicioDelDia(hoy) : new Date();
      const filtro = tickets ? { id: { in: [...tickets] } } : {};

      const enEjecucion = await this.prisma.ticket.findMany({
        where: {
          pasoCodigo: PASO,
          fechaInicioServicio: { not: null },
          fechaFinServicio: { not: null },
          ...filtro,
        },
        select: { id: true },
        take: LIMITE,
      });
      for (const { id } of enEjecucion) {
        await this.prisma.$transaction((tx) =>
          this.bitacora.recalcularRequisito(tx, id, null, dia),
        );
      }

      const porVencer = await this.prisma.ticketRequisito.findMany({
        where: {
          estado: 'pendiente',
          vencidoAt: null,
          venceAt: { lte: ahora },
          ticket: { paso: { terminal: false }, ...filtro },
        },
        select: { id: true },
        orderBy: { venceAt: 'asc' },
        take: LIMITE,
      });
      let vencidos = 0;
      for (const { id } of porVencer) {
        if (await this.vencer(id, ahora, dia)) vencidos++;
      }
      if (vencidos) this.logger.log(`Requisitos vencidos: ${vencidos}`);
      return { revisados: enEjecucion.length, vencidos };
    } finally {
      this.enCurso = false;
    }
  }

  /** Marca vencido un requisito y publica el evento, en una sola transacción. `false` si otra revisión (o un cumplimiento) se le adelantó. */
  private async vencer(id: string, ahora: Date, hoy: string): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const marca = await tx.ticketRequisito.updateMany({
        where: { id, estado: 'pendiente', vencidoAt: null, venceAt: { lte: ahora } },
        data: { vencidoAt: ahora },
      });
      if (marca.count === 0) return false;
      const r = await tx.ticketRequisito.findUniqueOrThrow({
        where: { id },
        include: {
          requisito: true,
          usuario: { select: { nombre: true } },
          ticket: { include: { cliente: true, pozo: true, personas: true } },
        },
      });
      const t = r.ticket;
      const dias =
        r.requisitoCodigo === REQ.bitacoraEnviada
          ? await this.bitacora.diasFaltantes(tx, t.id, sumarDias(hoy, -1))
          : [];
      await this.bus.publish(
        tx,
        this.bus.create({
          type: 'operaciones.fcr.requisito_vencido',
          subject: { type: 'fcr_ticket', id: t.id },
          data: {
            ticketId: t.id,
            ticketNumero: t.ticketNumero,
            pedidoId: t.pedidoId,
            pedidoCodigo: t.pedidoCodigo,
            cliente: nombreDe(t.cliente),
            pozo: t.pozo?.nombreCompleto ?? null,
            paso: t.pasoCodigo,
            requisitoId: r.id,
            requisitoCodigo: r.requisitoCodigo,
            requisitoNombre: r.requisito.nombre,
            para: r.usuario?.nombre ?? null,
            venceAt: r.venceAt?.toISOString() ?? null,
            diasFaltantes: dias,
            rolResponsable: r.requisito.rolResponsable,
            responsableId: t.responsableId,
            // un responsable ajeno al equipo del ticket (QHSE) se avisa por `rolResponsable`: sin equipo de respaldo
            asignados: (r.requisito.rolResponsable &&
            ROLES_FUERA_DEL_EQUIPO.has(r.requisito.rolResponsable)
              ? []
              : t.personas.filter((p) => p.rol === 'supervisor' || p.rol === 'operador')
            ).map((p) => ({ usuarioId: p.usuarioId, rolCodigo: p.rol })),
          },
          traceparent: currentTraceparent(),
        }),
      );
      return true;
    });
  }
}
