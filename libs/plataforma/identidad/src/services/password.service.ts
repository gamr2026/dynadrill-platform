import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import * as bcrypt from 'bcryptjs';

/** Parámetros Argon2id recomendados por OWASP (19 MiB, 2 iteraciones, 1 hilo). */
const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

const isBcrypt = (hash: string) => /^\$2[abxy]\$/.test(hash);

/**
 * Contraseñas con Argon2id. Los hashes bcrypt que vienen de la demo se siguen aceptando para que
 * los usuarios migrados puedan entrar, y `needsRehash` avisa para cambiarlos por Argon2id en el
 * primer login correcto.
 */
@Injectable()
export class PasswordService {
  /** Hash válido pero inalcanzable: sirve para gastar el mismo tiempo cuando el usuario no existe. */
  private dummyHash?: Promise<string>;

  hash(password: string): Promise<string> {
    return argon2.hash(password, ARGON2_OPTIONS);
  }

  async verify(password: string, hash: string): Promise<boolean> {
    try {
      return isBcrypt(hash)
        ? await bcrypt.compare(password, hash)
        : await argon2.verify(hash, password);
    } catch {
      return false; // hash corrupto o con formato desconocido: nunca autentica
    }
  }

  needsRehash(hash: string): boolean {
    return isBcrypt(hash) || argon2.needsRehash(hash, ARGON2_OPTIONS);
  }

  /**
   * Verifica contra un hash falso para que responder "usuario inexistente" tarde lo mismo que
   * "contraseña incorrecta" (evita enumerar cuentas por tiempo de respuesta).
   */
  async equalizeTiming(password: string): Promise<void> {
    this.dummyHash ??= this.hash('dynadrill-hash-de-relleno');
    await this.verify(password, await this.dummyHash);
  }
}
