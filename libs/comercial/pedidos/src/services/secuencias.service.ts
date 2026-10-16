import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { uuidv7 } from '@dyn/utils';
import { formatearCodigo } from '../secuencias/formato';
import { Prisma } from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';

export interface EmitirParams {
  /** Código del documento (`pedido`, `prefactura`...). */
  documento: string;
  /** Id del documento (pedido...) que recibe el número, si ya se conoce. */
  documentoRefId?: string;
  actorId?: string;
  /** Fecha de referencia para la vigencia y para las secuencias anuales (por defecto, ahora). */
  fecha?: Date;
}

export interface Emision {
  emisionId: string;
  numero: number;
  /** Código ya formateado (`PEC-004675`, `4317`...). */
  codigo: string;
}

/**
 * Emite números de documento sin duplicados ni saltos. `emitir` debe llamarse DENTRO de la transacción que crea el
 * documento: el `UPDATE` bloquea la fila de la secuencia hasta el commit, así dos pedidos simultáneos nunca reciben
 * el mismo número, y si la transacción falla el número NO se consume (una secuencia de PostgreSQL no se revierte y
 * dejaría huecos). Un número anulado queda en la bitácora y no se reutiliza.
 */
@Injectable()
export class SecuenciasService {
  constructor(private readonly prisma: PrismaService) {}

  async emitir(tx: Prisma.TransactionClient, p: EmitirParams): Promise<Emision> {
    const fecha = p.fecha ?? new Date();
    const documento = await tx.documento.findUnique({ where: { codigo: p.documento } });
    if (!documento || !documento.activo) {
      throw new NotFoundException(`El documento "${p.documento}" no existe o está inactivo`);
    }
    if (!documento.emitePortal) {
      throw new ConflictException(
        `El número de "${p.documento}" lo asigna AS2: el portal no puede emitirlo`,
      );
    }

    const anio = fecha.getUTCFullYear();
    const secuencia = await tx.secuencia.findFirst({
      where: {
        documentoId: documento.id,
        activa: true,
        OR: [{ reinicio: 'nunca' }, { reinicio: 'anual', anio }],
      },
    });
    if (!secuencia) {
      throw new ConflictException(
        `No hay una secuencia activa para "${p.documento}" en ${anio}: cree una antes de emitir`,
      );
    }
    if (secuencia.hacerCumplirVigencia) {
      const dia = new Date(Date.UTC(anio, fecha.getUTCMonth(), fecha.getUTCDate()));
      const fuera =
        (secuencia.vigenciaDesde && dia < secuencia.vigenciaDesde) ||
        (secuencia.vigenciaHasta && dia > secuencia.vigenciaHasta);
      if (fuera)
        throw new ConflictException(
          `La secuencia de "${p.documento}" no está vigente en esa fecha`,
        );
    }

    // El UPDATE toma el bloqueo de la fila: las emisiones simultáneas se ponen en fila hasta el commit.
    const filas = await tx.$queryRaw<{ numero_actual: number }[]>`
      UPDATE comercial.secuencia
         SET numero_actual = numero_actual + 1, version = version + 1, updated_at = now()
       WHERE id = ${secuencia.id}::uuid AND activa AND numero_actual < rango_hasta
       RETURNING numero_actual`;
    if (filas.length === 0) {
      throw new ConflictException(
        `La secuencia de "${p.documento}" llegó al final de su rango (${secuencia.rangoHasta})`,
      );
    }
    const numero = filas[0].numero_actual;
    const codigo = formatearCodigo(secuencia.prefijo, secuencia.sufijo, secuencia.longitud, numero);

    const emisionId = uuidv7();
    await tx.secuenciaEmision.create({
      data: {
        id: emisionId,
        secuenciaId: secuencia.id,
        numero,
        codigoFormateado: codigo,
        documentoRefId: p.documentoRefId ?? null,
        estado: p.documentoRefId ? 'emitido' : 'huerfano',
        emitidoPor: p.actorId ?? null,
      },
    });
    return { emisionId, numero, codigo };
  }

  /**
   * Registra a mano un número en un documento que EMITE el portal (p. ej. al reasignar el número de una guía de remisión).
   * El número no se puede repetir (ni de un documento anulado) y debe caber en el rango y en el código; si es mayor que el
   * contador, el contador avanza hasta él para que el siguiente no lo duplique. Va DENTRO de la transacción del documento.
   */
  async registrarManual(
    tx: Prisma.TransactionClient,
    p: { documento: string; numero: number; documentoRefId: string; actorId?: string },
  ): Promise<Emision> {
    return this.registrar(tx, p, true);
  }

