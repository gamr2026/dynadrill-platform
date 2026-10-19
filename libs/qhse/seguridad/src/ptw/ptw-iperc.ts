import type { Tx } from '../epi/epi-tipos';
import { EstadoIperc } from '../generated/client';
import { codigoIperc } from '../iperc/iperc-consulta.service';
import { aDia } from './ptw-documentos';

export interface RequisitoIperc {
  actividadId: string;
  actividad: string;
  /** Matriz aprobada y vigente que cubre el día de operación; `null` si falta. */
  matrizId: string | null;
  codigo: string | null;
  vigenteHasta: string | null;
  /** Por qué no se cumple, en una frase para el usuario. */
  falta: string | null;
}

/**
 * Matrices IPERC que respaldan el PTW de un día: por cada actividad que exigen los tipos de servicio del ticket (cobertura), la matriz
 * **aprobada** cuya vigencia de 12 meses cubre el día de operación. Una matriz sin aprobar, en revisión o vencida bloquea. Si el tipo de
 * servicio no tiene cobertura configurada no exige ninguna (queda anotado en el plan como consulta para Dynadrill).
 */
export async function requisitosIperc(
  tx: Pick<Tx, 'ticketServicio' | 'ipercCobertura' | 'ipercMatriz'>,
  ticketId: string,
  dia: Date,
): Promise<RequisitoIperc[]> {
  const tipos = (
    await tx.ticketServicio.findMany({ where: { ticketId }, select: { tipoCodigo: true } })
  ).map((t) => t.tipoCodigo);
  if (!tipos.length) return [];
  const cobertura = await tx.ipercCobertura.findMany({
    where: { tipoServicioCodigo: { in: tipos } },
    include: { actividad: { select: { id: true, nombre: true } } },
  });
  const actividades = new Map(cobertura.map((c) => [c.actividad.id, c.actividad.nombre]));
  if (!actividades.size) return [];
  const matrices = await tx.ipercMatriz.findMany({
    where: {
      actividadId: { in: [...actividades.keys()] },
      estado: {
        in: [
          EstadoIperc.aprobada,
          EstadoIperc.en_revision,
          EstadoIperc.en_evaluacion,
          EstadoIperc.borrador,
          EstadoIperc.rechazada,
        ],
      },
    },
    select: {
      id: true,
      numero: true,
      actividadId: true,
      estado: true,
      aprobadaEl: true,
      vigenteHasta: true,
    },
  });
  const diaTexto = aDia(dia);
  return [...actividades.entries()]
    .map(([actividadId, actividad]): RequisitoIperc => {
      const aprobada = matrices.find(
        (m) => m.actividadId === actividadId && m.estado === EstadoIperc.aprobada,
      );
      const ok =
        !!aprobada?.aprobadaEl &&
        !!aprobada.vigenteHasta &&
        aDia(aprobada.aprobadaEl) <= diaTexto &&
        diaTexto <= aDia(aprobada.vigenteHasta);
      if (aprobada && ok) {
        return {
          actividadId,
          actividad,
          matrizId: aprobada.id,
          codigo: codigoIperc(aprobada.numero),
          vigenteHasta: aDia(aprobada.vigenteHasta as Date),
          falta: null,
        };
      }
      const falta = (motivo: string): RequisitoIperc => ({
        actividadId,
        actividad,
        matrizId: null,
        codigo: null,
        vigenteHasta: null,
        falta: motivo,
      });
      if (aprobada?.vigenteHasta)
        return falta(
          `La matriz IPERC de «${actividad}» vale hasta el ${aDia(aprobada.vigenteHasta)} y no cubre el ${diaTexto}: hay que aprobar una versión nueva (una matriz vencida bloquea)`,
        );
      const enTrabajo = matrices.find((m) => m.actividadId === actividadId);
      return falta(
        enTrabajo
          ? `La matriz IPERC de «${actividad}» aún no está aprobada (está ${enTrabajo.estado.replace('_', ' ')})`
          : `La actividad «${actividad}» no tiene matriz IPERC`,
      );
    })
    .sort((a, b) => a.actividad.localeCompare(b.actividad, 'es'));
}
