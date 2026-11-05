import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AuthUser } from '@dyn/common';
import { uuidv7 } from '@dyn/utils';
import type { GasIngreso, Prisma } from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';
import { diasEntre, fechaValida, JornadasService } from './jornadas.service';

/** El checklist se llena al llegar al sitio, al iniciar la ejecución (en la demo: «Ingreso a locación... al inicio de la Ejecución»). */
const PASO = 'ejecucion_operativa';
/** El checklist lo llena el Operador del equipo; el superadmin queda como excepción de plataforma. */
const COORDINAN = ['superadmin'];

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

const aFecha = (d: Date): string => d.toISOString().slice(0, 10);
const deDia = (f: string): Date => new Date(`${f}T00:00:00Z`);

/**
 * Checklist de ingreso a locación + verificaciones de seguridad: uno por ticket y por DÍA (las lecturas de gas y el LOTO del día anterior no
 * valen para hoy). Lo llena el Operador del equipo al llegar al sitio. Queda completo cuando están las cinco confirmaciones, la última lectura
 * de cada gas es segura y todos los ítems LOTO están marcados; entonces cumple el requisito de apertura `checklist_seguridad_dia` de esa jornada
 * (y lo reabre si vuelve a quedar incompleto).
 *
 * Las rutas sin fecha se conservan por compatibilidad: trabajan con el día de hoy si es día de servicio y, si no, con el primer día; ahí no se
 * exige la jornada. Las rutas con fecha sí exigen que ese día sea una jornada activa del servicio y que ya haya llegado.
 */
