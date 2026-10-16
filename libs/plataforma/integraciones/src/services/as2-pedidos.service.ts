import { Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { As2PedidosQueryDto } from '../dto/as2-pedidos.dto';
import { IntegracionError, MotorService } from './motor.service';

type Fila = Record<string, unknown>;
type Pedido = {
  idPedidoCliente: number;
  numero: string | null;
  fecha: string | null;
  estado: string | null;
  total: number;
  descuento: number;
  impuesto: number;
  descripcion: string | null;
  empresaNombre: string | null;
  empresaIdentificacion: string | null;
  bodega: string | null;
  condicionPago: string | null;
  zona: string | null;
  lineasEstado: 'con_lineas' | 'sin_lineas';
  lineas?: Array<{
    codigo: string | null;
    nombre: string | null;
    cantidad: number;
    precio: number;
  }>;
};

const PROVEEDOR = 'as2';
const CONCURRENCIA = 5;
const TTL_MS = 2 * 60_000;
/** Tope de filas de AS2 que se revisan para llenar una página cuando se filtra por líneas. */
const MAX_BARRIDO = 400;
/** AS2 no devuelve líneas de los pedidos ELABORADO por API: no se consultan. */
const SIN_LINEAS_POR_API = 'ELABORADO';

const dia = (v: unknown): string | null =>
  v instanceof Date ? v.toISOString().slice(0, 10) : null;
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const txt = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/**
 * Lectura de los pedidos de cliente de AS2 (solo del año, solo lectura). Nada se guarda: cada consulta va a AS2 y
 * solo se recuerda, unos minutos y en memoria, si un pedido tiene o no líneas, para no repetir consultas.
 * Las líneas se piden solo de la página que se muestra (no de todo el año).
 */
@Injectable()
export class As2PedidosService {
  private readonly indicador = new Map<number, { conLineas: boolean; hasta: number }>();
  private idsCache: { filas: Fila[]; hasta: number } | null = null;

  constructor(private readonly motor: MotorService) {}

  async listar(q: As2PedidosQueryDto) {
    const page = q.page ?? 1;
    const limit = q.limit ?? 10;
    const estado = q.estado?.toUpperCase();
    const texto = q.q?.replace(/[%_]/g, ' ').trim();
    const desde = (page - 1) * limit;

    // Sin filtro de líneas: una consulta de una página (+1 fila para saber si hay más).
    if (!q.lineas) {
      const filas = await this.pagina({ desde, tamano: limit + 1, estado, texto });
      const hayMas = filas.length > limit;
      const items = await this.conIndicador(filas.slice(0, limit));
      return { page, limit, hayMas, total: await this.totalSiAplica(estado, texto), items };
    }

    // Con filtro de líneas: se barren páginas de AS2 hacia adelante hasta llenar la página pedida.
    const necesarios = page * limit + 1;
    const coincidentes: Pedido[] = [];
    let cursor = 0;
    while (coincidentes.length < necesarios && cursor < MAX_BARRIDO) {
      // "con" nunca incluye ELABORADO: se excluyen de la consulta para no recorrerlos.
      const filas = await this.pagina({
        desde: cursor,
        tamano: limit * 2,
        estado,
        texto,
        sinElaborados: q.lineas === 'con' && !estado,
      });
      if (!filas.length) break;
      const completos = await this.conIndicador(filas);
      for (const p of completos) {
        if ((q.lineas === 'con') === (p.lineasEstado === 'con_lineas')) coincidentes.push(p);
      }
      cursor += filas.length;
      if (filas.length < limit * 2) break;
    }
    return {
      page,
      limit,
      hayMas: coincidentes.length > page * limit,
      total: null,
      items: coincidentes.slice(desde, desde + limit),
    };
  }

  async detalle(id: number) {
    const filas = await this.ejecutar('pedido_por_id', { id });
    if (!filas.length) throw new NotFoundException('El pedido no existe en AS2');
    const base = this.aPedido(filas[0]);
    const lineas =
      base.estado === SIN_LINEAS_POR_API ? [] : await this.ejecutar('lineas_pedido', { id });
    const pedido: Pedido = {
      ...base,
      lineasEstado: lineas.length ? 'con_lineas' : 'sin_lineas',
      lineas: lineas.map((l) => ({
        codigo: txt(l['codigo']),
        nombre: txt(l['nombre']),
        cantidad: num(l['cantidad']),
        precio: num(l['precio']),
      })),
    };
    this.indicador.set(id, { conLineas: lineas.length > 0, hasta: Date.now() + TTL_MS });
    return pedido;
  }

  /** Cuántos pedidos hay en el año, por estado (para los filtros de la pantalla). */
  async resumen() {
    const filas = await this.ids();
    const porEstado: Record<string, number> = {};
    for (const f of filas) {
      const e = txt(f['estado']) ?? 'SIN_ESTADO';
      porEstado[e] = (porEstado[e] ?? 0) + 1;
    }
    return { total: filas.length, porEstado };
  }

  // ----------------------------------------------------------------------------------------------------------

  private async pagina(o: {
    desde: number;
    tamano: number;
    estado?: string;
    texto?: string;
    sinElaborados?: boolean;
  }): Promise<Fila[]> {
    const base = { desde: o.desde, tamano: o.tamano };
    if (o.texto) {
      const filas = await this.ejecutar('pedidos_buscar_texto', { ...base, texto: o.texto });
      return o.estado ? filas.filter((f) => f['estado'] === o.estado) : filas;
    }
    if (o.estado)
      return this.ejecutar('pedidos_pagina_estado', { ...base, operador: '=', estado: o.estado });
    if (o.sinElaborados)
      return this.ejecutar('pedidos_pagina_estado', {
        ...base,
        operador: '!=',
        estado: SIN_LINEAS_POR_API,
      });
    return this.ejecutar('pedidos_pagina', base);
  }

  /** Total solo cuando es barato y exacto: sin texto de búsqueda. */
  private async totalSiAplica(estado?: string, texto?: string): Promise<number | null> {
    if (texto) return null;
    const filas = await this.ids();
    return estado ? filas.filter((f) => f['estado'] === estado).length : filas.length;
  }

  private async ids(): Promise<Fila[]> {
    if (this.idsCache && this.idsCache.hasta > Date.now()) return this.idsCache.filas;
    const filas = await this.ejecutar('pedidos_ids', {});
    this.idsCache = { filas, hasta: Date.now() + TTL_MS };
    return filas;
  }

  /** Agrega el indicador con/sin líneas a cada pedido; consulta a AS2 solo los que no se conocen. */
  private async conIndicador(filas: Fila[]): Promise<Pedido[]> {
    const pedidos = filas.map((f) => this.aPedido(f));
    const ahora = Date.now();
    const pendientes = pedidos.filter((p) => {
      if (p.estado === SIN_LINEAS_POR_API) return false;
      const c = this.indicador.get(p.idPedidoCliente);
      return !c || c.hasta < ahora;
    });
    await this.enLotes(pendientes, async (p) => {
      const lineas = await this.ejecutar('lineas_pedido', { id: p.idPedidoCliente });
      this.indicador.set(p.idPedidoCliente, {
        conLineas: lineas.length > 0,
        hasta: ahora + TTL_MS,
      });
    });
    return pedidos.map((p) => ({
      ...p,
      lineasEstado:
        p.estado !== SIN_LINEAS_POR_API && this.indicador.get(p.idPedidoCliente)?.conLineas
          ? 'con_lineas'
          : 'sin_lineas',
    }));
  }

  private async enLotes<T>(items: T[], f: (x: T) => Promise<void>) {
    for (let i = 0; i < items.length; i += CONCURRENCIA) {
      await Promise.all(items.slice(i, i + CONCURRENCIA).map(f));
    }
  }

  private aPedido(f: Fila): Pedido {
    return {
      idPedidoCliente: Number(f['idPedidoCliente']),
      numero: txt(f['numero']),
      fecha: dia(f['fecha']),
      estado: txt(f['estado']),
      total: num(f['total']),
      descuento: num(f['descuento']),
      impuesto: num(f['impuesto']),
      descripcion: txt(f['descripcion']),
      empresaNombre: txt(f['empresaNombre']),
      empresaIdentificacion: txt(f['empresaIdentificacion']),
      bodega: txt(f['bodega']),
      condicionPago: txt(f['condicionPago']),
      zona: null,
      lineasEstado: 'sin_lineas',
    };
  }

  private async ejecutar(operacion: string, param: Record<string, unknown>): Promise<Fila[]> {
    try {
      return (await this.motor.ejecutar(PROVEEDOR, operacion, { param })).registros;
    } catch (e) {
      if (e instanceof IntegracionError)
        throw new ServiceUnavailableException('AS2 no está disponible en este momento');
      throw e;
    }
  }
}