  /**
   * Reserva el SIGUIENTE número de una secuencia que espeja a AS2 (la de la prefactura, `PRC-`) para un documento que todavía
   * no existe: el pedido toma su número de ticket al abrirse y la prefactura lo hereda. Toma el mayor entre el contador del
   * portal y el último que se vio en AS2, y le suma uno; el bloqueo de la fila evita que dos pedidos reciban el mismo. El
   * número queda en la bitácora; si el pedido se anula se anula el número y no se reutiliza. Va DENTRO de la transacción.
   */
  async reservarSiguiente(
    tx: Prisma.TransactionClient,
    p: { documento: string; documentoRefId: string; actorId?: string },
  ): Promise<Emision> {
    const filas = await tx.$queryRaw<
      { numero_actual: number; as2_numero_actual: number | null; mayor_registrado: number | null }[]
    >`
      SELECT s.numero_actual, s.as2_numero_actual,
             (SELECT max(e.numero) FROM comercial.secuencia_emision e WHERE e.secuencia_id = s.id) AS mayor_registrado
        FROM comercial.secuencia s
        JOIN comercial.documento d ON d.id = s.documento_id
       WHERE d.codigo = ${p.documento} AND s.activa
       FOR UPDATE OF s`;
    if (filas.length === 0)
      throw new ConflictException(`No hay una secuencia activa para "${p.documento}"`);
    // mayor que el contador del portal, que lo último visto en AS2 y que cualquier número ya registrado: nunca se repite
    const numero =
      Math.max(
        filas[0].numero_actual,
        filas[0].as2_numero_actual ?? 0,
        filas[0].mayor_registrado ?? 0,
      ) + 1;
    return this.registrar(
      tx,
      { documento: p.documento, numero, documentoRefId: p.documentoRefId, actorId: p.actorId },
      false,
    );
  }

  /**
   * Anota que AS2 ya usó este número (p. ej. el `PEC-004680` de un pedido que se cargó desde AS2): el espejo avanza hasta él
   * y la siguiente reserva del portal queda por encima. No crea ningún registro en la bitácora ni falla si el número ya
   * estaba. `numero` puede venir con su prefijo (`PEC-004680`).
   */
  async observarAs2(
    tx: Prisma.TransactionClient,
    documento: string,
    numero: string | number,
  ): Promise<void> {
    const n = typeof numero === 'number' ? numero : Number(/(\d+)\s*$/.exec(numero)?.[1]);
    if (!Number.isInteger(n) || n <= 0) return;
    await tx.$executeRaw`
      UPDATE comercial.secuencia s
         SET numero_actual = GREATEST(s.numero_actual, ${n}::int),
             as2_numero_actual = GREATEST(coalesce(s.as2_numero_actual, 0), ${n}::int),
             as2_sincronizado_at = now(), version = s.version + 1, updated_at = now()
        FROM comercial.documento d
       WHERE d.id = s.documento_id AND d.codigo = ${documento} AND s.activa AND d.emite_portal = false`;
  }

  /** Anula un número dentro de la transacción de quien lo pide (el número no se reutiliza; queda con su motivo). */
  async anularEn(tx: Prisma.TransactionClient, emisionId: string, motivo: string): Promise<void> {
    await tx.secuenciaEmision.updateMany({
      where: { id: emisionId, estado: { not: 'anulado' } },
      data: { estado: 'anulado', motivo: motivo.trim() },
    });
  }

  /**
   * Registra en el espejo de una secuencia de AS2 (`PEC-`, `PRC-`...) el número que AS2 asignó a un documento. El portal no
   * emite estos números: los recibe. Un mismo número no se registra dos veces (ni siquiera de un documento anulado) y
   * debe caer dentro del rango; el contador espejo avanza al mayor número registrado. Va DENTRO de la transacción del
   * documento.
   */
  async registrarExterno(
    tx: Prisma.TransactionClient,
    p: { documento: string; numero: number; documentoRefId: string; actorId?: string },
  ): Promise<Emision> {
    return this.registrar(tx, p, false);
  }

