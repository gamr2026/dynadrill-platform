import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

const ACTIVOS = { where: { activo: true }, orderBy: { orden: 'asc' } } as const;
const SELECCION = { id: true, codigo: true, nombre: true } as const;

/** Catálogos fijos de FCR (tipo de operador, completación, trabajo y picker) para los selectores de las pantallas. */
@Injectable()
export class CatalogosService {
  constructor(private readonly prisma: PrismaService) {}

  async todos() {
    const [tiposOperador, tiposCompletacion, tiposTrabajo, tiposPicker] = await Promise.all([
      this.prisma.tipoOperador.findMany({ ...ACTIVOS, select: SELECCION }),
      this.prisma.tipoCompletacion.findMany({ ...ACTIVOS, select: SELECCION }),
      this.prisma.tipoTrabajo.findMany({ ...ACTIVOS, select: SELECCION }),
      this.prisma.tipoPicker.findMany({ ...ACTIVOS, select: SELECCION }),
    ]);
    return { tiposOperador, tiposCompletacion, tiposTrabajo, tiposPicker };
  }
}
