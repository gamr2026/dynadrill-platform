import { Injectable } from '@nestjs/common';
import type { AuthUser } from '@dyn/common';
import { uuidv7 } from '@dyn/utils';
import { aDia, diasHasta, hoyEcuador, masDias } from '../comun/fechas';
import { TipoAvisoDesecho } from '../generated/client';
import { PrismaService } from '../prisma/prisma.service';
import { DIAS_AVISO_LIMITE, PLAZO_CERTIFICADO_DIAS } from './desechos-consulta.service';
import { DesechosEventosService } from './desechos-eventos.service';

export interface ResultadoRevision {
  limiteProximo: number;
  limiteVencido: number;
  certificadoVencido: number;
}

/**
 * Avisos de vencimiento de desechos. La revisión corre sola con la de los demás avisos por vencimiento (`AvisosProgramadosService`) y también
 * la dispara quien tiene el permiso; es **idempotente**: cada aviso se emite una sola vez por desecho (clave única `desecho_aviso`). Cada aviso es
 * un evento `qhse.desecho.*` que el módulo de Avisos de la plataforma convierte en aviso y correo con sus plantillas.
 */
@Injectable()
export class DesechosAvisosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventos: DesechosEventosService,
  ) {}

  /**
   * Emite lo que falta: límite de 12 meses próximo (faltan {@link DIAS_AVISO_LIMITE} días o menos) o vencido, y certificado de disposición
   * fuera del plazo de {@link PLAZO_CERTIFICADO_DIAS} días desde el manifiesto. Solo desechos que no están dispuestos.
   */
  async revisar(
    actor: AuthUser | null,
    /** Limita la revisión a esos desechos (pruebas); sin valor, revisa todos. */
    desechos?: readonly string[],
  ): Promise<ResultadoRevision> {
    const hoy = hoyEcuador();
    const resultado: ResultadoRevision = {
      limiteProximo: 0,
      limiteVencido: 0,
      certificadoVencido: 0,
    };
    const abiertos = await this.prisma.desecho.findMany({
      where: {
        ...(desechos ? { id: { in: [...desechos] } } : {}),
        estado: { codigo: { not: 'dispuesto' } },
        limiteAlmacenamientoHasta: {
          lte: new Date(`${masDias(hoy, DIAS_AVISO_LIMITE)}T00:00:00.000Z`),
        },
      },
      select: { id: true, limiteAlmacenamientoHasta: true },
    });
    for (const d of abiertos) {
      const limite = aDia(d.limiteAlmacenamientoHasta);
      const dias = diasHasta(limite, hoy);
      const tipo = dias < 0 ? TipoAvisoDesecho.limite_vencido : TipoAvisoDesecho.limite_proximo;
      const extra = {
        diasParaLimite: dias,
        diasVencido: Math.max(0, -dias),
      };
      if (await this.emitir(d.id, tipo, actor, extra))
        resultado[tipo === 'limite_vencido' ? 'limiteVencido' : 'limiteProximo']++;
    }

    const conManifiesto = await this.prisma.desecho.findMany({
      where: {
        ...(desechos ? { id: { in: [...desechos] } } : {}),
        estado: { codigo: 'con_manifiesto' },
        manifiesto: { isNot: null },
      },
      select: { id: true, manifiesto: { select: { fecha: true } } },
    });
    for (const d of conManifiesto) {
      if (!d.manifiesto) continue;
      const vence = masDias(aDia(d.manifiesto.fecha), PLAZO_CERTIFICADO_DIAS);
      if (hoy <= vence) continue;
      const emitido = await this.emitir(d.id, TipoAvisoDesecho.certificado_vencido, actor, {
        certificadoVenceEl: vence,
        diasVencido: -diasHasta(vence, hoy),
      });
      if (emitido) resultado.certificadoVencido++;
    }
    return resultado;
  }

  /** Registra el aviso y publica el evento en la misma transacción; `false` si ese aviso ya se había emitido. */
  private async emitir(
    desechoId: string,
    tipo: TipoAvisoDesecho,
    actor: AuthUser | null,
    extra: Record<string, unknown>,
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const ya = await tx.desechoAviso.createMany({
        data: [{ id: uuidv7(), desechoId, tipo, emitidoPor: actor?.id ?? null }],
        skipDuplicates: true,
      });
      if (ya.count === 0) return false;
      const d = await tx.desecho.findUniqueOrThrow({
        where: { id: desechoId },
        select: { descripcion: true },
      });
      await this.eventos.publicar(tx, `qhse.desecho.${tipo}`, desechoId, actor, {
        descripcion: d.descripcion,
        ...extra,
      });
      return true;
    });
  }
}
