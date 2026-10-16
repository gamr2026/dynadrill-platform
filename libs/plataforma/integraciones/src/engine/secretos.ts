/**
 * De dónde salen los secretos. La base de datos guarda solo el NOMBRE (p. ej. `AS2_PASSWORD`); el valor lo
 * entrega este resolvedor. Hoy son variables de entorno; para Azure Key Vault basta otra implementación.
 */
export abstract class SecretResolver {
  abstract resolver(nombre: string): string | undefined;
}

/** Forma válida de un nombre de secreto. */
export const NOMBRE_SECRETO = /^[A-Z][A-Z0-9_]{2,63}$/;

/** Prefijos de secretos permitidos si no se configuran otros (`INTEGRACIONES_SECRET_PREFIXES`, separados por coma). */
export const PREFIJOS_POR_DEFECTO = ['AS2_'];

/**
 * Lee secretos de variables de entorno, pero SOLO las que empiecen con un prefijo permitido. Así una configuración
 * editada desde la base de datos no puede pedir variables arbitrarias del proceso (`DATABASE_URL`, `JWT_PRIVATE_KEY`...).
 * Dar de alta un proveedor nuevo con secretos exige añadir su prefijo a la configuración del despliegue: es deliberado.
 */
export class EnvSecretResolver extends SecretResolver {
  constructor(private readonly prefijos: readonly string[] = PREFIJOS_POR_DEFECTO) {
    super();
  }

  static desdeEntorno(): EnvSecretResolver {
    const lista = (process.env['INTEGRACIONES_SECRET_PREFIXES'] ?? '')
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    return new EnvSecretResolver(lista.length ? lista : PREFIJOS_POR_DEFECTO);
  }

  resolver(nombre: string): string | undefined {
    if (!NOMBRE_SECRETO.test(nombre)) return undefined;
    if (!this.prefijos.some((p) => nombre.startsWith(p))) return undefined;
    const v = process.env[nombre];
    return v === undefined || v === '' ? undefined : v;
  }
}
