import { Injectable } from '@nestjs/common';
import { type EventEnvelope } from '@dyn/messaging';
import { uuidv7 } from '@dyn/utils';
import { MetodoFirma, type Prisma } from '../generated/client';

/** Cliente de una transacción interactiva: lo que recibe el registro para escribir con el resto del trabajo del consumidor. */
export type Tx = Prisma.TransactionClient;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;
const METODOS = Object.keys(MetodoFirma);

/**
 * El evento `*.firmado` no cumple el contrato. No mejora al reintentar: el mensaje termina en la cola de fallidos para que
 * alguien lo revise, y NO se descarta en silencio (perder una firma es peor que retrasarla).
 */
export class EventoDeFirmaInvalido extends Error {}

/** Datos que el módulo dueño del documento publica en `<contenedor>.<documento>.firmado` (contrato 4.14). */
export interface DatosDeFirma {
  documentoTipo?: unknown;
  documentoId?: unknown;
  rolFirmante?: unknown;
  metodo?: unknown;
  hashDocumento?: unknown;
  archivoId?: unknown;
}

/**
 * Registra la evidencia de una firma a partir del evento de su módulo. El módulo ya validó quién puede firmar; aquí se comprueba que
 * el evento diga quién firmó (el `actor`, una cuenta real), que el documento y el papel existan en los catálogos y que la prueba
 * (huella o archivo) cuadre con el método. La hora es la del servidor al registrar.
 */
@Injectable()
export class RegistradorService {
  async registrar(tx: Tx, e: EventEnvelope): Promise<void> {
    const d = (e.data ?? {}) as DatosDeFirma;
    const nombre = `${e.type} (${e.id})`;
    const invalido = (motivo: string) => new EventoDeFirmaInvalido(`${nombre}: ${motivo}`);

    if (!e.type.endsWith('.firmado'))
      throw invalido('el tipo del evento debe terminar en «.firmado»');
    const firmanteId = e.actor?.userId;
    if (!firmanteId || !UUID_RE.test(firmanteId)) throw invalido('no informa quién firmó (actor)');
    if (typeof d.documentoId !== 'string' || !UUID_RE.test(d.documentoId)) {
      throw invalido('documentoId no es un UUID');
    }
    if (typeof d.metodo !== 'string' || !METODOS.includes(d.metodo)) {
      throw invalido(`metodo debe ser uno de: ${METODOS.join(', ')}`);
    }
    const metodo = d.metodo as MetodoFirma;

    const firmante = await tx.idUsuario.findUnique({
      where: { id: firmanteId },
      select: { id: true },
    });
    if (!firmante) throw invalido(`la cuenta firmante ${firmanteId} no existe`);
    const documento = await tx.documentoTipo.findFirst({
      where: { codigo: String(d.documentoTipo), activo: true },
      select: { id: true },
    });
    if (!documento)
      throw invalido(`el documento «${String(d.documentoTipo)}» no está en el catálogo de firmas`);
    const rol = await tx.rolFirmante.findFirst({
      where: { codigo: String(d.rolFirmante), activo: true },
      select: { id: true },
    });
    if (!rol)
      throw invalido(`el papel «${String(d.rolFirmante)}» no está en el catálogo de firmas`);

    const prueba = await this.prueba(tx, metodo, d, invalido);
    await tx.firma.create({
      data: {
        id: uuidv7(),
        eventoId: e.id,
        documentoTipoId: documento.id,
        documentoId: d.documentoId,
        rolFirmanteId: rol.id,
        firmanteId: firmante.id,
        metodo,
        ...prueba,
      },
    });
  }

  /** La prueba de la firma: la huella del texto firmado («de una línea») o el archivo firmado (con su huella en `archivos`). */
  private async prueba(
    tx: Tx,
    metodo: MetodoFirma,
    d: DatosDeFirma,
    invalido: (motivo: string) => Error,
  ): Promise<{ hashDocumento: string } | { archivoId: string }> {
    if (metodo === 'linea') {
      if (d.archivoId !== undefined && d.archivoId !== null) {
        throw invalido('una firma «de una línea» no lleva archivo');
      }
      if (typeof d.hashDocumento !== 'string' || !SHA256_RE.test(d.hashDocumento)) {
        throw invalido(
          'hashDocumento debe ser un SHA-256 en hexadecimal minúscula (64 caracteres)',
        );
      }
      return { hashDocumento: d.hashDocumento };
    }
    if (d.hashDocumento !== undefined && d.hashDocumento !== null) {
      throw invalido('una firma con archivo no lleva hashDocumento: su huella es la del archivo');
    }
    if (typeof d.archivoId !== 'string' || !UUID_RE.test(d.archivoId)) {
      throw invalido(`una firma ${metodo} necesita el archivoId del documento firmado`);
    }
    const archivo = await tx.idArchivo.findUnique({
      where: { id: d.archivoId },
      select: { id: true, eliminadoAt: true },
    });
    if (!archivo || archivo.eliminadoAt)
      throw invalido('el archivo firmado no existe o fue eliminado');
    return { archivoId: archivo.id };
  }
}
