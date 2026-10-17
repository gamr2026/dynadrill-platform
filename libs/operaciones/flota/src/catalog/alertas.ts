/**
 * Alertas del mantenimiento preventivo (Plan de Mantenimiento 2026, MAN-002). Función pura: recibe la unidad con su lectura vigente, su
 * último preventivo por tipo y las reglas (tabla `regla_preventiva`) y devuelve una alerta por regla aplicable. La regla de negocio vive
 * aquí y en la base (los intervalos), no en el frontend.
 */

export type NivelAlerta = 'rojo' | 'amarillo' | 'verde';
export type MetricaAlerta = 'horas' | 'km' | 'dias';

/** Avisa (amarillo) cuando queda el 15 % del intervalo o menos. */
export const UMBRAL_AMARILLO = 0.15;
const MS_DIA = 24 * 60 * 60 * 1000;

export interface ReglaAlerta {
  codigo: string;
  tipoUnidad: 'servicio' | 'auxiliar' | 'transporte';
  tipoServicio: 'a' | 'b' | null;
  metrica: MetricaAlerta;
  intervalo: number;
  tolerancia: number;
  descripcion: string;
}

/** Último preventivo ejecutado: su fecha y, si lo hubo, la lectura (horas o km) de ese momento. */
export interface UltimoPreventivo {
  fecha: Date;
  valor: number | null;
}

export interface EntradaAlertas {
  tipo: 'servicio' | 'auxiliar' | 'transporte';
  /** Horómetro (servicio) u odómetro (transporte) vigente; `null` si la unidad aún no tiene lectura. */
  lecturaVigente: number | null;
  ultimoA: UltimoPreventivo | null;
  ultimoB: UltimoPreventivo | null;
  /** Último preventivo de cualquier tipo (para las reglas por tiempo y por kilometraje). */
  ultimoCualquiera: UltimoPreventivo | null;
  ahora: Date;
}

export interface AlertaPreventiva {
  reglaCodigo: string;
  descripcion: string;
  metrica: MetricaAlerta;
  tipoServicio: 'a' | 'b' | null;
  /** Lo consumido desde el último preventivo (para la barra de progreso). */
  consumido: number;
  intervalo: number;
  /** Lo que falta (negativo = vencido). */
  restante: number;
  valorActual: number | null;
  nivel: NivelAlerta;
  /** `true` cuando ya pasó el intervalo pero sigue dentro de la ventana de tolerancia. */
  enVentana: boolean;
}

/** `tolerancia` es la ventana ± que el Plan admite como normal: dentro de ella la unidad sigue en amarillo y no en rojo. */
export function nivelDe(restante: number, intervalo: number, tolerancia: number): NivelAlerta {
  if (restante < -tolerancia) return 'rojo';
  if (restante <= intervalo * UMBRAL_AMARILLO) return 'amarillo';
  return 'verde';
}

const dias = (desde: Date, hasta: Date) => Math.floor((hasta.getTime() - desde.getTime()) / MS_DIA);

export function calcularAlertas(
  reglas: readonly ReglaAlerta[],
  e: EntradaAlertas,
): AlertaPreventiva[] {
  const alertas: AlertaPreventiva[] = [];
  const armar = (
    r: ReglaAlerta,
    consumido: number,
    valorActual: number | null,
    tolerancia = r.tolerancia,
  ): AlertaPreventiva => {
    const restante = r.intervalo - consumido;
    return {
      reglaCodigo: r.codigo,
      descripcion: r.descripcion,
      metrica: r.metrica,
      tipoServicio: r.tipoServicio,
      consumido,
      intervalo: r.intervalo,
      restante,
      valorActual,
      nivel: nivelDe(restante, r.intervalo, tolerancia),
      enVentana: restante <= 0 && restante >= -tolerancia,
    };
  };

  // Un servicio B incluye las actividades del A: también reinicia su contador.
  const horasA = Math.max(e.ultimoA?.valor ?? 0, e.ultimoB?.valor ?? 0);
  const horasB = e.ultimoB?.valor ?? 0;

  for (const r of reglas.filter((x) => x.tipoUnidad === e.tipo)) {
    if (r.metrica === 'horas' && e.lecturaVigente !== null) {
      const base = r.tipoServicio === 'b' ? horasB : horasA;
      alertas.push(armar(r, e.lecturaVigente - base, e.lecturaVigente));
    } else if (
      r.metrica === 'km' &&
      e.lecturaVigente !== null &&
      e.ultimoCualquiera?.valor != null
    ) {
      alertas.push(armar(r, e.lecturaVigente - e.ultimoCualquiera.valor, e.lecturaVigente));
    } else if (r.metrica === 'dias' && e.ultimoCualquiera) {
      // Las unidades de servicio se rigen por horas; los 6 meses solo cuentan si todavía no se alcanzan las horas del tipo A.
      if (e.tipo === 'servicio') {
        const horasDesdeA = e.lecturaVigente === null ? 0 : e.lecturaVigente - horasA;
        const reglaHorasA = reglas.find(
          (x) => x.tipoUnidad === 'servicio' && x.metrica === 'horas' && x.tipoServicio === 'a',
        );
        if (reglaHorasA && horasDesdeA >= reglaHorasA.intervalo) continue;
      }
      alertas.push(armar(r, dias(e.ultimoCualquiera.fecha, e.ahora), null, 0));
    }
  }
  return alertas;
}
