import { Injectable } from '@nestjs/common';
import { uuidv7 } from '@dyn/utils';
import type { MotivoAvisoPrecarga, Prisma, TipoLinea } from '../generated/client';
import { clavesDeUnidad } from './herramienta-estado';

/** Una línea cotizada del pedido, tal como la publica `comercial` en sus eventos. */
export interface LineaPedido {
  codigo: string;
  descripcion: string;
  unidad: string;
  cantidad: number;
  tipoLinea: string;
}

const TIPOS_LINEA: readonly string[] = ['servicio', 'material', 'herramienta', 'movilizacion'];

interface AvisoDef {
  motivo: MotivoAvisoPrecarga;
  codigo?: string;
  descripcion?: string;
  articuloId?: string;
}

/**
 * Precarga de herramientas del ticket desde las líneas del pedido (spec `fcr-precarga-herramientas`): cada línea es un CÓDIGO de la lista
 * de precios, no una herramienta. La configuración por cliente y código dice si es herramienta y de qué kit de artículos está hecha.
 *  - Un juego del kit por unidad cotizada (2 corridas = 2 juegos), salvo que la unidad sea de tiempo (día, hora, mes, semana): 1 juego.
 *  - Cada herramienta física es una fila (un kit con 2 cepillos y 2 juegos son 4 filas), porque Bodega y Recepción marcan por herramienta.
 *  - La movilización la marca el pedido (tipo de línea) y no genera herramientas.
 *  - Lo que no se puede resolver queda como aviso para el Supervisor, nunca como un fallo.
 */
@Injectable()
export class PrecargaService {
  /** Reemplaza las líneas cotizadas del ticket por las vigentes del pedido (copia de otro contenedor). */
  async guardarLineas(
    tx: Prisma.TransactionClient,
    ticketId: string,
    lineas: LineaPedido[],
  ): Promise<number> {
    await tx.ticketLinea.deleteMany({ where: { ticketId } });
    const validas = lineas.filter(
      (l) =>
        typeof l.codigo === 'string' &&
        l.codigo.trim() &&
        Number(l.cantidad) > 0 &&
        TIPOS_LINEA.includes(l.tipoLinea),
    );
    if (!validas.length) return 0;
    await tx.ticketLinea.createMany({
      data: validas.map((l, i) => ({
        id: uuidv7(),
        ticketId,
        orden: i + 1,
        codigo: l.codigo.trim(),
        descripcion: String(l.descripcion ?? '').trim() || l.codigo.trim(),
        unidad: String(l.unidad ?? '').trim() || 'unidad',
        cantidad: Number(l.cantidad),
        tipoLinea: l.tipoLinea as TipoLinea,
      })),
    });
    return validas.length;
  }

