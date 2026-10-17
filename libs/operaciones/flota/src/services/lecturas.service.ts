import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { currentTraceparent } from '@dyn/common';
import { createEvent, EventBus } from '@dyn/messaging';
import { uuidv7 } from '@dyn/utils';
import type { FuenteLectura, Prisma, TipoLectura, TipoUnidad } from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';

/** Qué se mide en cada tipo de unidad: horas en las de servicio, kilómetros en las de transporte; las auxiliares se rigen por tiempo. */
export const LECTURA_DE_TIPO: Record<TipoUnidad, TipoLectura | null> = {
  servicio: 'horometro',
  transporte: 'odometro',
  auxiliar: null,
};

/** Quien registra: la cuenta (o `null` en una carga inicial del sistema). */
export interface ActorLectura {
  id: string;
  roleCode: string;
}

export interface LecturaEntrada {
  tipo: TipoLectura;
  valor: number;
  /** Momento de la lectura; por omisión, ahora. */
  leidaAt?: Date;
  fuente: FuenteLectura;
}

/** Tolerancia al reloj de quien envía la lectura. */
const MARGEN_FUTURO_MS = 5 * 60 * 1000;

/**
 * Lecturas de las unidades (horómetro y odómetro). Flota es la ÚNICA que las escribe; Mantenimiento, Pumping y la inspección de
 * vehículos usan `registrar` (servicio exportado). La lectura vigente es la más reciente y nunca baja: una lectura menor que una
 * anterior (o mayor que una posterior) es un error de digitación y se rechaza.
 */
