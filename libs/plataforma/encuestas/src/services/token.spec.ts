import { hashDeToken, nuevoToken, TOKEN_VALIDO } from './token';

describe('token de la invitación', () => {
  it('es largo, seguro para una URL y distinto cada vez', () => {
    const a = nuevoToken();
    const b = nuevoToken();
    expect(a.token).toHaveLength(43);
    expect(a.token).toMatch(TOKEN_VALIDO);
    expect(a.token).not.toBe(b.token);
    expect(a.hash).not.toBe(b.hash);
  });

  it('la base guarda solo el hash (SHA-256 en hexadecimal) y es reproducible a partir del token', () => {
    const { token, hash } = nuevoToken();
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(token);
    expect(hashDeToken(token)).toBe(hash);
    expect(hashDeToken(`${token}x`)).not.toBe(hash);
  });

  it('rechaza lo que no tiene la forma de un token', () => {
    for (const malo of [
      '',
      'corto',
      'con espacios aquí aquí aquí',
      '../../etc/passwd',
      'a'.repeat(129),
    ]) {
      expect(malo).not.toMatch(TOKEN_VALIDO);
    }
  });
});
