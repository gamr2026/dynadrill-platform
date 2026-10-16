import { isUuid, uuidv7, uuidv7Timestamp } from './uuid';

describe('uuidv7', () => {
  it('tiene formato UUID versión 7 y variante RFC', () => {
    const id = uuidv7();
    expect(isUuid(id)).toBe(true);
    expect(id[14]).toBe('7');
    expect('89ab').toContain(id[19]);
  });

  it('es estrictamente creciente aunque se generen muchos en el mismo milisegundo', () => {
    const ids = Array.from({ length: 5000 }, () => uuidv7());
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i] > ids[i - 1]).toBe(true);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('embebe el timestamp actual', () => {
    const before = Date.now();
    const ts = uuidv7Timestamp(uuidv7());
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThan(before + 5000);
  });
});
