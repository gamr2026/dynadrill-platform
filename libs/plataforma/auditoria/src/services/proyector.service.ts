import { Injectable, Logger } from '@nestjs/common';
import { type EventEnvelope } from '@dyn/messaging';
import { uuidv7 } from '@dyn/utils';
import { CLAVES_DATO } from '../catalog/claves-dato';
import { OrigenEvento, type Prisma } from '../generated/client';

/** Cliente de una transacción interactiva: lo que recibe la proyección para escribir con el resto del trabajo del consumidor. */
export type Tx = Prisma.TransactionClient;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALOR_MAX = 200;

/** El evento no se puede auditar (dato inválido en el sobre): se registra y se omite, reintentarlo no lo arregla. */
export class EventoNoAuditable extends Error {}

/**
 * Proyecta un evento del bus en el registro de auditoría. No guarda el cuerpo: solo el sobre y las claves de negocio de la lista
 * blanca (`CLAVES_DATO`). Quien llama lo hace dentro de `handleOnce`, así que un evento repetido nunca llega aquí.
 */
@Injectable()
export class ProyectorService {
  private readonly logger = new Logger(ProyectorService.name);

  async registrar(tx: Tx, e: EventEnvelope): Promise<void> {
    if (!UUID_RE.test(e.subject?.id ?? '')) {
      throw new EventoNoAuditable(
        `El evento ${e.type} (${e.id}) trae un sujeto sin id válido: ${String(e.subject?.id)}`,
      );
    }
    if (!(e.source in OrigenEvento)) {
      throw new EventoNoAuditable(
        `El evento ${e.type} (${e.id}) viene de un origen desconocido: ${e.source}`,
      );
    }
    const tipoEventoId = await this.idDeCatalogo(tx, 'tipo_evento', e.type);
    const sujetoTipoId = await this.idDeCatalogo(tx, 'sujeto_tipo', e.subject.type);
    const { actorId, actorRolId } = await this.actorDe(tx, e);

    await tx.eventoAuditado.create({
      data: {
        id: e.id,
        tipoEventoId,
        version: e.version,
        ocurridoAt: new Date(e.occurredAt),
        origen: e.source as OrigenEvento,
        sujetoTipoId,
        sujetoId: e.subject.id,
        actorId,
        actorRolId,
        correlacionId: UUID_RE.test(e.correlationId ?? '') ? e.correlationId : null,
        causaId: UUID_RE.test(e.causationId ?? '') ? e.causationId : null,
      },
    });

    const datos = await this.datosDe(tx, e);
    if (datos.length) {
      await tx.eventoAuditadoDato.createMany({
        data: datos.map((d) => ({ eventoId: e.id, ...d })),
      });
    }
  }

  /** Alta automática del catálogo (decisión del 22/10/2026): un tipo nuevo no debe romper la auditoría. */
  private async idDeCatalogo(
    tx: Tx,
    tabla: 'tipo_evento' | 'sujeto_tipo',
    codigo: string,
  ): Promise<string> {
    await tx.$executeRawUnsafe(
      `INSERT INTO auditoria.${tabla} (id, codigo) VALUES ($1::uuid, $2) ON CONFLICT (codigo) DO NOTHING`,
      uuidv7(),
      codigo,
    );
    const fila =
      tabla === 'tipo_evento'
        ? await tx.tipoEvento.findUniqueOrThrow({ where: { codigo }, select: { id: true } })
        : await tx.sujetoTipo.findUniqueOrThrow({ where: { codigo }, select: { id: true } });
    return fila.id;
  }

  /** Un actor que no existe en identidad (p. ej. una cuenta de la demo) no impide auditar el hecho: queda sin actor. */
  private async actorDe(
    tx: Tx,
    e: EventEnvelope,
  ): Promise<{ actorId: string | null; actorRolId: string | null }> {
    const userId = e.actor?.userId;
    if (!userId || !UUID_RE.test(userId)) return { actorId: null, actorRolId: null };
    const usuario = await tx.idUsuario.findUnique({ where: { id: userId }, select: { id: true } });
    if (!usuario) {
      this.logger.warn(
        `${e.type} (${e.id}): la cuenta ${userId} no existe en identidad; se audita sin actor`,
      );
      return { actorId: null, actorRolId: null };
    }
    const rol = e.actor?.role
      ? await tx.idRol.findUnique({ where: { codigo: e.actor.role }, select: { id: true } })
      : null;
    return { actorId: usuario.id, actorRolId: rol?.id ?? null };
  }

  /** Solo las claves de la lista blanca, y solo si el valor es un texto o un número razonable. */
  private async datosDe(
    tx: Tx,
    e: EventEnvelope,
  ): Promise<{ claveDatoId: string; valor: string }[]> {
    const data = (e.data ?? {}) as Record<string, unknown>;
    const presentes = CLAVES_DATO.flatMap((c) => {
      const v = data[c.campo];
      const valor =
        typeof v === 'number' && Number.isFinite(v)
          ? String(v)
          : typeof v === 'string'
            ? v.trim()
            : '';
      return valor && valor.length <= VALOR_MAX ? [{ codigo: c.codigo, valor }] : [];
    });
    if (!presentes.length) return [];
    const claves = await tx.claveDato.findMany({
      where: { codigo: { in: presentes.map((p) => p.codigo) } },
      select: { id: true, codigo: true },
    });
    const idDe = new Map(claves.map((c) => [c.codigo, c.id]));
    return presentes.flatMap((p) => {
      const claveDatoId = idDe.get(p.codigo);
      return claveDatoId ? [{ claveDatoId, valor: p.valor }] : [];
    });
  }
}
