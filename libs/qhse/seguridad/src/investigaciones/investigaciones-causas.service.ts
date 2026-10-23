import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { type AuthUser } from '@dyn/common';
import { uuidv7 } from '@dyn/utils';
import { texto, type Tx } from '../epi/epi-tipos';
import { EstadoInvestigacion, TipoCausaInvestigacion } from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';
import { InvestigacionesConsultaService } from './investigaciones-consulta.service';

export interface PorqueEntrada {
  pregunta: string;
  respuesta: string;
}
export interface CausaIshikawaEntrada {
  categoriaId: string;
  descripcion: string;
}
export interface CausaEntrada {
  tipo: TipoCausaInvestigacion;
  descripcion: string;
}

/**
 * Análisis de causas de la investigación: 5 Porqués, causas del diagrama de Ishikawa y causas del formato DYN-SGI-RE-034. Cada operación
 * reemplaza su lista completa en una transacción, solo con la investigación abierta o en investigación (la base también lo impide).
 */
@Injectable()
export class InvestigacionesCausasService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly consulta: InvestigacionesConsultaService,
  ) {}

  async guardarPorques(id: string, porques: PorqueEntrada[], actor: AuthUser) {
    const filas = porques.map((p, i) => ({
      orden: i + 1,
      pregunta: texto(p.pregunta),
      respuesta: texto(p.respuesta),
    }));
    if (filas.some((f) => !f.pregunta || !f.respuesta))
      throw new BadRequestException('Cada nivel de los 5 Porqués lleva su pregunta y su respuesta');
    await this.editar(id, async (tx) => {
      await tx.investigacionPorque.deleteMany({ where: { investigacionId: id } });
      await tx.investigacionPorque.createMany({
        data: filas.map((f) => ({
          id: uuidv7(),
          investigacionId: id,
          orden: f.orden,
          pregunta: f.pregunta as string,
          respuesta: f.respuesta as string,
          createdBy: actor.id,
        })),
      });
    });
    return this.consulta.detalle(id);
  }

  async guardarIshikawa(id: string, causas: CausaIshikawaEntrada[], actor: AuthUser) {
    const filas = causas.map((c) => ({
      categoriaId: c.categoriaId,
      descripcion: texto(c.descripcion),
    }));
    if (filas.some((f) => !f.descripcion))
      throw new BadRequestException('Cada causa de Ishikawa lleva su descripción');
    await this.editar(id, async (tx) => {
      const categorias = [...new Set(filas.map((f) => f.categoriaId))];
      if (
        (await tx.ishikawaCategoria.count({ where: { id: { in: categorias }, activo: true } })) !==
        categorias.length
      )
        throw new BadRequestException('Una de las categorías de Ishikawa no existe');
      await tx.investigacionIshikawaCausa.deleteMany({ where: { investigacionId: id } });
      await tx.investigacionIshikawaCausa.createMany({
        data: filas.map((f, i) => ({
          id: uuidv7(),
          investigacionId: id,
          categoriaId: f.categoriaId,
          orden: i + 1,
          descripcion: f.descripcion as string,
          createdBy: actor.id,
        })),
      });
    });
    return this.consulta.detalle(id);
  }

  async guardarCausas(id: string, causas: CausaEntrada[], actor: AuthUser) {
    const cuenta = new Map<TipoCausaInvestigacion, number>();
    const filas = causas.map((c) => {
      const orden = (cuenta.get(c.tipo) ?? 0) + 1;
      cuenta.set(c.tipo, orden);
      return { tipo: c.tipo, orden, descripcion: texto(c.descripcion) };
    });
    if (filas.some((f) => !f.descripcion))
      throw new BadRequestException('Cada causa lleva su descripción');
    await this.editar(id, async (tx) => {
      await tx.investigacionCausa.deleteMany({ where: { investigacionId: id } });
      await tx.investigacionCausa.createMany({
        data: filas.map((f) => ({
          id: uuidv7(),
          investigacionId: id,
          tipo: f.tipo,
          orden: f.orden,
          descripcion: f.descripcion as string,
          createdBy: actor.id,
        })),
      });
    });
    return this.consulta.detalle(id);
  }

  /** Corre el cambio en una transacción, solo si la investigación existe y todavía se puede editar. */
  private async editar(id: string, cambio: (tx: Tx) => Promise<void>): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const i = await tx.investigacion.findUnique({ where: { id }, select: { estado: true } });
      if (!i) throw new NotFoundException('La investigación no existe');
      if (
        i.estado !== EstadoInvestigacion.abierta &&
        i.estado !== EstadoInvestigacion.en_investigacion
      )
        throw new ConflictException('La investigación ya no admite cambios');
      await cambio(tx);
    });
  }
}
