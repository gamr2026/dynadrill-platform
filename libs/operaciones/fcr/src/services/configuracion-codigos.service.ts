import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { AuthUser } from '@dyn/common';
import { uuidv7 } from '@dyn/utils';
import type { ClasificacionCodigo } from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';

export interface GuardarConfiguracionEntrada {
  clienteId: string;
  /** Código de la lista de precios del cliente. */
  codigo: string;
  clasificacion: ClasificacionCodigo;
  /** Solo para `herramienta`: los artículos del kit y cuántos de cada uno forman un juego. */
  kit: Array<{ articuloId: string; cantidad: number }>;
}

const INCLUIR = {
  kit: {
    include: { articulo: { select: { codigo: true, nombre: true, activo: true } } },
    orderBy: { articulo: { nombre: 'asc' } },
  },
} as const;

/**
 * Configuración por cliente y código (aparte de la lista de precios, que se recrea al importar): dice si un código es una herramienta
 * (con su kit de artículos de Inventario) o un servicio. La arma Ingeniería de Ventas desde «Códigos por cliente». Un código sin
 * configuración se trata como servicio. FCR no lee la lista de precios (es de `comercial`): la pantalla la trae de allá y la cruza
 * con lo que este servicio devuelve; las configuraciones cuyo código ya no esté en la lista quedan «huérfanas» y se ven como tales.
 */
@Injectable()
export class ConfiguracionCodigosService {
  constructor(private readonly prisma: PrismaService) {}

  async listar(clienteId: string) {
    const filas = await this.prisma.configuracionCodigo.findMany({
      where: { clienteId },
      include: INCLUIR,
      orderBy: { codigo: 'asc' },
    });
    return filas.map((c) => this.vista(c));
  }

  /** Crea o reemplaza la configuración de un código (el kit se reemplaza completo). */
  async guardar(e: GuardarConfiguracionEntrada, actor: AuthUser) {
    const codigo = e.codigo?.trim();
    if (!codigo) throw new BadRequestException('Indique el código');
    if (e.clasificacion === 'servicio' && e.kit.length) {
      throw new BadRequestException('Solo un código de herramienta lleva kit');
    }
    const ids = e.kit.map((k) => k.articuloId);
    if (new Set(ids).size !== ids.length) {
      throw new BadRequestException(
        'Un artículo no puede repetirse en el kit: sume sus cantidades',
      );
    }
    const id = await this.prisma.$transaction(async (tx) => {
      if (!(await tx.catCliente.findUnique({ where: { id: e.clienteId }, select: { id: true } }))) {
        throw new BadRequestException('El cliente no existe');
      }
      // los artículos del kit: herramientas activas del inventario (además, la base lo exige)
      if (ids.length) {
        const validos = await tx.invArticulo.findMany({
          where: { id: { in: ids }, activo: true, categoria: { llevaPartes: true } },
          select: { id: true },
        });
        if (validos.length !== ids.length) {
          throw new BadRequestException(
            'Alguno de los artículos del kit no es una herramienta activa del inventario (categoría con partes)',
          );
        }
      }
      const previa = await tx.configuracionCodigo.findUnique({
        where: { clienteId_codigo: { clienteId: e.clienteId, codigo } },
        select: { id: true },
      });
      const configId = previa?.id ?? uuidv7();
      // el kit se vacía antes de cambiar la clasificación: la base no deja un kit en un código de servicio
      if (previa)
        await tx.configuracionCodigoKit.deleteMany({ where: { configuracionId: configId } });
      if (previa) {
        await tx.configuracionCodigo.update({
          where: { id: configId },
          data: { clasificacion: e.clasificacion, updatedBy: actor.id },
        });
      } else {
        await tx.configuracionCodigo.create({
          data: {
            id: configId,
            clienteId: e.clienteId,
            codigo,
            clasificacion: e.clasificacion,
            createdBy: actor.id,
            updatedBy: actor.id,
          },
        });
      }
      if (e.kit.length) {
        await tx.configuracionCodigoKit.createMany({
          data: e.kit.map((k) => ({
            configuracionId: configId,
            articuloId: k.articuloId,
            cantidad: k.cantidad,
            createdBy: actor.id,
          })),
        });
      }
      return configId;
    });
    const c = await this.prisma.configuracionCodigo.findUniqueOrThrow({
      where: { id },
      include: INCLUIR,
    });
    return this.vista(c);
  }

  async eliminar(id: string): Promise<void> {
    if (
      !(await this.prisma.configuracionCodigo.findUnique({ where: { id }, select: { id: true } }))
    ) {
      throw new NotFoundException('La configuración no existe');
    }
    await this.prisma.configuracionCodigo.delete({ where: { id } });
  }

  private vista(c: {
    id: string;
    clienteId: string;
    codigo: string;
    clasificacion: ClasificacionCodigo;
    updatedAt: Date;
    kit: Array<{
      articuloId: string;
      cantidad: number;
      articulo: { codigo: string; nombre: string; activo: boolean };
    }>;
  }) {
    return {
      id: c.id,
      clienteId: c.clienteId,
      codigo: c.codigo,
      clasificacion: c.clasificacion,
      updatedAt: c.updatedAt,
      kit: c.kit.map((k) => ({
        articuloId: k.articuloId,
        codigo: k.articulo.codigo,
        nombre: k.articulo.nombre,
        activo: k.articulo.activo,
        cantidad: k.cantidad,
      })),
    };
  }
}
