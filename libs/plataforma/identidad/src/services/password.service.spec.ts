import * as bcrypt from 'bcryptjs';
import { PasswordService } from './password.service';

describe('PasswordService', () => {
  const svc = new PasswordService();

  it('genera Argon2id y verifica la clave correcta e incorrecta', async () => {
    const hash = await svc.hash('Clave-Segura-123');
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(await svc.verify('Clave-Segura-123', hash)).toBe(true);
    expect(await svc.verify('otra', hash)).toBe(false);
  });

  it('dos hashes de la misma clave son distintos (sal aleatoria)', async () => {
    expect(await svc.hash('x1234567')).not.toBe(await svc.hash('x1234567'));
  });

  it('acepta hashes bcrypt de la demo y pide cambiarlos', async () => {
    const legacy = await bcrypt.hash('Dynadrill2026*', 10);
    expect(await svc.verify('Dynadrill2026*', legacy)).toBe(true);
    expect(await svc.verify('mala', legacy)).toBe(false);
    expect(svc.needsRehash(legacy)).toBe(true);
    expect(svc.needsRehash(await svc.hash('x'))).toBe(false);
  });

  it('un hash corrupto o desconocido nunca autentica ni lanza', async () => {
    expect(await svc.verify('x', 'no-es-un-hash')).toBe(false);
    expect(await svc.verify('x', '')).toBe(false);
  });
});
