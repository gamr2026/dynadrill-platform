import { addDaysUtc, parseDateOnly, toDateOnly, toIsoUtc } from './dates';

describe('dates', () => {
  it('ida y vuelta de fechas sin hora', () => {
    expect(toDateOnly(parseDateOnly('2026-10-11'))).toBe('2026-10-11');
  });

  it('rechaza días inexistentes y formatos erróneos', () => {
    expect(() => parseDateOnly('2026-02-30')).toThrow(RangeError);
    expect(() => parseDateOnly('11/10/2026')).toThrow(RangeError);
  });

  it('suma días en UTC y emite ISO con Z', () => {
    const d = addDaysUtc(parseDateOnly('2026-12-31'), 1);
    expect(toDateOnly(d)).toBe('2027-01-01');
    expect(toIsoUtc(d)).toMatch(/Z$/);
  });
});
