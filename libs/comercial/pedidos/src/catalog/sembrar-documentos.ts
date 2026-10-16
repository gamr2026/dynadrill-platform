import { uuidv7 } from '@dyn/utils';
import { PrismaClient } from '../generated/client';

type Cliente = Pick<PrismaClient, 'documento' | 'secuencia' | 'lugarDespacho'>;

export interface OpcionesSemilla {
  /** Último `codigo` de pedido del portal ya usado; el siguiente será este + 1. */
  ultimoCodigoPedido?: number;
  /** Último `PEC-` conocido de AS2 (hoja Secuencias del 13/10/2026: 4674). */
  ultimoPecAs2?: number;
  /** Último `PRC-` (prefactura / ticket) conocido de AS2 (hoja Secuencias del 15/10/2026: 4530). */
  ultimoPrcAs2?: number;
  /** Último número de guía de remisión usado (control manual de Dynadrill: 11035). */
  ultimaGuiaRemision?: number;
  /** Última OT emitida (control manual de Dynadrill: 947). */
  ultimaOrdenTrabajo?: number;
}

/**
 * Documentos y secuenciales iniciales del ciclo comercial. Idempotente: si el documento ya existe NO se toca (no deshace
 * lo que un administrador haya ajustado). Devuelve los códigos de los documentos creados.
 *
 *  - `pedido`: la serie propia `PED-` con la que el portal numeró sus primeros pedidos (4317 en adelante). **Ya no se usa para
 *    pedidos nuevos**: desde el 16/10/2026 el código del pedido es el número del pedido de AS2 (`PEC-`, ver abajo); la serie
 *    queda para que los pedidos ya abiertos conserven su código.
 *  - `pedido_cliente_as2`: espejo del secuencial `PEDIDOS CLIENTES` de AS2 (`PEC-` + 6 dígitos = 10). **No lo emite el
 *    portal**: lo asigna AS2. La vigencia (9/10/2012 a 31/12/2020) está vencida y AS2 sigue emitiendo, por eso es
 *    informativa y `hacer_cumplir_vigencia` es falso.
 */
