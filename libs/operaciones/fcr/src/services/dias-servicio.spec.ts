import { diasDelServicio, hoyEcuador, inicioDelDia, sumarDias, venceDelDia } from './dias-servicio';

const d = (f: string) => new Date(`${f}T00:00:00.000Z`);

describe('días del servicio (hora de Ecuador)', () => {
  it('hoy en Ecuador va cinco horas atrás de UTC', () => {
    expect(hoyEcuador(Date.parse('2026-11-12T04:59:00Z'))).toBe('2026-11-11');
    expect(hoyEcuador(Date.parse('2026-11-12T05:00:00Z'))).toBe('2026-11-12');
  });

  it('el día empieza a las 05:00 UTC y suma días entre fechas', () => {
    expect(inicioDelDia('2026-11-12').toISOString()).toBe('2026-11-12T05:00:00.000Z');
    expect(sumarDias('2026-11-30', 1)).toBe('2026-12-01');
    expect(sumarDias('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('cada día vence al terminar el siguiente', () => {
    expect(venceDelDia('2026-11-13').toISOString()).toBe('2026-11-15T05:00:00.000Z');
  });

  it('los días del servicio, topados a una fecha; vacío si el rango no existe', () => {
    expect(diasDelServicio(d('2026-11-05'), d('2026-11-08'))).toEqual([
      '2026-11-05',
      '2026-11-06',
      '2026-11-07',
      '2026-11-08',
    ]);
    expect(diasDelServicio(d('2026-11-05'), d('2026-11-08'), '2026-11-06')).toEqual([
      '2026-11-05',
      '2026-11-06',
    ]);
    expect(diasDelServicio(d('2026-11-05'), d('2026-11-08'), '2026-11-04')).toEqual([]);
    expect(diasDelServicio(d('2026-11-08'), d('2026-11-05'))).toEqual([]);
  });
});
