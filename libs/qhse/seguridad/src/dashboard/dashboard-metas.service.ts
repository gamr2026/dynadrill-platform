import { BadRequestException, Injectable } from '@nestjs/common';
import type { AuthUser } from '@dyn/common';
import { uuidv7 } from '@dyn/utils';
import { PrismaService } from '../prisma/prisma.service';

/** Las metas del Dashboard Integrado (HSE-MASTER-001) como `{ códigoDelIndicador: valor }`. */
export type MetasDelTablero = Record<string, number>;

/**
 * Metas de los indicadores del tablero HSE. Son historia: cada cambio agrega una fila y la vigente de un indicador es la más reciente,
 * por eso aquí nunca se edita ni se borra nada.
 */
@Injectable()
export class DashboardMetasService {
  constructor(private readonly prisma: PrismaService) {}

  /** La meta vigente de cada indicador que tiene una; los que no, no aparecen. */
  async vigentes(): Promise<MetasDelTablero> {
    const filas = await this.prisma.kpiMeta.findMany({
      distinct: ['indicadorId'],
      orderBy: [{ indicadorId: 'asc' }, { vigenteDesde: 'desc' }],
      select: { valor: true, indicador: { select: { codigo: true } } },
    });
    return Object.fromEntries(filas.map((f) => [f.indicador.codigo, Number(f.valor)]));
  }

  /** Fija la meta nueva de uno o varios indicadores y devuelve todas las vigentes. */
  async fijar(cambios: MetasDelTablero, actor: AuthUser): Promise<MetasDelTablero> {
    const codigos = Object.keys(cambios);
    if (!codigos.length) throw new BadRequestException('Indique al menos una meta');
    const indicadores = await this.prisma.kpiIndicador.findMany({
      where: { codigo: { in: codigos } },
      select: { id: true, codigo: true },
    });
    const desconocidos = codigos.filter((c) => !indicadores.some((i) => i.codigo === c));
    if (desconocidos.length) {
      throw new BadRequestException(`Indicador desconocido: ${desconocidos.join(', ')}`);
    }
    const ahora = Date.now();
    await this.prisma.kpiMeta.createMany({
      data: indicadores.map((i, n) => ({
        id: uuidv7(),
        indicadorId: i.id,
        valor: cambios[i.codigo],
        // dos cambios seguidos del mismo indicador no pueden compartir instante (la vigencia es única por indicador)
        vigenteDesde: new Date(ahora + n),
        createdBy: actor.id,
      })),
    });
    return this.vigentes();
  }
}
