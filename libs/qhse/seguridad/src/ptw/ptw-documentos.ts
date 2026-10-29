import { TipoDocumentoPedido } from '../generated/client';
import type { Tx } from '../epi/epi-tipos';

/** Consecutivo visible del PTW: PTW-000001. */
export const codigoPtw = (numero: number): string => `PTW-${String(numero).padStart(6, '0')}`;

export const aDia = (d: Date): string => d.toISOString().slice(0, 10);

/** Los cuatro documentos que se reúnen en la gabinete, con el campo del PTW donde queda fijado cada uno. */
export const DOCUMENTOS_GABINETE = [
  {
    tipo: TipoDocumentoPedido.formato_recepcion,
    campo: 'documentoRecepcionId',
    nombre: 'Formato de recepción',
  },
  { tipo: TipoDocumentoPedido.art, campo: 'documentoArtId', nombre: 'ART' },
  { tipo: TipoDocumentoPedido.pt, campo: 'documentoPtId', nombre: 'PT' },
  { tipo: TipoDocumentoPedido.sfi, campo: 'documentoSfiId', nombre: 'SFI' },
] as const;

export interface RequisitoGabinete {
  tipo: TipoDocumentoPedido;
  nombre: string;
  /** Documento elegido (vigente y que sirve para ese día); `null` si falta. */
  documentoId: string | null;
  archivoId: string | null;
  /** Por qué no se cumple, en una frase para el usuario. */
  falta: string | null;
}

/**
 * Qué documento del pedido sirve para el PTW de un día: el formato de recepción y el SFI vigentes más recientes; el ART que cubra el día
 * (15 días desde su emisión; un ART vencido bloquea); y el PT de ese día. Se calcula siempre contra `documento_pedido` (no se copia nada).
 */
export async function requisitosDeGabinete(
  tx: Pick<Tx, 'documentoPedido'>,
  pedidoId: string,
  dia: Date,
): Promise<RequisitoGabinete[]> {
  const docs = await tx.documentoPedido.findMany({
    where: { pedidoId, anuladoAt: null },
    select: {
      id: true,
      tipo: true,
      archivoId: true,
      fecha: true,
      vigenteHasta: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'desc' },
  });
  const del = (tipo: TipoDocumentoPedido) => docs.filter((d) => d.tipo === tipo);
  const diaTexto = aDia(dia);

  return DOCUMENTOS_GABINETE.map(({ tipo, nombre }): RequisitoGabinete => {
    const ok = (d: { id: string; archivoId: string }): RequisitoGabinete => ({
      tipo,
      nombre,
      documentoId: d.id,
      archivoId: d.archivoId,
      falta: null,
    });
    const falta = (motivo: string): RequisitoGabinete => ({
      tipo,
      nombre,
      documentoId: null,
      archivoId: null,
      falta: motivo,
    });
    const candidatos = del(tipo);
    if (tipo === TipoDocumentoPedido.art) {
      const cubre = candidatos
        .filter(
          (d) =>
            d.fecha &&
            d.vigenteHasta &&
            aDia(d.fecha) <= diaTexto &&
            diaTexto <= aDia(d.vigenteHasta),
        )
        .sort((a, b) => (b.vigenteHasta as Date).getTime() - (a.vigenteHasta as Date).getTime())[0];
      if (cubre) return ok(cubre);
      const ultimo = candidatos
        .filter((d) => d.vigenteHasta)
        .sort((a, b) => (b.vigenteHasta as Date).getTime() - (a.vigenteHasta as Date).getTime())[0];
      if (!ultimo) return falta('No hay un ART cargado para este pedido');
      const desde = ultimo.fecha ? aDia(ultimo.fecha) : null;
      const hasta = aDia(ultimo.vigenteHasta as Date);
      // la vigencia es un rango: puede no cubrir el día porque ya venció o porque todavía no empieza
      const rango = desde ? `del ${desde} al ${hasta}` : `hasta el ${hasta}`;
      const porque =
        desde && diaTexto < desde
          ? 'todavía no empieza a regir'
          : diaTexto > hasta
            ? 'ya venció'
            : 'no cubre ese día';
      return falta(
        `El ART más reciente vale ${rango} y ${porque} para el ${diaTexto}: cargue un ART que cubra ese día (un ART vencido bloquea)`,
      );
    }
    if (tipo === TipoDocumentoPedido.pt) {
      const delDia = candidatos.find((d) => d.fecha && aDia(d.fecha) === diaTexto);
      return delDia ? ok(delDia) : falta(`No hay un PT cargado para el ${diaTexto}`);
    }
    return candidatos[0]
      ? ok(candidatos[0])
      : falta(`No hay ${nombre.toLowerCase()} cargado para este pedido`);
  });
}
