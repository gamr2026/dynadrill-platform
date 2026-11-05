import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AuthUser } from '@dyn/common';
import { aFecha, hoyEcuador } from '../comun/fechas';
import { PrismaService } from '../prisma/prisma.service';
import { codigoPtw } from './ptw-documentos';
import { PtwService } from './ptw.service';

export interface ResumenAperturaPtw {
  /** PTW abiertos en esta revisión. */
  abiertos: number;
  /** Días que ya tenían PTW (vigente o anulado): no se tocan. */
  yaTenian: number;
  /** Días que no se pudieron abrir (nadie a cuyo nombre abrirlos, o falló). */
  sinAbrir: number;
}

/**
 * Apertura diaria del PTW. Pumping avisa qué días tiene activos cada ticket (`ticket_dia_servicio`); en cuanto empieza el día esta tarea abre el
 * PTW de ese día (nace en gabinete) para que QHSE lo vea con tiempo, sin esperar a que alguien lo abra a mano. Corre cada pocos minutos (y al
 * arrancar, por si el servicio estuvo apagado a medianoche); abrirlo dos veces es imposible (hay un único PTW vigente por pedido y día).
 *
 * Reglas:
 *  - Un día que ya tiene PTW, aunque esté anulado, no se vuelve a abrir: si QHSE lo anuló lo decidió una persona y quien quiera uno nuevo lo abre a mano.
 *  - El PTW se abre a nombre de quien abrió el último PTW del ticket y, si no hay, del supervisor asignado; sin ninguno de los dos no se abre y queda
 *    en el registro (QHSE lo abre a mano).
 */
@Injectable()
export class PtwProgramadoService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(PtwProgramadoService.name);
  private readonly intervaloMin: number;
  private timer?: NodeJS.Timeout;
  private enCurso = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly ptw: PtwService,
    cfg: ConfigService,
  ) {
    // 0 apaga la tarea (en pruebas está apagada por defecto); sin valor, cada 10 minutos
    const configurado = cfg.get('QHSE_PTW_AUTOMATICO_MINUTES');
    this.intervaloMin =
      configurado !== undefined && configurado !== ''
        ? Number(configurado)
        : process.env['NODE_ENV'] === 'test'
          ? 0
          : 10;
  }

  onApplicationBootstrap(): void {
    if (!(this.intervaloMin > 0)) return;
    const correr = () =>
      this.abrirDelDia().catch((e: Error) =>
        this.logger.warn(`La apertura diaria de PTW falló: ${e.message}`),
      );
    this.timer = setInterval(correr, this.intervaloMin * 60_000);
    this.timer.unref();
    void correr(); // por si el servicio estuvo apagado a medianoche
    this.logger.log(`Apertura diaria de PTW cada ${this.intervaloMin} min`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Abre el PTW de `hoy` (AAAA-MM-DD; solo se cambia en pruebas) de cada ticket que tiene servicio ese día y todavía no tiene PTW. */
  async abrirDelDia(hoy: string = hoyEcuador()): Promise<ResumenAperturaPtw> {
    const resumen: ResumenAperturaPtw = { abiertos: 0, yaTenian: 0, sinAbrir: 0 };
    if (this.enCurso) return resumen;
    this.enCurso = true;
    try {
      const dias = await this.prisma.ticketDiaServicio.findMany({
        where: { fecha: aFecha(hoy) },
        select: {
          ticketId: true,
          ticket: { select: { pedidoId: true, supervisorId: true, ticketNumero: true } },
        },
      });
      for (const d of dias) {
        const ya = await this.prisma.ptw.count({
          where: { pedidoId: d.ticket.pedidoId, diaOperacion: aFecha(hoy) },
        });
        if (ya > 0) {
          resumen.yaTenian++;
          continue;
        }
        const actor = await this.quienAbre(d.ticketId, d.ticket.supervisorId);
        const nombre = `ticket ${d.ticket.ticketNumero ?? d.ticketId}`;
        if (!actor) {
          this.logger.warn(
            `${nombre}: no hay a nombre de quién abrir el PTW del ${hoy}; QHSE lo abre a mano`,
          );
          resumen.sinAbrir++;
          continue;
        }
        try {
          const id = await this.prisma.$transaction((tx) =>
            this.ptw.abrirDelDia(tx, d.ticketId, hoy, actor),
          );
          if (id) {
            resumen.abiertos++;
            const p = await this.prisma.ptw.findUniqueOrThrow({
              where: { id },
              select: { numero: true },
            });
            this.logger.log(`${nombre}: PTW ${codigoPtw(p.numero)} del ${hoy} abierto`);
          } else resumen.yaTenian++; // lo abrió otra instancia mientras tanto
        } catch (e) {
          this.logger.warn(
            `${nombre}: no se pudo abrir el PTW del ${hoy}: ${(e as Error).message}`,
          );
          resumen.sinAbrir++;
        }
      }
      return resumen;
    } finally {
      this.enCurso = false;
    }
  }

  /** A nombre de quien abrió el último PTW del ticket (si su cuenta sigue activa) o, si no, del supervisor asignado. */
  private async quienAbre(
    ticketId: string,
    supervisorId: string | null,
  ): Promise<Pick<AuthUser, 'id' | 'roleCode'> | null> {
    const ultimo = await this.prisma.ptw.findFirst({
      where: { ticketId },
      orderBy: { createdAt: 'desc' },
      select: { createdBy: true },
    });
    for (const id of [ultimo?.createdBy, supervisorId]) {
      if (!id) continue;
      const u = await this.prisma.idUsuario.findFirst({
        where: { id, activo: true },
        select: { id: true },
      });
      if (u) return { id: u.id, roleCode: 'sistema' as AuthUser['roleCode'] };
    }
    return null;
  }
}
