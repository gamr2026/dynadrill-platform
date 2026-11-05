import { diasEntre, estadoVisible, hoyEnGuayaquil } from './jornadas.service';

describe('jornadas: fechas y estado visible', () => {
  it('diasEntre incluye los dos extremos y cruza meses y años', () => {
    expect(diasEntre('2026-11-05', '2026-11-05')).toEqual(['2026-11-05']);
    expect(diasEntre('2026-10-30', '2026-11-02')).toEqual([
      '2026-10-30',
      '2026-10-31',
      '2026-11-01',
      '2026-11-02',
    ]);
    expect(diasEntre('2026-12-31', '2027-01-01')).toEqual(['2026-12-31', '2027-01-01']);
    expect(diasEntre('2026-11-06', '2026-11-05')).toEqual([]);
  });

  it('hoy se toma en la zona de Ecuador (UTC-5), no en la del servidor', () => {
    // 02:00 UTC del 6/11 son las 21:00 del 5/11 en Ecuador
    expect(hoyEnGuayaquil(new Date('2026-11-06T02:00:00Z'))).toBe('2026-11-05');
    expect(hoyEnGuayaquil(new Date('2026-11-06T05:00:00Z'))).toBe('2026-11-06');
  });

  it('el estado visible se deduce de la fecha y solo lo ya resuelto se queda como está', () => {
    const hoy = '2026-11-06';
    expect(estadoVisible('pendiente', '2026-11-07', hoy)).toBe('pendiente');
    expect(estadoVisible('pendiente', '2026-11-06', hoy)).toBe('hoy');
    expect(estadoVisible('abierta', '2026-11-06', hoy)).toBe('abierta');
    expect(estadoVisible('pendiente', '2026-11-05', hoy)).toBe('con_pendientes');
    expect(estadoVisible('abierta', '2026-11-05', hoy)).toBe('con_pendientes');
    for (const e of ['cerrada', 'sin_operacion', 'no_aplica'] as const) {
      expect(estadoVisible(e, '2026-11-05', hoy)).toBe(e);
      expect(estadoVisible(e, '2026-11-07', hoy)).toBe(e);
    }
  });
});
