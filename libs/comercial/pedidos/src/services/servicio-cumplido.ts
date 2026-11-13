import { BUSINESS_TIMEZONE } from '@dyn/utils';
import type { PrismaService } from '../prisma/prisma.service';

const MS_DIA = 86_400_000;
/** Tope de días que se revisan (un servicio no dura años; evita un bucle largo ante una fecha mal digitada). */
const MAX_DIAS = 400;

const dmy = (f: string) => `${f.slice(8, 10)}/${f.slice(5, 7)}/${f.slice(0, 4)}`;
const aDiaTxt = (d: Date) => d.toISOString().slice(0, 10);

/** El día de hoy en la zona de negocio (America/Guayaquil) como `yyyy-MM-dd`. */
export const hoyEnEcuador = (ahora: Date = new Date()): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(ahora);

export interface EstadoEnvio {
  permitido: boolean;
  motivo: string | null;
}

type Db = Pick<PrismaService, 'pedido' | 'documentoOperativo' | 'pedidoJornadaSinOperacion'>;

/**
 * Regla de envío de la prefactura al cliente: el servicio ya llegó a su último día (hoy, en Ecuador, es igual o posterior a la fecha
 * de fin vigente, que Operaciones puede haber acortado) y cada día del servicio tiene su Reporte Job o fue justificado como día sin
 * operación. Un último día justificado no bloquea. Sin fecha de fin no hay nada que comprobar. Sirve igual a los pedidos de FCR: su
 * Reporte Job es la bitácora que el operador envía cada día.
 */
export async function estadoDeEnvio(
  db: Db,
  pedidoId: string,
  ahora: Date = new Date(),
): Promise<EstadoEnvio> {
  const pedido = await db.pedido.findUniqueOrThrow({
    where: { id: pedidoId },
    select: { fechaInicioServicio: true, fechaFinServicio: true },
  });
  const fin = pedido.fechaFinServicio;
  if (!fin) return { permitido: true, motivo: null };
  const finTxt = aDiaTxt(fin);
  if (hoyEnEcuador(ahora) < finTxt) {
    return {
      permitido: false,
      motivo: `El servicio termina el ${dmy(finTxt)}: la prefactura se envía al cliente desde ese día.`,
    };
  }

  const inicio = pedido.fechaInicioServicio ?? fin;
  const totalDias = Math.min(Math.round((fin.getTime() - inicio.getTime()) / MS_DIA) + 1, MAX_DIAS);
  const esperados = Array.from({ length: Math.max(totalDias, 1) }, (_, i) =>
    aDiaTxt(new Date(inicio.getTime() + i * MS_DIA)),
  );

  const [reportes, justificados] = await Promise.all([
    db.documentoOperativo.findMany({
      // un día quitado por Facturación queda como documento corregido sin actividades: no cuenta como reportado
      where: {
        pedidoId,
        tipo: 'reporte_job',
        NOT: { corregidoAt: { not: null }, actividades: { none: {} } },
      },
      select: { fecha: true },
    }),
    db.pedidoJornadaSinOperacion.findMany({ where: { pedidoId }, select: { fecha: true } }),
  ]);
  const cubiertos = new Set([
    ...reportes.flatMap((r) => (r.fecha ? [aDiaTxt(r.fecha)] : [])),
    ...justificados.map((j) => aDiaTxt(j.fecha)),
  ]);
  const faltan = esperados.filter((d) => !cubiertos.has(d));
  if (faltan.length === 0) return { permitido: true, motivo: null };
  return {
    permitido: false,
    motivo: `Falta el Reporte Job ${faltan.length === 1 ? 'del día' : 'de los días'} ${faltan.map(dmy).join(', ')}. Cada día del servicio necesita su reporte o debe registrarse como día sin operación.`,
  };
}