@Injectable()
export class IngresoService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jornadas: JornadasService,
  ) {}

  /** Crea el checklist del día con sus ítems LOTO (idempotente). */
  async crear(tx: Prisma.TransactionClient, ticketId: string, fecha: string): Promise<void> {
    await tx.ticketIngreso.upsert({
      where: { ticketId_fecha: { ticketId, fecha: deDia(fecha) } },
      create: { ticketId, fecha: deDia(fecha) },
      update: {},
    });
    const items = await tx.lotoItem.findMany({ where: { activo: true }, select: { id: true } });
    await tx.ticketIngresoLoto.createMany({
      data: items.map((i) => ({ ticketId, fecha: deDia(fecha), lotoItemId: i.id })),
      skipDuplicates: true,
    });
  }

  /**
   * Qué día es el del checklist. Con fecha: debe existir en el calendario y estar dentro del servicio del ticket. Sin fecha (ruta anterior):
   * hoy si es día de servicio; si no, el primer día; y si el ticket no tiene fechas, hoy.
   */
  private async resolverDia(
    db: Prisma.TransactionClient | PrismaService,
    ticketId: string,
    fecha?: string,
  ): Promise<{ dia: string; explicito: boolean }> {
    const t = await db.ticket.findUnique({
      where: { id: ticketId },
      select: { fechaInicioServicio: true, fechaFinServicio: true },
    });
    if (!t) throw new NotFoundException('El ticket no existe');
    const hoy = this.jornadas.hoy();
    if (fecha !== undefined) {
      if (!fechaValida(fecha))
        throw new BadRequestException('La fecha debe tener el formato AAAA-MM-DD');
      if (
        t.fechaInicioServicio &&
        t.fechaFinServicio &&
        !diasEntre(aFecha(t.fechaInicioServicio), aFecha(t.fechaFinServicio)).includes(fecha)
      ) {
        throw new NotFoundException('Ese día no está dentro del rango del servicio');
      }
      return { dia: fecha, explicito: true };
    }
    if (!t.fechaInicioServicio) return { dia: hoy, explicito: false };
    const inicio = aFecha(t.fechaInicioServicio);
    const fin = t.fechaFinServicio ? aFecha(t.fechaFinServicio) : inicio;
    return { dia: hoy >= inicio && hoy <= fin ? hoy : inicio, explicito: false };
  }

  /** Carga el checklist del día (con sus lecturas y ítems LOTO); si todavía no existe, lo crea. */
  private async cargar(ticketId: string, dia: string) {
    const incluir = {
      gases: { orderBy: { medidoAt: 'asc' } },
      loto: { include: { item: true }, orderBy: { item: { orden: 'asc' } } },
    } as const;
    const donde = { ticketId_fecha: { ticketId, fecha: deDia(dia) } };
    const ingreso = await this.prisma.ticketIngreso.findUnique({ where: donde, include: incluir });
    if (ingreso) return ingreso;
    await this.prisma.$transaction((tx) => this.crear(tx, ticketId, dia));
    return this.prisma.ticketIngreso.findUniqueOrThrow({ where: donde, include: incluir });
  }

  async obtener(ticketId: string, fecha?: string) {
    const { dia } = await this.resolverDia(this.prisma, ticketId, fecha);
    return this.leer(ticketId, dia);
  }

  private async leer(ticketId: string, dia: string) {
    const ingreso = await this.cargar(ticketId, dia);
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
      fecha: dia,
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

  async actualizar(ticketId: string, cambios: CambiosIngreso, actor: AuthUser, fecha?: string) {
    const { dia } = await this.prisma.$transaction(async (tx) => {
      const r = await this.exigirPuedeEditar(tx, ticketId, actor, fecha);
      await this.crear(tx, ticketId, r.dia);
      const clave = { ticketId_fecha: { ticketId, fecha: deDia(r.dia) } };
      const data: Prisma.TicketIngresoUpdateInput = {};
      for (const k of CLAVES) if (cambios[k] !== undefined) data[k] = cambios[k];
      if (Object.keys(data).length) await tx.ticketIngreso.update({ where: clave, data });

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
            fecha: deDia(r.dia),
            gas: limite.gas,
            lectura: cambios.nuevaLectura.lectura,
            seguro: lecturaSegura(limite, cambios.nuevaLectura.lectura),
            medidoPor: actor.id,
          },
        });
      }
      await this.reevaluar(tx, ticketId, r.dia, actor);
      return r;
    });
    return this.leer(ticketId, dia);
  }

  /** Marca o desmarca un ítem LOTO. Al quedar todos marcados por primera vez se anota la notificación al cliente. */
  async alternarLoto(ticketId: string, itemId: string, actor: AuthUser, fecha?: string) {
    const { dia } = await this.prisma.$transaction(async (tx) => {
      const r = await this.exigirPuedeEditar(tx, ticketId, actor, fecha);
      await this.crear(tx, ticketId, r.dia);
      const f = deDia(r.dia);
      const clave = { ticketId_fecha_lotoItemId: { ticketId, fecha: f, lotoItemId: itemId } };
      const fila = await tx.ticketIngresoLoto.findUnique({ where: clave });
      if (!fila) throw new NotFoundException('Ese ítem LOTO no existe');
      await tx.ticketIngresoLoto.update({
        where: clave,
        data: fila.marcado
          ? { marcado: false, marcadoPor: null, marcadoAt: null }
          : { marcado: true, marcadoPor: actor.id, marcadoAt: new Date() },
      });
      const todos = await tx.ticketIngresoLoto.findMany({ where: { ticketId, fecha: f } });
      const ingreso = await tx.ticketIngreso.findUniqueOrThrow({
        where: { ticketId_fecha: { ticketId, fecha: f } },
      });
      if (todos.every((l) => l.marcado) && !ingreso.lotoNotificadoClienteAt) {
        await tx.ticketIngreso.update({
          where: { ticketId_fecha: { ticketId, fecha: f } },
          data: { lotoNotificadoClienteAt: new Date() },
        });
      }
      await this.reevaluar(tx, ticketId, r.dia, actor);
      return r;
    });
    return this.leer(ticketId, dia);
  }

  /**
   * Recalcula si el checklist del día está completo y mantiene al día `confirmado_*` y el requisito de apertura de esa jornada.
   */
  private async reevaluar(
    tx: Prisma.TransactionClient,
    ticketId: string,
    dia: string,
    actor: AuthUser,
  ): Promise<void> {
    const clave = { ticketId_fecha: { ticketId, fecha: deDia(dia) } };
    const ingreso = await tx.ticketIngreso.findUniqueOrThrow({
      where: clave,
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
        where: clave,
        data: { confirmadoPor: actor.id, confirmadoAt: new Date() },
      });
    } else if (!completo && ingreso.confirmadoAt) {
      await tx.ticketIngreso.update({
        where: clave,
        data: { confirmadoPor: null, confirmadoAt: null },
      });
    }
    // el requisito de ese día (y la apertura de la jornada, si era lo último que faltaba)
    await this.jornadas.sincronizar(tx, ticketId, actor.id);
  }

  /**
   * Solo el Operador asignado al ticket (o el superadmin) y solo mientras el ticket está en Ejecución operativa. Con fecha, además, el día debe
   * ser una jornada activa que ya llegó.
   */
  private async exigirPuedeEditar(
    tx: Prisma.TransactionClient,
    ticketId: string,
    actor: AuthUser,
    fecha?: string,
  ): Promise<{ dia: string; explicito: boolean }> {
    const t = await tx.ticket.findUnique({ where: { id: ticketId }, select: { pasoCodigo: true } });
    if (!t) throw new NotFoundException('El ticket no existe');
    if (!COORDINAN.includes(actor.roleCode)) {
      const p = await tx.ticketPersona.findUnique({
        where: { ticketId_usuarioId: { ticketId, usuarioId: actor.id } },
      });
      if (!p || p.rol !== 'operador')
        throw new ForbiddenException(
          'Solo el Operador asignado a este ticket puede llenar el checklist de ingreso',
        );
    }
    if (t.pasoCodigo !== PASO)
      throw new ConflictException(
        'El checklist de ingreso se llena en el paso de Ejecución operativa',
      );
    const r = await this.resolverDia(tx, ticketId, fecha);
    if (r.explicito)
      await this.jornadas.exigirDiaDeTrabajo(tx, ticketId, r.dia, 'el checklist de seguridad');
    return r;
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
