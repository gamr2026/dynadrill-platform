import { Injectable, NotFoundException } from '@nestjs/common';
import { aDia, diasHasta, hoyEcuador, masDias } from '../comun/fechas';
import { PrismaService } from '../prisma/prisma.service';

/** Consecutivo visible del desecho: DES-000001. */
export const codigoDesecho = (numero: number): string => `DES-${String(numero).padStart(6, '0')}`;

/** Plazo para tener el certificado de disposición final, contado desde el manifiesto. */
export const PLAZO_CERTIFICADO_DIAS = 30;

/** Las tres firmas del formato, en el orden en que se imprimen. */
export const ROLES_FIRMA = ['despachado_por', 'transportado_por', 'recibido_por'] as const;

/** Con cuántos días de anticipación se avisa que se acerca el límite de almacenamiento de 12 meses. */
export const DIAS_AVISO_LIMITE = 30;

export interface FiltroDesechos {
  estado?: string;
  /** `vencidos`: pasaron el límite sin disponer; `por_vencer`: les faltan {@link DIAS_AVISO_LIMITE} días o menos. */
  vencimiento?: 'vencidos' | 'por_vencer';
  q?: string;
}

/** Lectura de desechos: catálogos para el formulario, bandeja y detalle con los días que quedan al límite de 12 meses (AM 142). */
@Injectable()
export class DesechosConsultaService {
  constructor(private readonly prisma: PrismaService) {}

  /** Catálogos del formulario de registro (los usa quien reporta, aunque no vea la bandeja). */
  async catalogos() {
    const [caracteristicas, contenedores, pozos] = await Promise.all([
      this.prisma.desechoCaracteristica.findMany({
        where: { activo: true },
        orderBy: { orden: 'asc' },
        select: { id: true, codigo: true, nombre: true },
      }),
      this.prisma.desechoContenedor.findMany({
        where: { activo: true },
        orderBy: { orden: 'asc' },
        select: { id: true, codigo: true, nombre: true, uso: true },
      }),
      this.prisma.catPozo.findMany({
        where: { habilitado: true },
        orderBy: { nombreCompleto: 'asc' },
        select: { id: true, codigo: true, nombreCompleto: true },
      }),
    ]);
    return { caracteristicas, contenedores, pozos };
  }

