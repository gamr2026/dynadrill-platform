import { formatearCodigo } from './formato';

describe('formatearCodigo (como las secuencias de AS2)', () => {
  it('prefijo + ceros hasta la longitud total, que incluye el prefijo', () => {
    expect(formatearCodigo('PEC-', null, 10, 4675)).toBe('PEC-004675');
    expect(formatearCodigo('PRC-', null, 9, 4531)).toBe('PRC-04531');
    expect(formatearCodigo('GUI-', null, 9, 288)).toBe('GUI-00288');
  });

  it('sin longitud (0) no hay relleno: el código del pedido del portal', () => {
    expect(formatearCodigo(null, null, 0, 4317)).toBe('4317');
    expect(formatearCodigo('PUMP-', null, 0, 7)).toBe('PUMP-7');
  });

  it('sin prefijo pero con longitud, rellena con ceros', () => {
    expect(formatearCodigo(null, null, 9, 1501)).toBe('000001501');
  });

  it('el sufijo cuenta dentro de la longitud', () => {
    expect(formatearCodigo('A-', '-X', 8, 42)).toBe('A-0042-X');
  });

  it('el último número del rango todavía cabe', () => {
    expect(formatearCodigo('PEC-', null, 10, 999999)).toBe('PEC-999999');
  });

  it('un número que no cabe en la longitud es un error, no un código truncado', () => {
    expect(() => formatearCodigo('PEC-', null, 10, 1_000_000)).toThrow(/no cabe/);
    expect(() => formatearCodigo('PEC-', null, 4, 1)).toThrow(/no cabe/);
  });
});