  private async registrar(
    tx: Prisma.TransactionClient,
    p: { documento: string; numero: number; documentoRefId: string; actorId?: string },
    emitePortal: boolean,
  ): Promise<Emision> {
    const documento = await tx.documento.findUnique({ where: { codigo: p.documento } });
    if (!documento || !documento.activo) {
      throw new NotFoundException(`El documento "${p.documento}" no existe o está inactivo`);
    }
    if (documento.emitePortal !== emitePortal) {
      throw new ConflictException(
        emitePortal
          ? `El número de "${p.documento}" lo asigna AS2: se registra el que AS2 entregue`
          : `El número de "${p.documento}" lo emite el portal, no se registra a mano`,
      );
    }
    const secuencia = await tx.secuencia.findFirst({
      where: { documentoId: documento.id, activa: true },
    });
    if (!secuencia) {
      throw new ConflictException(`No hay una secuencia activa para "${p.documento}"`);
    }
    // Lo que cabe en el código: la longitud incluye el prefijo y el sufijo (p. ej. `PRC-` + 5 dígitos = 9).
    const digitos =
      secuencia.longitud - (secuencia.prefijo?.length ?? 0) - (secuencia.sufijo?.length ?? 0);
    const maximo = Math.min(
      secuencia.rangoHasta,
      digitos > 0 ? 10 ** digitos - 1 : secuencia.rangoHasta,
    );
    if (!Number.isInteger(p.numero) || p.numero < secuencia.rangoDesde || p.numero > maximo) {
      throw new BadRequestException(
        `El número debe estar entre ${secuencia.rangoDesde} y ${maximo}`,
      );
    }
    const yaRegistrado = await tx.secuenciaEmision.findUnique({
      where: { secuenciaId_numero: { secuenciaId: secuencia.id, numero: p.numero } },
      select: { id: true },
    });
    if (yaRegistrado) {
      throw new ConflictException(`El número ${p.numero} ya está registrado en "${p.documento}"`);
    }
    const codigo = formatearCodigo(
      secuencia.prefijo,
      secuencia.sufijo,
      secuencia.longitud,
      p.numero,
    );
    const emisionId = uuidv7();
    await tx.secuenciaEmision.create({
      data: {
        id: emisionId,
        secuenciaId: secuencia.id,
        numero: p.numero,
        codigoFormateado: codigo,
        documentoRefId: p.documentoRefId,
        estado: 'emitido',
        emitidoPor: p.actorId ?? null,
      },
    });
    if (emitePortal) {
      await tx.$executeRaw`
        UPDATE comercial.secuencia
           SET numero_actual = GREATEST(numero_actual, ${p.numero}::int), version = version + 1, updated_at = now()
         WHERE id = ${secuencia.id}::uuid`;
    } else {
      await tx.$executeRaw`
        UPDATE comercial.secuencia
           SET numero_actual = GREATEST(numero_actual, ${p.numero}::int),
               as2_numero_actual = GREATEST(coalesce(as2_numero_actual, 0), ${p.numero}::int),
               as2_sincronizado_at = now(), version = version + 1, updated_at = now()
         WHERE id = ${secuencia.id}::uuid`;
    }
    return { emisionId, numero: p.numero, codigo };
  }

  /** Enlaza un número emitido sin documento (`huerfano`) con el documento que por fin lo recibió. */
  async asignar(
    tx: Prisma.TransactionClient,
    emisionId: string,
    documentoRefId: string,
  ): Promise<void> {
    const r = await tx.secuenciaEmision.updateMany({
      where: { id: emisionId, estado: 'huerfano' },
      data: { documentoRefId, estado: 'emitido' },
    });
    if (r.count === 0) throw new ConflictException('Ese número ya está asignado o no existe');
  }

  /** Anula un número emitido. El número no se reutiliza; queda en la bitácora con su motivo. */
  async anular(emisionId: string, motivo: string): Promise<void> {
    if (!motivo.trim()) throw new BadRequestException('El motivo es obligatorio');
    const r = await this.prisma.secuenciaEmision.updateMany({
      where: { id: emisionId, estado: { not: 'anulado' } },
      data: { estado: 'anulado', motivo: motivo.trim() },
    });
    if (r.count === 0) throw new NotFoundException('El número no existe o ya estaba anulado');
  }

  // ---- consultas (solo lectura) ---------------------------------------------------------------------------

  async listar() {
    const filas = await this.prisma.secuencia.findMany({
      orderBy: [{ documento: { codigo: 'asc' } }, { anio: 'desc' }],
      include: {
        documento: { select: { codigo: true, nombre: true, nombreAs2: true, emitePortal: true } },
      },
    });
    return filas.map((s) => ({
      id: s.id,
      documento: s.documento.codigo,
      nombre: s.documento.nombre,
      nombreAs2: s.documento.nombreAs2,
      emitePortal: s.documento.emitePortal,
      origen: s.origen,
      prefijo: s.prefijo,
      sufijo: s.sufijo,
      longitud: s.longitud,
      rangoDesde: s.rangoDesde,
      rangoHasta: s.rangoHasta,
      numeroActual: s.numeroActual,
      siguiente: s.documento.emitePortal ? s.numeroActual + 1 : null,
      reinicio: s.reinicio,
      anio: s.anio,
      vigenciaDesde: s.vigenciaDesde?.toISOString().slice(0, 10) ?? null,
      vigenciaHasta: s.vigenciaHasta?.toISOString().slice(0, 10) ?? null,
      hacerCumplirVigencia: s.hacerCumplirVigencia,
      as2NumeroActual: s.as2NumeroActual,
      as2SincronizadoAt: s.as2SincronizadoAt,
      activa: s.activa,
    }));
  }

  async emisiones(secuenciaId: string, limit = 50) {
    const existe = await this.prisma.secuencia.findUnique({
      where: { id: secuenciaId },
      select: { id: true },
    });
    if (!existe) throw new NotFoundException('La secuencia no existe');
    return this.prisma.secuenciaEmision.findMany({
      where: { secuenciaId },
      orderBy: { numero: 'desc' },
      take: Math.min(limit, 200),
      select: {
        id: true,
        numero: true,
        codigoFormateado: true,
        estado: true,
        documentoRefId: true,
        emitidoAt: true,
        motivo: true,
      },
    });
  }
}
