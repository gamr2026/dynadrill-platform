import { Injectable, NotFoundException } from '@nestjs/common';
import { aDia, diasHasta, hoyEcuador } from '../comun/fechas';
import { EstadoRequisitoLegal } from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';

/** Días de aviso antes de que venza una revisión vigente. */
export const DIAS_AVISO_VENCIMIENTO = 30;

export type EstadoVigencia = 'sin_vencimiento' | 'vigente' | 'por_vencer' | 'vencido';

/** Vigencia de una revisión según su fecha límite (sin límite = sin vencimiento). Solo tiene sentido para la revisión vigente. */
export function estadoDeVigencia(
  vigenteHasta: string | null,
  hoy: string = hoyEcuador(),
): { estadoVigencia: EstadoVigencia; diasParaVencer: number | null } {
  if (!vigenteHasta) return { estadoVigencia: 'sin_vencimiento', diasParaVencer: null };
  const dias = diasHasta(vigenteHasta, hoy);
  if (dias < 0) return { estadoVigencia: 'vencido', diasParaVencer: dias };
  return {
    estadoVigencia: dias <= DIAS_AVISO_VENCIMIENTO ? 'por_vencer' : 'vigente',
    diasParaVencer: dias,
  };
}

/** Lectura de requisitos legales: cada tipo con su revisión vigente (y su vigencia) y el historial de revisiones. */
@Injectable()
export class RequisitosLegalesConsultaService {
  constructor(private readonly prisma: PrismaService) {}

  tipos() {
    return this.prisma.requisitoLegalTipo.findMany({
      where: { activo: true },
      orderBy: { orden: 'asc' },
      select: { id: true, codigo: true, nombre: true },
    });
  }

  /** Por cada tipo: la revisión vigente (o `null` si aún no hay) y todas las revisiones, de la más reciente a la más antigua. */
  async listar() {
    const [tipos, filas] = await Promise.all([
      this.prisma.requisitoLegalTipo.findMany({
        where: { activo: true },
        orderBy: { orden: 'asc' },
      }),
      this.prisma.requisitoLegal.findMany({ orderBy: [{ createdAt: 'desc' }] }),
    ]);
    const personas = await this.nombres(filas.flatMap((f) => [f.createdBy, f.reemplazadoPor]));
    const revision = (f: (typeof filas)[number]) => ({
      id: f.id,
      revision: f.revision,
      fechaAprobacion: aDia(f.fechaAprobacion),
      vigenteHasta: f.vigenteHasta ? aDia(f.vigenteHasta) : null,
      estado: f.estado,
      // la vigencia solo se evalúa en la revisión que rige; las reemplazadas ya no vencen
      ...(f.estado === EstadoRequisitoLegal.vigente
        ? estadoDeVigencia(f.vigenteHasta ? aDia(f.vigenteHasta) : null)
        : { estadoVigencia: null, diasParaVencer: null }),
      archivoId: f.archivoId,
      registradoPor: personas.get(f.createdBy) ?? null,
      registradoAt: f.createdAt,
      reemplazadoAt: f.reemplazadoAt,
      reemplazadoPor: f.reemplazadoPor ? (personas.get(f.reemplazadoPor) ?? null) : null,
    });
    return tipos.map((t) => {
      const suyas = filas.filter((f) => f.tipoId === t.id).map(revision);
      return {
        tipo: { id: t.id, codigo: t.codigo, nombre: t.nombre },
        vigente: suyas.find((r) => r.estado === EstadoRequisitoLegal.vigente) ?? null,
        revisiones: suyas,
      };
    });
  }

  async uno(id: string) {
    const f = await this.prisma.requisitoLegal.findUnique({
      where: { id },
      select: { tipoId: true },
    });
    if (!f) throw new NotFoundException('La revisión no existe');
    const grupo = (await this.listar()).find((g) => g.tipo.id === f.tipoId);
    const r = grupo?.revisiones.find((x) => x.id === id);
    if (!grupo || !r) throw new NotFoundException('La revisión no existe');
    return { tipo: grupo.tipo, ...r };
  }

  private async nombres(ids: Array<string | null>): Promise<Map<string, string>> {
    const unicos = [...new Set(ids.filter((x): x is string => !!x))];
    const filas = await this.prisma.idUsuario.findMany({
      where: { id: { in: unicos } },
      select: { id: true, nombre: true },
    });
    return new Map(filas.map((p) => [p.id, p.nombre]));
  }
}
