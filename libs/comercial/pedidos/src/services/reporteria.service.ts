import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { importesItem, nombreCliente } from './pedido-mapper';

/** Estados del pedido cuyas fechas usa la reportería (los días de prefacturación y de firma salen de aquí). */
const ESTADOS_CON_HITO = ['documentos_completos', 'enviado_para_firmas', 'ticket_firmado'] as const;
/** La prefactura que cuenta para el pedido: una rechazada o anulada se conserva, pero ya no es la vigente. */
const VIGENTES = ['generada', 'enviada_para_firmas', 'firmada'] as const;

const redondeo = (n: number) => Math.round(n * 100) / 100;
const dia = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

/**
 * Base de la reportería de Facturación: UNA fila por pedido (sin los borradores) con lo que necesitan las pestañas (ventas por mes,
 * por pozo y tipo de servicio, estado por cliente, cotizado vs. real, control de tickets, servicio vs. venta y el secuencial de tickets).
 * El frontend arma los cortes; aquí solo se juntan los datos de los pedidos, sus prefacturas, guías, órdenes de trabajo y las fechas de
 * los hitos del seguimiento (la última vez que el pedido llegó a cada estado).
 */
@Injectable()
export class ReporteriaService {
  constructor(private readonly prisma: PrismaService) {}

  async pedidos() {
    const pedidos = await this.prisma.pedido.findMany({
      where: { estado: { not: 'borrador' } },
      include: {
        cliente: true,
        campo: true,
        bloque: true,
        pozo: true,
        taladro: true,
        agenteComercial: true,
        analistaFacturacion: true,
        representanteCampo: true,
        representanteQuito: true,
        estadoRef: true,
        linea: true,
        tipoOt: true,
        tiposServicio: { include: { tipo: true } },
        items: { orderBy: { orden: 'asc' } },
        ordenTrabajo: { select: { numero: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    const ids = pedidos.map((p) => p.id);
    const [historial, prefacturas, guias] = await Promise.all([
      this.prisma.procesoHistorial.findMany({
        where: {
          proceso: 'pedido',
          entidadId: { in: ids },
          estadoNuevo: { in: [...ESTADOS_CON_HITO] },
        },
        select: { entidadId: true, estadoNuevo: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.prefactura.findMany({
        where: { pedidoId: { in: ids }, estado: { in: [...VIGENTES] } },
        select: {
          id: true,
          pedidoId: true,
          estado: true,
          version: true,
          subtotal: true,
          netoCobrar: true,
          generadaAt: true,
          firmadaAt: true,
        },
        orderBy: { version: 'desc' },
      }),
      this.prisma.guiaRemision.findMany({
        where: { pedidoId: { in: ids }, estado: 'emitida' },
        select: { pedidoId: true, codigo: true },
        orderBy: { numero: 'desc' },
      }),
    ]);

    // la última vez que el pedido llegó a cada estado (el historial viene del más antiguo al más reciente)
    const hitos = new Map<string, Record<string, string>>();
    for (const h of historial) {
      const m = hitos.get(h.entidadId) ?? {};
      m[h.estadoNuevo] = h.createdAt.toISOString();
      hitos.set(h.entidadId, m);
    }
    const prefacturaDe = new Map<string, (typeof prefacturas)[number]>();
    for (const pf of prefacturas)
      if (!prefacturaDe.has(pf.pedidoId)) prefacturaDe.set(pf.pedidoId, pf);
    const guiaDe = new Map<string, string>();
    for (const g of guias) if (!guiaDe.has(g.pedidoId)) guiaDe.set(g.pedidoId, g.codigo);

    return pedidos.map((p) => {
      const h = hitos.get(p.id) ?? {};
      const pf = prefacturaDe.get(p.id);
      return {
        pedidoId: p.id,
        codigo: p.codigo,
        ticketNumero: p.ticketNumero,
        clienteNombre: nombreCliente(p),
        lineaServicio: p.linea?.codigo ?? null,
        tipoOt: p.tipoOt?.codigo ?? null,
        tiposServicio: p.tiposServicio.map((t) => t.tipo.nombre),
        campoNombre: p.campo?.nombre ?? null,
        bloqueNombre: p.bloque?.nombre ?? null,
        pozoNombre: p.pozo?.nombreCompleto ?? null,
        taladroNombre: p.rigless ? 'Rigless' : (p.taladro?.nombre ?? null),
        fechaInicioServicio: dia(p.fechaInicioServicio),
        fechaFinServicio: dia(p.fechaFinServicio),
        analistaNombre: p.analistaFacturacion?.nombre ?? null,
        agenteComercialNombre: p.agenteComercial?.nombre ?? null,
        representanteCampoNombre: p.representanteCampo?.nombre ?? null,
        representanteQuitoNombre: p.representanteQuito?.nombre ?? null,
        estado: p.estado,
        estadoNombre: p.estadoRef.nombre,
        descripcionBreve: p.items[0]?.descripcion ?? null,
        /** Lo cotizado por Ventas: la suma neta de los ítems del pedido. */
        cotizado: redondeo(p.items.reduce((a, i) => a + importesItem(i).neto, 0)),
        ordenTrabajoNumero: p.ordenTrabajo?.numero ?? null,
        guiaCodigo: guiaDe.get(p.id) ?? null,
        documentosCompletosAt: h['documentos_completos'] ?? null,
        enviadoParaFirmasAt: h['enviado_para_firmas'] ?? null,
        ticketFirmadoAt: h['ticket_firmado'] ?? null,
        prefactura: pf
          ? {
              id: pf.id,
              estado: pf.estado,
              version: pf.version,
              subtotal: Number(pf.subtotal),
              netoCobrar: Number(pf.netoCobrar),
              generadaAt: pf.generadaAt,
              firmadaAt: pf.firmadaAt,
            }
          : null,
      };
    });
  }
}
