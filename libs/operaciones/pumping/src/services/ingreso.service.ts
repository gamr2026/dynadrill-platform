import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AuthUser } from '@dyn/common';
import { uuidv7 } from '@dyn/utils';
import { REQ } from '../catalog/sembrar-traslado-salida';
import type { GasIngreso, Prisma } from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';
import { RequisitosService } from './requisitos.service';

/** El checklist se llena al llegar al sitio, al iniciar la ejecución (en la demo: «Ingreso a locación... al inicio de la Ejecución»). */
const PASO = 'ejecucion_operativa';
const COORDINAN = ['superadmin', 'jefe_base'];

export interface Confirmaciones {
  toolboxTalkRealizado: boolean;
  walkaroundCompletado: boolean;
  lineaBaseAmbientalDocumentada: boolean;
  rutasEmergenciaVerificadas: boolean;
  simopsConfirmado: boolean;
}
const CLAVES: Array<keyof Confirmaciones> = [
  'toolboxTalkRealizado',
  'walkaroundCompletado',
  'lineaBaseAmbientalDocumentada',
  'rutasEmergenciaVerificadas',
  'simopsConfirmado',
];

type Limite = { minimo: Prisma.Decimal | null; maximo: Prisma.Decimal };

/** Sin mínimo: seguro si la lectura es menor al máximo. Con mínimo: entre ambos, inclusive. */
export const lecturaSegura = (l: Limite, lectura: number): boolean =>
  l.minimo !== null
    ? lectura >= Number(l.minimo) && lectura <= Number(l.maximo)
    : lectura < Number(l.maximo);

export interface CambiosIngreso extends Partial<Confirmaciones> {
  nuevaLectura?: { gas: GasIngreso; lectura: number };
}

/**
 * Checklist de ingreso a locación + verificaciones de seguridad (uno por ticket). Lo llena el equipo del ticket al llegar al sitio, al iniciar la
 * ejecución. Queda completo cuando están las cinco confirmaciones, la última lectura de cada gas es segura y todos los ítems LOTO están
 * marcados; entonces cumple el requisito `checklist_ingreso_locacion` (y lo reabre si vuelve a quedar incompleto).
 */