@Injectable()
export class LecturasService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: EventBus,
  ) {}

  /**
   * Registra una lectura y publica `flota.unidad.lectura_registrada`. Con `tx` participa en la transacción de quien llama (p. ej. el
   * registro de un preventivo); sin ella abre la suya.
   */
  async registrar(
    unidadId: string,
    entrada: LecturaEntrada,
    actor: ActorLectura | null,
    tx?: Prisma.TransactionClient,
  ) {
    return tx
      ? this.registrarEnTx(tx, unidadId, entrada, actor)
      : this.prisma.$transaction((t) => this.registrarEnTx(t, unidadId, entrada, actor));
  }

  private async registrarEnTx(
    tx: Prisma.TransactionClient,
    unidadId: string,
    entrada: LecturaEntrada,
    actor: ActorLectura | null,
  ) {
    const unidad = await tx.unidad.findUnique({
      where: { id: unidadId },
      select: { id: true, codigo: true, tipo: true, activa: true },
    });
    if (!unidad) throw new NotFoundException('La unidad no existe');
    const esperado = LECTURA_DE_TIPO[unidad.tipo];
    if (esperado === null) {
      throw new BadRequestException({
        message:
          'Las unidades auxiliares se controlan por tiempo: no llevan horómetro ni kilometraje',
        code: 'unidad_sin_lectura',
      });
    }
    if (entrada.tipo !== esperado) {
      throw new BadRequestException({
        message:
          esperado === 'horometro'
            ? 'Una unidad de servicio se controla con horómetro'
            : 'Una unidad de transporte se controla con kilometraje',
        code: 'lectura_de_otro_tipo',
      });
    }
    const leidaAt = entrada.leidaAt ?? new Date();
    if (leidaAt.getTime() > Date.now() + MARGEN_FUTURO_MS) {
      throw new BadRequestException({
        message: 'La lectura no puede tener una fecha futura',
        code: 'lectura_futura',
      });
    }

    // La lectura debe ser coherente con la línea de tiempo: no menor que la anterior ni mayor que la siguiente.
    const [anterior, siguiente] = await Promise.all([
      tx.unidadLectura.findFirst({
        where: { unidadId, tipo: entrada.tipo, leidaAt: { lte: leidaAt }, anulacion: { is: null } },
        orderBy: [{ leidaAt: 'desc' }, { createdAt: 'desc' }],
        select: { valor: true, leidaAt: true },
      }),
      tx.unidadLectura.findFirst({
        where: { unidadId, tipo: entrada.tipo, leidaAt: { gt: leidaAt }, anulacion: { is: null } },
        orderBy: { leidaAt: 'asc' },
        select: { valor: true, leidaAt: true },
      }),
    ]);
    if (anterior && entrada.valor < Number(anterior.valor)) {
      throw new ConflictException({
        message: `La lectura (${entrada.valor}) es menor que la anterior (${Number(anterior.valor)}); revise el valor`,
        code: 'lectura_menor_que_la_anterior',
      });
    }
    if (siguiente && entrada.valor > Number(siguiente.valor)) {
      throw new ConflictException({
        message: `La lectura (${entrada.valor}) es mayor que una posterior (${Number(siguiente.valor)}); revise el valor o la fecha`,
        code: 'lectura_mayor_que_la_posterior',
      });
    }

    const lectura = await tx.unidadLectura.create({
      data: {
        id: uuidv7(),
        unidadId,
        tipo: entrada.tipo,
        valor: entrada.valor,
        leidaAt,
        fuente: entrada.fuente,
        registradaPor: actor?.id ?? null,
      },
    });
    await this.bus.publish(
      tx,
      createEvent({
        type: 'flota.unidad.lectura_registrada',
        source: 'flota',
        subject: { type: 'flota_unidad', id: unidadId },
        data: {
          unidadId,
          codigo: unidad.codigo,
          lecturaId: lectura.id,
          tipo: entrada.tipo,
          valor: entrada.valor,
          fuente: entrada.fuente,
        },
        ...(actor ? { actor: { userId: actor.id, role: actor.roleCode } } : {}),
        traceparent: currentTraceparent(),
      }),
    );
    return this.presentar(lectura);
  }

  /**
   * Anula una lectura mal tomada (la historia no se edita ni se borra). No se puede anular la lectura en la que se apoya un
   * mantenimiento preventivo vigente: primero se anula ese preventivo.
   */
  async anular(lecturaId: string, motivo: string, actor: ActorLectura) {
    return this.prisma.$transaction(async (tx) => {
      const l = await tx.unidadLectura.findUnique({
        where: { id: lecturaId },
        include: { anulacion: true, unidad: { select: { codigo: true } } },
      });
      if (!l) throw new NotFoundException('La lectura no existe');
      if (l.anulacion) {
        throw new ConflictException({
          message: 'La lectura ya está anulada',
          code: 'lectura_ya_anulada',
        });
      }
      const usada = await tx.unidadPreventivo.count({
        where: { lecturaId, anulacion: { is: null } },
      });
      if (usada > 0) {
        throw new ConflictException({
          message:
            'La lectura respalda un mantenimiento preventivo vigente; anule primero ese mantenimiento',
          code: 'lectura_en_uso',
        });
      }
      await tx.unidadLecturaAnulacion.create({
        data: { lecturaId, anuladaPor: actor.id, motivo: motivo.trim() },
      });
      await this.bus.publish(
        tx,
        createEvent({
          type: 'flota.unidad.lectura_anulada',
          source: 'flota',
          subject: { type: 'flota_unidad', id: l.unidadId },
          data: { unidadId: l.unidadId, codigo: l.unidad.codigo, lecturaId },
          actor: { userId: actor.id, role: actor.roleCode },
          traceparent: currentTraceparent(),
        }),
      );
      return { lecturaId, anulada: true };
    });
  }

  /** Historial de lecturas de una unidad, de la más reciente a la más antigua. */
  async listar(unidadId: string, tipo?: TipoLectura, limite = 50) {
    const unidad = await this.prisma.unidad.findUnique({
      where: { id: unidadId },
      select: { id: true },
    });
    if (!unidad) throw new NotFoundException('La unidad no existe');
    const filas = await this.prisma.unidadLectura.findMany({
      where: { unidadId, ...(tipo ? { tipo } : {}) },
      include: { registrador: { select: { id: true, nombre: true } }, anulacion: true },
      orderBy: [{ leidaAt: 'desc' }, { createdAt: 'desc' }],
      take: Math.min(Math.max(limite, 1), 200),
    });
    return filas.map((f) => ({
      ...this.presentar(f),
      registradaPor: f.registrador ? { id: f.registrador.id, nombre: f.registrador.nombre } : null,
      anulada: f.anulacion ? { at: f.anulacion.anuladaAt, motivo: f.anulacion.motivo } : null,
    }));
  }

  /** La lectura vigente de cada unidad y tipo (la más reciente). */
  async vigentes(unidadIds: string[]) {
    const mapa = new Map<string, { horometro?: Vigente; odometro?: Vigente }>();
    if (unidadIds.length === 0) return mapa;
    const filas = await this.prisma.unidadLectura.findMany({
      where: { unidadId: { in: unidadIds }, anulacion: { is: null } },
      distinct: ['unidadId', 'tipo'],
      orderBy: [{ unidadId: 'asc' }, { tipo: 'asc' }, { leidaAt: 'desc' }, { createdAt: 'desc' }],
      select: { id: true, unidadId: true, tipo: true, valor: true, leidaAt: true },
    });
    for (const f of filas) {
      const e = mapa.get(f.unidadId) ?? {};
      e[f.tipo] = { id: f.id, valor: Number(f.valor), leidaAt: f.leidaAt };
      mapa.set(f.unidadId, e);
    }
    return mapa;
  }

  private presentar(l: {
    id: string;
    unidadId: string;
    tipo: TipoLectura;
    valor: Prisma.Decimal;
    leidaAt: Date;
    fuente: FuenteLectura;
  }) {
    return {
      id: l.id,
      unidadId: l.unidadId,
      tipo: l.tipo,
      valor: Number(l.valor),
      leidaAt: l.leidaAt,
      fuente: l.fuente,
    };
  }
}

export interface Vigente {
  id: string;
  valor: number;
  leidaAt: Date;
}