  async listar(filtro: FiltroDesechos = {}) {
    const q = filtro.q?.trim();
    const hoy = hoyEcuador();
    const fecha = (dia: string) => new Date(`${dia}T00:00:00.000Z`);
    const vencimiento =
      filtro.vencimiento === 'vencidos'
        ? {
            estado: { codigo: { not: 'dispuesto' } },
            limiteAlmacenamientoHasta: { lt: fecha(hoy) },
          }
        : filtro.vencimiento === 'por_vencer'
          ? {
              estado: { codigo: { not: 'dispuesto' } },
              limiteAlmacenamientoHasta: {
                gte: fecha(hoy),
                lte: fecha(masDias(hoy, DIAS_AVISO_LIMITE)),
              },
            }
          : {};
    const filas = await this.prisma.desecho.findMany({
      where: {
        ...vencimiento,
        ...(filtro.estado ? { estado: { codigo: filtro.estado } } : {}),
        ...(q
          ? {
              OR: [
                { descripcion: { contains: q, mode: 'insensitive' } },
                { ubicacion: { contains: q, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      orderBy: { numero: 'desc' },
      include: {
        estado: { select: { codigo: true, nombre: true } },
        contenedor: { select: { codigo: true, nombre: true } },
        pozo: { select: { nombreCompleto: true } },
        caracteristicas: { include: { caracteristica: { select: { nombre: true } } } },
        _count: { select: { items: true } },
      },
      take: 300,
    });
    return filas.map((d) => this.resumen(d));
  }

  /** Tablero de desechos: cuántos hay por estado, cuántos se acercan al límite o lo pasaron y los galones sin disponer. */
  async tablero() {
    const hoy = hoyEcuador();
    const fecha = (dia: string) => new Date(`${dia}T00:00:00.000Z`);
    const abiertos = { estado: { codigo: { not: 'dispuesto' } } };
    const [porEstado, vencidos, porVencer, galones] = await Promise.all([
      this.prisma.desechoEstado.findMany({
        orderBy: { orden: 'asc' },
        select: { codigo: true, nombre: true, _count: { select: { desechos: true } } },
      }),
      this.prisma.desecho.count({
        where: { ...abiertos, limiteAlmacenamientoHasta: { lt: fecha(hoy) } },
      }),
      this.prisma.desecho.count({
        where: {
          ...abiertos,
          limiteAlmacenamientoHasta: {
            gte: fecha(hoy),
            lte: fecha(masDias(hoy, DIAS_AVISO_LIMITE)),
          },
        },
      }),
      this.prisma.desechoItem.aggregate({
        where: { desecho: abiertos },
        _sum: { cantidadGalones: true },
      }),
    ]);
    return {
      porEstado: porEstado.map((e) => ({
        codigo: e.codigo,
        nombre: e.nombre,
        cantidad: e._count.desechos,
      })),
      vencidos,
      porVencer,
      diasAviso: DIAS_AVISO_LIMITE,
      galonesSinDisponer: Number(galones._sum.cantidadGalones ?? 0),
    };
  }

  async detalle(id: string) {
    const d = await this.prisma.desecho.findUnique({
      where: { id },
      include: {
        estado: { select: { codigo: true, nombre: true } },
        contenedor: { select: { codigo: true, nombre: true, uso: true } },
        pozo: { select: { codigo: true, nombreCompleto: true } },
        caracteristicas: {
          include: { caracteristica: { select: { codigo: true, nombre: true } } },
        },
        items: { orderBy: { orden: 'asc' } },
        historial: {
          orderBy: { createdAt: 'asc' },
          include: { estadoNuevo: { select: { codigo: true, nombre: true } } },
        },
        manifiesto: { include: { firmas: true } },
        documentos: { orderBy: { createdAt: 'asc' } },
        _count: { select: { items: true } },
      },
    });
    if (!d) throw new NotFoundException('El desecho no existe');
    const m = d.manifiesto;
    const certificado = d.documentos.find((x) => x.tipo === 'certificado_disposicion');
    const abierto = d.estado.codigo !== 'dispuesto';
    const vence = m ? masDias(aDia(m.fecha), PLAZO_CERTIFICADO_DIAS) : '';
    const [nombres, cliente] = await Promise.all([
      this.nombres([
        d.createdBy,
        ...d.historial.map((h) => h.actorId),
        ...(m?.firmas.map((f) => f.registradoPor) ?? []),
      ]),
      m?.clienteId
        ? this.prisma.catCliente.findUnique({
            where: { id: m.clienteId },
            select: { nombreComercial: true, identificacion: true },
          })
        : null,
    ]);
    return {
      ...this.resumen(d),
      pozo: d.pozo ? { codigo: d.pozo.codigo, nombre: d.pozo.nombreCompleto } : null,
      generadoPor: nombres.get(d.createdBy) ?? null,
      items: d.items.map((i) => ({
        id: i.id,
        orden: i.orden,
        descripcion: i.descripcion,
        numeroLote: i.numeroLote,
        codigo: i.codigo,
        cantidadGalones: Number(i.cantidadGalones),
        bultos: i.bultos,
      })),
      totalGalones: d.items.reduce((t, i) => t + Number(i.cantidadGalones), 0),
      manifiesto: m
        ? {
            numero: m.numero,
            fecha: aDia(m.fecha),
            /** Plazo de 30 días desde el manifiesto para tener el certificado de disposición final. */
            certificadoVenceEl: vence,
            certificadoVencido: certificado ? false : abierto && hoyEcuador() > vence,
            certificadoFueraDePlazo: certificado?.emitidoEl
              ? aDia(certificado.emitidoEl) > vence
              : false,
            gestorNombre: m.gestorNombre,
            gestorLicenciaSuia: m.gestorLicenciaSuia,
            cliente: cliente
              ? { nombre: cliente.nombreComercial, identificacion: cliente.identificacion }
              : null,
            solicitadoPor: m.solicitadoPor,
            transportista: {
              compania: m.transportistaCompania,
              conductor: m.conductorNombre,
              cedulaConductor: m.conductorCedula,
              vehiculo: m.vehiculo,
              placas: m.placas,
            },
            horaSalida: m.horaSalida,
            horaLlegada: m.horaLlegada,
            firmas: ROLES_FIRMA.map((rol) => {
              const f = m.firmas.find((x) => x.rol === rol);
              return {
                rol,
                firmadoAt: f?.firmadoAt ?? null,
                registradoPor: f ? (nombres.get(f.registradoPor) ?? null) : null,
                firmanteNombre: f?.firmanteNombre ?? null,
                firmanteCedula: f?.firmanteCedula ?? null,
              };
            }),
            firmasCompletas: m.firmas.length === ROLES_FIRMA.length,
          }
        : null,
      documentos: d.documentos.map((x) => ({
        tipo: x.tipo,
        archivoId: x.archivoId,
        emitidoEl: x.emitidoEl ? aDia(x.emitidoEl) : null,
        referencia: x.referencia,
        /** Lectura automática de la firma (solo un indicador para revisar). */
        verificacion: x.verificacion,
        verificacionConfianza:
          x.verificacionConfianza === null ? null : Number(x.verificacionConfianza),
        verificacionAt: x.verificacionAt,
        cargadoAt: x.createdAt,
      })),
      historial: d.historial.map((h) => ({
        estado: h.estadoNuevo,
        actor: nombres.get(h.actorId) ?? null,
        at: h.createdAt,
      })),
    };
  }

  private resumen(d: {
    id: string;
    numero: number;
    clasificacion: string;
    descripcion: string;
    registradoAt: Date;
    limiteAlmacenamientoHasta: Date;
    estado: { codigo: string; nombre: string };
    contenedor: { codigo: string; nombre: string };
    pozo: { nombreCompleto: string } | null;
    caracteristicas: Array<{ caracteristica: { nombre: string } }>;
    _count: { items: number };
    ubicacion: string | null;
  }) {
    const limite = aDia(d.limiteAlmacenamientoHasta);
    const dias = diasHasta(limite);
    const abierto = d.estado.codigo !== 'dispuesto';
    return {
      id: d.id,
      numero: d.numero,
      codigo: codigoDesecho(d.numero),
      clasificacion: d.clasificacion,
      cretib: d.caracteristicas.map((c) => c.caracteristica.nombre),
      contenedor: d.contenedor,
      descripcion: d.descripcion,
      ubicacion: d.pozo?.nombreCompleto ?? d.ubicacion,
      estado: d.estado,
      items: d._count.items,
      registradoAt: d.registradoAt,
      limiteAlmacenamientoHasta: limite,
      /** Días que quedan al límite de 12 meses (negativo si ya pasó); nulo si ya fue dispuesto. */
      diasParaLimite: abierto ? dias : null,
      vencido: abierto && dias < 0,
    };
  }

  /** Nombre de cada cuenta (las columnas de personas no tienen relación de Prisma: ver schema.prisma). */
  private async nombres(ids: string[]): Promise<Map<string, string>> {
    const filas = await this.prisma.idUsuario.findMany({
      where: { id: { in: [...new Set(ids)] } },
      select: { id: true, nombre: true },
    });
    return new Map(filas.map((f) => [f.id, f.nombre]));
  }
}