@Injectable()
export class IngresoService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly requisitos: RequisitosService,
  ) {}

  /** Crea el checklist del ticket con sus ítems LOTO (idempotente). */
  async crear(tx: Prisma.TransactionClient, ticketId: string): Promise<void> {
    await tx.ticketIngreso.upsert({ where: { ticketId }, create: { ticketId }, update: {} });
    const items = await tx.lotoItem.findMany({ where: { activo: true }, select: { id: true } });
    await tx.ticketIngresoLoto.createMany({
      data: items.map((i) => ({ ticketId, lotoItemId: i.id })),
      skipDuplicates: true,
    });
  }

  /** Carga el checklist (con sus lecturas y ítems LOTO); si el ticket aún no lo tiene, lo crea. */
  private async cargar(ticketId: string) {
    const incluir = {
      gases: { orderBy: { medidoAt: 'asc' } },
      loto: { include: { item: true }, orderBy: { item: { orden: 'asc' } } },
    } as const;
    const ingreso = await this.prisma.ticketIngreso.findUnique({
      where: { ticketId },
      include: incluir,
    });
    if (ingreso) return ingreso;
    const existe = await this.prisma.ticket.findUnique({
      where: { id: ticketId },
      select: { id: true },
    });
    if (!existe) throw new NotFoundException('El ticket no existe');
    await this.prisma.$transaction((tx) => this.crear(tx, ticketId));
    return this.prisma.ticketIngreso.findUniqueOrThrow({ where: { ticketId }, include: incluir });
  }

  async obtener(ticketId: string) {
    const ingreso = await this.cargar(ticketId);
    const [limites, nombres] = await Promise.all([
      this.prisma.gasLimite.findMany({ orderBy: { gas: 'asc' } }),
      this.nombresDe([
        ...ingreso.gases.map((g) => g.medidoPor),
        ...(ingreso.confirmadoPor ? [ingreso.confirmadoPor] : []),
      ]),
    ]);
    const confirmaciones = Object.fromEntries(
      CLAVES.map((k) => [k, ingreso[k]]),
    ) as unknown as Confirmaciones;
    const ultimaPorGas = new Map<GasIngreso, boolean>();
    for (const g of ingreso.gases) ultimaPorGas.set(g.gas, g.seguro); // las lecturas vienen de la más antigua a la más reciente
    const gasesOk = limites.every((l) => ultimaPorGas.get(l.gas) === true);
    const lotoOk = ingreso.loto.length > 0 && ingreso.loto.every((l) => l.marcado);
    return {
      ticketId,
      ...confirmaciones,
      limites: limites.map((l) => ({
        gas: l.gas,
        nombre: l.nombre,
        unidad: l.unidad,
        minimo: l.minimo === null ? null : Number(l.minimo),
        maximo: Number(l.maximo),
      })),
      lecturas: ingreso.gases.map((g) => ({
        gas: g.gas,
        lectura: Number(g.lectura),
        seguro: g.seguro,
        medidoAt: g.medidoAt,
        medidoPor: nombres.get(g.medidoPor) ?? null,
      })),
      loto: ingreso.loto.map((l) => ({
        itemId: l.lotoItemId,
        etiqueta: l.item.etiqueta,
        marcado: l.marcado,
      })),
      lotoNotificadoClienteAt: ingreso.lotoNotificadoClienteAt,
      confirmadoPor: ingreso.confirmadoPor ? (nombres.get(ingreso.confirmadoPor) ?? null) : null,
      confirmadoAt: ingreso.confirmadoAt,
      completo: CLAVES.every((k) => confirmaciones[k]) && gasesOk && lotoOk,
    };
  }

  async actualizar(ticketId: string, cambios: CambiosIngreso, actor: AuthUser) {
    await this.prisma.$transaction(async (tx) => {
      await this.exigirPuedeEditar(tx, ticketId, actor);
      await this.crear(tx, ticketId);
      const data: Prisma.TicketIngresoUpdateInput = {};
      for (const k of CLAVES) if (cambios[k] !== undefined) data[k] = cambios[k];
      if (Object.keys(data).length) await tx.ticketIngreso.update({ where: { ticketId }, data });

      if (cambios.nuevaLectura) {
        const limite = await tx.gasLimite.findUnique({ where: { gas: cambios.nuevaLectura.gas } });
        if (!limite) throw new BadRequestException('El gas indicado no existe');
        if (!Number.isFinite(cambios.nuevaLectura.lectura) || cambios.nuevaLectura.lectura < 0) {
          throw new BadRequestException('La lectura debe ser un número mayor o igual a cero');
        }
        await tx.ticketIngresoGas.create({
          data: {
            id: uuidv7(),
            ticketId,
            gas: limite.gas,
            lectura: cambios.nuevaLectura.lectura,
            seguro: lecturaSegura(limite, cambios.nuevaLectura.lectura),
            medidoPor: actor.id,
          },
        });
      }
      await this.reevaluar(tx, ticketId, actor);
    });
    return this.obtener(ticketId);
  }

  /** Marca o desmarca un ítem LOTO. Al quedar todos marcados por primera vez se anota la notificación al cliente. */
  async alternarLoto(ticketId: string, itemId: string, actor: AuthUser) {
    await this.prisma.$transaction(async (tx) => {
      await this.exigirPuedeEditar(tx, ticketId, actor);
      await this.crear(tx, ticketId);
      const fila = await tx.ticketIngresoLoto.findUnique({
        where: { ticketId_lotoItemId: { ticketId, lotoItemId: itemId } },
      });
      if (!fila) throw new NotFoundException('Ese ítem LOTO no existe');
      await tx.ticketIngresoLoto.update({
        where: { ticketId_lotoItemId: { ticketId, lotoItemId: itemId } },
        data: fila.marcado
          ? { marcado: false, marcadoPor: null, marcadoAt: null }
          : { marcado: true, marcadoPor: actor.id, marcadoAt: new Date() },
      });
      const todos = await tx.ticketIngresoLoto.findMany({ where: { ticketId } });
      const ingreso = await tx.ticketIngreso.findUniqueOrThrow({ where: { ticketId } });
      if (todos.every((l) => l.marcado) && !ingreso.lotoNotificadoClienteAt) {
        await tx.ticketIngreso.update({
          where: { ticketId },
          data: { lotoNotificadoClienteAt: new Date() },
        });
      }
      await this.reevaluar(tx, ticketId, actor);
    });
    return this.obtener(ticketId);
  }

  /** Recalcula si está completo y mantiene al día `confirmado_*` y el requisito. */
  private async reevaluar(
    tx: Prisma.TransactionClient,
    ticketId: string,
    actor: AuthUser,
  ): Promise<void> {
    const ingreso = await tx.ticketIngreso.findUniqueOrThrow({
      where: { ticketId },
      include: { gases: { orderBy: { medidoAt: 'asc' } }, loto: true },
    });
    const limites = await tx.gasLimite.findMany();
    const ultima = new Map<GasIngreso, boolean>();
    for (const g of ingreso.gases) ultima.set(g.gas, g.seguro);
    const completo =
      CLAVES.every((k) => ingreso[k]) &&
      limites.every((l) => ultima.get(l.gas) === true) &&
      ingreso.loto.length > 0 &&
      ingreso.loto.every((l) => l.marcado);

    if (completo && !ingreso.confirmadoAt) {
      await tx.ticketIngreso.update({
        where: { ticketId },
        data: { confirmadoPor: actor.id, confirmadoAt: new Date() },
      });
    } else if (!completo && ingreso.confirmadoAt) {
      await tx.ticketIngreso.update({
        where: { ticketId },
        data: { confirmadoPor: null, confirmadoAt: null },
      });
    }
    if (completo)
      await this.requisitos.marcar(
        tx,
        { ticketId, codigo: REQ.ingresoLocacion },
        'sistema',
        actor.id,
      );
    else await this.requisitos.reabrir(tx, { ticketId, codigo: REQ.ingresoLocacion });
  }

  /** Solo el equipo del ticket (o quien coordina) y solo mientras el ticket está en Ejecución operativa. */
  private async exigirPuedeEditar(
    tx: Prisma.TransactionClient,
    ticketId: string,
    actor: AuthUser,
  ): Promise<void> {
    const t = await tx.ticket.findUnique({ where: { id: ticketId }, select: { pasoCodigo: true } });
    if (!t) throw new NotFoundException('El ticket no existe');
    if (!COORDINAN.includes(actor.roleCode)) {
      const p = await tx.ticketPersona.findUnique({
        where: { ticketId_usuarioId: { ticketId, usuarioId: actor.id } },
      });
      if (!p)
        throw new ForbiddenException(
          'Solo el equipo asignado a este ticket puede llenar el checklist de ingreso',
        );
    }
    if (t.pasoCodigo !== PASO)
      throw new ConflictException(
        'El checklist de ingreso se llena en el paso de Ejecución operativa',
      );
  }

  private async nombresDe(ids: string[]): Promise<Map<string, string>> {
    if (!ids.length) return new Map();
    const u = await this.prisma.idUsuario.findMany({
      where: { id: { in: [...new Set(ids)] } },
      select: { id: true, nombre: true },
    });
    return new Map(u.map((x) => [x.id, x.nombre]));
  }
}
