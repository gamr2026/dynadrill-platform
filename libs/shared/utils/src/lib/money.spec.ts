import { addMoney, centsToMoney, moneyToCents, percentOfMoney } from './money';

describe('money', () => {
  it('convierte sin errores de coma flotante', () => {
    expect(addMoney('0.10', '0.20')).toBe('0.30');
    expect(addMoney(0.1, 0.2)).toBe('0.30');
    expect(centsToMoney(moneyToCents('1234.5'))).toBe('1234.50');
  });

  it('maneja negativos y enteros', () => {
    expect(centsToMoney(moneyToCents('-5'))).toBe('-5.00');
    expect(addMoney('10', '-2.50')).toBe('7.50');
  });

  it('rechaza formatos inválidos', () => {
    expect(() => moneyToCents('12.345')).toThrow(RangeError);
    expect(() => moneyToCents('abc')).toThrow(RangeError);
  });

  it('calcula porcentajes redondeando al centavo (half-up)', () => {
    expect(percentOfMoney('100.00', 15)).toBe('15.00');
    expect(percentOfMoney('0.10', 15)).toBe('0.02'); // 0.015 → 0.02
    expect(percentOfMoney('33.33', '15')).toBe('5.00'); // 4.9995 → 5.00
  });
});
