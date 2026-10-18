import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { runInEventSpan, type AuthUser } from '@dyn/common';
import { EventBus, type EventEnvelope } from '@dyn/messaging';
import type { RecibirDocumentoOperativoDto } from '../dto/documentos-operativos.dto';
import { PrismaService } from '../prisma/prisma.service';
import { DocumentosOperativosService } from '../services/documentos-operativos.service';

export const EVENTO_REPORTE_DIARIO = 'operaciones.pumping.reporte_diario_completado';

/**
 * El Reporte Diario (Reporte Job) de un día que el operador de Pumping completa llega al pedido como documento operativo
 * (contrato 4.4, ahora por evento). Reemplaza el documento de la misma clave (pedido, tipo, origen, fecha), así que reenviar un día
 * que se reabrió y se volvió a completar no duplica. Si Facturación ya corrigió ese día, o el pedido está en una etapa que ya no
 * recibe documentos, se omite sin fallar: el ticket no depende de Facturación. Idempotente por el inbox; un error que no sea de
 * negocio (por ejemplo, la base) revierte el inbox para que el mensaje se reintente.
 */
@Injectable()
export class ReporteDiarioConsumer implements OnApplicationBootstrap {
  private readonly logger = new Logger(ReporteDiarioConsumer.name);

  constructor(
    private readonly bus: EventBus,
    private readonly prisma: PrismaService,
    private readonly documentos: DocumentosOperativosService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.bus.subscribe({
      source: 'operaciones',
      patterns: [EVENTO_REPORTE_DIARIO],
      // su propia cola: el consumidor del cierre del ticket lee otros eventos del mismo origen
      group: 'reportes-diarios',
      handler: (e) => this.consumir(e),
    });
  }

  /** Público para poder probarlo sin RabbitMQ. */
  async consumir(event: EventEnvelope): Promise<void> {
    if (event.type !== EVENTO_REPORTE_DIARIO) return;
    await runInEventSpan(`consume ${event.type}`, event.traceparent, async () => {
      await this.prisma.$transaction(async (tx) => {
        const nuevo = await this.bus.handleOnce(tx, event, async () => this.recibir(event));
        if (!nuevo) this.logger.warn(`Evento ${event.id} duplicado: se ignora`);
      });
    });
  }

  private async recibir(event: EventEnvelope): Promise<void> {
    const d = event.data;
    const pedidoId = String(d['pedidoId'] ?? '');
    const userId = event.actor?.userId;
    if (!pedidoId || !userId || !d['fecha']) {
      this.logger.warn(`${event.type}: falta el pedido, el día o quién lo completó; se ignora`);
      return;
    }
    // quien completó el día queda como quien lo envió; el servicio no revisa permisos
    const actor = {
      id: userId,
      email: '',
      name: '',
      roleId: '',
      roleCode: event.actor?.role ?? 'operador',
      impersonated: false,
      permissions: [],
      mustChangePassword: false,
    } as unknown as AuthUser;
    const dto = {
      tipo: 'reporte_job',
      origen: 'pumping',
      ticketRef: d['ticketNumero'] == null ? undefined : String(d['ticketNumero']),
      fecha: String(d['fecha']),
      firmadoPor: d['firmadoPor'] ? String(d['firmadoPor']) : undefined,
      firmadoAt: d['firmadoAt'] ? String(d['firmadoAt']) : undefined,
      supervisorId: d['supervisorId'] ? String(d['supervisorId']) : undefined,
      operadorId: d['operadorId'] ? String(d['operadorId']) : undefined,
      actividades: (d['actividades'] ?? []) as RecibirDocumentoOperativoDto['actividades'],
    } as RecibirDocumentoOperativoDto;
    try {
      await this.documentos.recibir(pedidoId, dto, actor);
      this.logger.log(`Pedido ${pedidoId}: Reporte Job del ${dto.fecha} recibido`);
    } catch (e) {
      if (
        e instanceof ConflictException ||
        e instanceof NotFoundException ||
        e instanceof BadRequestException
      ) {
        this.logger.warn(
          `Pedido ${pedidoId}: Reporte Job del ${dto.fecha} no se recibió (${e.message})`,
        );
        return;
      }
      throw e;
    }
  }
}
