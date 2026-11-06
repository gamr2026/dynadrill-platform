import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { currentTraceparent } from '@dyn/common';
import { EventBus } from '@dyn/messaging';
import { PrismaService } from '../prisma/prisma.service';
import { JornadasService } from './jornadas.service';
import { nombreDe } from './tickets.service';

const PASO = 'ejecucion_operativa';
const aFecha = (d: Date) => d.toISOString().slice(0, 10);
const dmy = (f: string) => `${f.slice(8, 10)}/${f.slice(5, 7)}/${f.slice(0, 4)}`;

export interface ResumenAvisosJornada {
  /** Avisos publicados en esta revisión (uno por ticket y día). */
  avisados: number;
}

/**
 * Aviso «Jornada sin cerrar». Pasa el día y la jornada sigue pendiente o abierta: nadie la va a cerrar sola y, mientras tanto, el ticket no puede salir
 * de la Ejecución operativa. Esta revisión (cada cierto tiempo) publica `operaciones.pumping.jornada_sin_cerrar` una sola vez por ticket y día, para
 * el Supervisor y los Operadores del ticket (la tabla `ticket_aviso_jornada` recuerda de cuáles ya avisó). El mismo hecho aparece todo el tiempo en
 * «Mis tareas de hoy» hasta que la jornada se cierra, se registra sin operación o deja de aplicar.
 */
@Injectable()
export class JornadasAvisosService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(JornadasAvisosService.name);
  private readonly intervaloMin: number;
  private timer?: NodeJS.Timeout;
  private enCurso = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: EventBus,
    private readonly jornadas: JornadasService,
    cfg: ConfigService,
  ) {
    // 0 apaga la revisión (en pruebas está apagada por defecto); sin valor, cada 30 minutos
    const configurado = cfg.get('PUMPING_AVISOS_JORNADA_MINUTES');
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
        this.logger.warn(`La revisión de jornadas sin cerrar falló: ${e.message}`),
      );
    }, this.intervaloMin * 60_000);
    this.timer.unref();
    this.logger.log(`Revisión de jornadas sin cerrar cada ${this.intervaloMin} min`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Avisa las jornadas de días anteriores a `hoy` (AAAA-MM-DD; solo se cambia en pruebas) que siguen sin cerrar y de las que todavía no se avisó. */
  async emitir(
    hoy: string = this.jornadas.hoy(),
    /** Limita la revisión a esos tickets (pruebas); sin valor, revisa todos los que están en ejecución. */
    tickets?: readonly string[],
  ): Promise<ResumenAvisosJornada> {
    if (this.enCurso) return { avisados: 0 };
    this.enCurso = true;
    try {
      const enEjecucion = await this.prisma.ticket.findMany({
        where: {
          pasoCodigo: PASO,
          fechaInicioServicio: { not: null },
          fechaFinServicio: { not: null },
          ...(tickets ? { id: { in: [...tickets] } } : {}),
        },
        select: { id: true },
        take: 500,
      });
      let avisados = 0;
      for (const { id } of enEjecucion) {
        // las jornadas existen aunque nadie haya abierto la pantalla del ticket
        await this.prisma.$transaction((tx) => this.jornadas.generar(tx, id));
        avisados += await this.avisarTicket(id, hoy);
      }
      if (avisados) this.logger.log(`Jornadas sin cerrar avisadas: ${avisados}`);
      return { avisados };
    } finally {
      this.enCurso = false;
    }
  }

  private async avisarTicket(ticketId: string, hoy: string): Promise<number> {
    const pasadas = await this.prisma.ticketJornada.findMany({
      where: {
        ticketId,
        fecha: { lt: new Date(`${hoy}T00:00:00Z`) },
        estado: { in: ['pendiente', 'abierta'] },
      },
      orderBy: { fecha: 'asc' },
      select: { fecha: true, numero: true },
    });
    let n = 0;
    for (const j of pasadas) {
      const hecho = await this.prisma.$transaction(async (tx) => {
        // un aviso por ticket y día: si otra revisión ya lo registró, no se repite
        const nuevo = await tx.ticketAvisoJornada.createMany({
          data: [{ ticketId, fecha: j.fecha }],
          skipDuplicates: true,
        });
        if (nuevo.count === 0) return false;
        const t = await tx.ticket.findUniqueOrThrow({
          where: { id: ticketId },
          include: { cliente: true, pozo: true, personas: true },
        });
        const faltan = await tx.ticketRequisito.findMany({
          where: { ticketId, fecha: j.fecha, estado: 'pendiente' },
          select: { requisito: { select: { nombre: true } } },
        });
        const nombres = [...new Set(faltan.map((f) => f.requisito.nombre))];
        const destinatarios = t.personas
          .filter((p) => p.rol === 'supervisor' || p.rol === 'operador')
          .map((p) => ({ usuarioId: p.usuarioId, rolCodigo: p.rol }));
        const fecha = aFecha(j.fecha);
        await this.bus.publish(
          tx,
          this.bus.create({
            type: 'operaciones.pumping.jornada_sin_cerrar',
            subject: { type: 'pumping_ticket', id: ticketId },
            data: {
              ticketId,
              ticketNumero: t.ticketNumero,
              pedidoId: t.pedidoId,
              pedidoCodigo: t.pedidoCodigo,
              cliente: nombreDe(t.cliente),
              pozo: t.pozo?.nombreCompleto ?? null,
              fecha,
              dia: dmy(fecha),
              numero: j.numero,
              faltan: nombres.length ? nombres.join('; ') : 'ya está lista para cerrar',
              asignados: destinatarios,
            },
            traceparent: currentTraceparent(),
          }),
        );
        return true;
      });
      if (hecho) n++;
    }
    return n;
  }
}