  /**
   * Arma las herramientas del ticket desde sus líneas. Sirve para la precarga inicial y para «Recargar desde el pedido»: quita solo
   * las herramientas del pedido que aún no se solicitaron a Bodega (no tienen historia), conserva las demás y agrega las que falten.
   * Las agregadas a mano no se tocan. Reemplaza los avisos.
   */
  async armar(
    tx: Prisma.TransactionClient,
    ticketId: string,
    actorId: string | null,
  ): Promise<{ agregadas: number; quitadas: number; avisos: number }> {
    const ticket = await tx.ticket.findUniqueOrThrow({
      where: { id: ticketId },
      select: { clienteId: true },
    });
    await tx.ticketAvisoPrecarga.deleteMany({ where: { ticketId } });
    const lineas = await tx.ticketLinea.findMany({
      where: { ticketId },
      orderBy: { orden: 'asc' },
    });
    const avisos: AvisoDef[] = [];
    // lo que el pedido pide hoy: herramientas por (código de línea, artículo)
    const deseadas = new Map<
      string,
      { codigoPedido: string; articuloId: string; cantidad: number }
    >();

    if (!ticket.clienteId) {
      for (const l of lineas.filter((x) => x.tipoLinea === 'herramienta')) {
        avisos.push({ motivo: 'pedido_sin_cliente', codigo: l.codigo, descripcion: l.descripcion });
      }
    } else {
      const configs = await tx.configuracionCodigo.findMany({
        where: {
          clienteId: ticket.clienteId,
          codigo: { in: [...new Set(lineas.map((l) => l.codigo))] },
        },
        include: {
          kit: {
            include: {
              articulo: { select: { activo: true, categoria: { select: { llevaPartes: true } } } },
            },
          },
        },
      });
      const porCodigo = new Map(configs.map((c) => [c.codigo, c]));
      const unidades = new Map(
        (await tx.unidadCotizacion.findMany({ where: { activo: true } })).map((u) => [
          u.codigo,
          u.esTiempo,
        ]),
      );
      const esDeTiempo = (unidad: string) =>
        clavesDeUnidad(unidad).some((c) => unidades.get(c) === true);

      for (const l of lineas) {
        // la movilización la marca el pedido: se muestra aparte y no pide herramientas
        if (l.tipoLinea === 'movilizacion') continue;
        const cfg = porCodigo.get(l.codigo);
        if (!cfg) {
          if (l.tipoLinea === 'herramienta')
            avisos.push({ motivo: 'sin_configurar', codigo: l.codigo, descripcion: l.descripcion });
          continue;
        }
        if (cfg.clasificacion !== 'herramienta') continue;
        if (!cfg.kit.length) {
          avisos.push({ motivo: 'kit_vacio', codigo: l.codigo, descripcion: l.descripcion });
          continue;
        }
        const juegos = esDeTiempo(l.unidad) ? 1 : Math.max(1, Math.ceil(Number(l.cantidad)));
        for (const k of cfg.kit) {
          // un artículo dado de baja, o que ya no es de una categoría de herramientas, no se puede pedir
          if (!k.articulo.activo || !k.articulo.categoria.llevaPartes) {
            avisos.push({
              motivo: 'articulo_inactivo',
              codigo: l.codigo,
              descripcion: l.descripcion,
              articuloId: k.articuloId,
            });
            continue;
          }
          const clave = `${l.codigo}|${k.articuloId}`;
          const previo = deseadas.get(clave);
          deseadas.set(clave, {
            codigoPedido: l.codigo,
            articuloId: k.articuloId,
            cantidad: (previo?.cantidad ?? 0) + k.cantidad * juegos,
          });
        }
      }
    }

    // sin historia (nunca solicitadas) se pueden quitar; las demás cuentan como ya cargadas
    const quitadas = await tx.ticketHerramienta.deleteMany({
      where: { ticketId, origen: 'pedido', solicitadaAt: null },
    });
    const conservadas = await tx.ticketHerramienta.groupBy({
      by: ['codigoPedido', 'articuloId'],
      where: { ticketId, origen: 'pedido' },
      _count: { _all: true },
    });
    const yaHay = new Map(
      conservadas.map((c) => [`${c.codigoPedido}|${c.articuloId}`, c._count._all]),
    );
    const nuevas: Prisma.TicketHerramientaCreateManyInput[] = [];
    for (const [clave, d] of deseadas) {
      const faltan = d.cantidad - (yaHay.get(clave) ?? 0);
      for (let i = 0; i < faltan; i++) {
        nuevas.push({
          id: uuidv7(),
          ticketId,
          articuloId: d.articuloId,
          origen: 'pedido',
          codigoPedido: d.codigoPedido,
          createdBy: actorId,
          updatedBy: actorId,
        });
      }
    }
    if (nuevas.length) await tx.ticketHerramienta.createMany({ data: nuevas });
    if (avisos.length) {
      await tx.ticketAvisoPrecarga.createMany({
        data: avisos.map((a) => ({ id: uuidv7(), ticketId, ...a })),
      });
    }
    return { agregadas: nuevas.length, quitadas: quitadas.count, avisos: avisos.length };
  }
}