export async function sembrarDocumentos(db: Cliente, o: OpcionesSemilla = {}): Promise<string[]> {
  const creados: string[] = [];

  if (!(await db.documento.findUnique({ where: { codigo: 'pedido' }, select: { id: true } }))) {
    const id = uuidv7();
    await db.documento.create({
      data: { id, codigo: 'pedido', nombre: 'Pedido (código del portal)', emitePortal: true },
    });
    await db.secuencia.create({
      data: {
        id: uuidv7(),
        documentoId: id,
        prefijo: 'PED-',
        longitud: 10,
        rangoDesde: 1,
        rangoHasta: 999999,
        numeroActual: o.ultimoCodigoPedido ?? 4316,
        reinicio: 'nunca',
        origen: 'portal',
      },
    });
    creados.push('pedido');
  }

  if (
    !(await db.documento.findUnique({
      where: { codigo: 'pedido_cliente_as2' },
      select: { id: true },
    }))
  ) {
    const id = uuidv7();
    const pec = o.ultimoPecAs2 ?? 4674;
    await db.documento.create({
      data: {
        id,
        codigo: 'pedido_cliente_as2',
        nombre: 'Pedido de cliente en AS2 (PEC-)',
        nombreAs2: 'PEDIDOS CLIENTES',
        emitePortal: false,
      },
    });
    await db.secuencia.create({
      data: {
        id: uuidv7(),
        documentoId: id,
        prefijo: 'PEC-',
        longitud: 10,
        rangoDesde: 1,
        rangoHasta: 999999,
        numeroActual: pec,
        vigenciaDesde: new Date('2012-10-09T00:00:00.000Z'),
        vigenciaHasta: new Date('2020-12-31T00:00:00.000Z'),
        hacerCumplirVigencia: false,
        reinicio: 'nunca',
        origen: 'as2',
        as2NumeroActual: pec,
        as2SincronizadoAt: new Date(),
      },
    });
    creados.push('pedido_cliente_as2');
  }

  // Guía de remisión: la numera el portal con su propio secuencial (`003-001-` + 7 dígitos). El número se puede reasignar
  // con motivo. Continúa desde el último número del control manual (11035).
  if (
    !(await db.documento.findUnique({ where: { codigo: 'guia_remision' }, select: { id: true } }))
  ) {
    const id = uuidv7();
    await db.documento.create({
      data: { id, codigo: 'guia_remision', nombre: 'Guía de remisión', emitePortal: true },
    });
    await db.secuencia.create({
      data: {
        id: uuidv7(),
        documentoId: id,
        prefijo: '003-001-',
        longitud: 15,
        rangoDesde: 1,
        rangoHasta: 9999999,
        numeroActual: o.ultimaGuiaRemision ?? 11035,
        // Autorización del SRI impresa en la guía (dato del formato DYN-AFN-RE-013; pendiente de confirmar con Dynadrill, G2).
        vigenciaDesde: new Date('2026-02-12T00:00:00.000Z'),
        vigenciaHasta: new Date('2027-02-12T00:00:00.000Z'),
        autorizacionNumero: '1133274030',
        hacerCumplirVigencia: false,
        reinicio: 'nunca',
        origen: 'portal',
      },
    });
    creados.push('guia_remision');
  }

  // La secuencia de guías ya existente recibe la autorización si todavía no la tiene.
  const guiaSec = await db.secuencia.findFirst({
    where: { documento: { codigo: 'guia_remision' }, autorizacionNumero: null },
    select: { id: true },
  });
  if (guiaSec) {
    await db.secuencia.update({
      where: { id: guiaSec.id },
      data: {
        vigenciaDesde: new Date('2026-02-12T00:00:00.000Z'),
        vigenciaHasta: new Date('2027-02-12T00:00:00.000Z'),
        autorizacionNumero: '1133274030',
      },
    });
  }

  // Orden de trabajo: secuencial propio que NO se reinicia (decisión de Dynadrill, 15/10/2026); sin prefijo ni relleno:
  // el número va dentro de `{n}-OPR-{pozo}-{ciudad}-{año}`.
  if (
    !(await db.documento.findUnique({ where: { codigo: 'orden_trabajo' }, select: { id: true } }))
  ) {
    const id = uuidv7();
    await db.documento.create({
      data: { id, codigo: 'orden_trabajo', nombre: 'Orden de trabajo', emitePortal: true },
    });
    await db.secuencia.create({
      data: {
        id: uuidv7(),
        documentoId: id,
        longitud: 0,
        rangoDesde: 1,
        rangoHasta: 999999,
        numeroActual: o.ultimaOrdenTrabajo ?? 947,
        hacerCumplirVigencia: false,
        reinicio: 'nunca',
        origen: 'portal',
      },
    });
    creados.push('orden_trabajo');
  }

  // Lugar de despacho inicial; el resto se agrega desde la pantalla de guías.
  if (!(await db.lugarDespacho.findFirst({ select: { id: true } }))) {
    await db.lugarDespacho.create({ data: { id: uuidv7(), nombre: 'Base Dynadrill' } });
  }

  // El ticket de Dynadrill ES la prefactura: su número es el que AS2 le asigna (`PRC-`, longitud 9 con el prefijo).
  // Como el pedido, es un espejo: el portal no lo emite, registra el que AS2 entrega. Cada documento lleva su propia
  // secuencia (el pedido del portal, el PEC- y el PRC- ya no se intentan mantener iguales).
  if (!(await db.documento.findUnique({ where: { codigo: 'prefactura' }, select: { id: true } }))) {
    const id = uuidv7();
    const prc = o.ultimoPrcAs2 ?? 4530;
    await db.documento.create({
      data: {
        id,
        codigo: 'prefactura',
        nombre: 'Prefactura / ticket (PRC-)',
        nombreAs2: 'PREFACTURA',
        emitePortal: false,
      },
    });
    await db.secuencia.create({
      data: {
        id: uuidv7(),
        documentoId: id,
        prefijo: 'PRC-',
        longitud: 9,
        rangoDesde: 1,
        rangoHasta: 999999999,
        numeroActual: prc,
        vigenciaDesde: new Date('2018-01-01T00:00:00.000Z'),
        vigenciaHasta: new Date('2050-12-31T00:00:00.000Z'),
        hacerCumplirVigencia: false,
        reinicio: 'nunca',
        origen: 'as2',
        as2NumeroActual: prc,
        as2SincronizadoAt: new Date(),
      },
    });
    creados.push('prefactura');
  }
  return creados;
}
