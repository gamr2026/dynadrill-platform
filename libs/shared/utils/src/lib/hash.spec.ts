import { safeEqualHex, sha256Hex } from './hash';

describe('hash', () => {
  it('sha256 conocido', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
  it('comparación en tiempo constante', () => {
    expect(safeEqualHex(sha256Hex('a'), sha256Hex('a'))).toBe(true);
    expect(safeEqualHex(sha256Hex('a'), sha256Hex('b'))).toBe(false);
    expect(safeEqualHex('ab', 'abcd')).toBe(false);
  });
});
