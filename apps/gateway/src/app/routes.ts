/**
 * Tabla de rutas del gateway (documento de arquitectura, anexo E). Cada prefijo lo atiende un contenedor; una ruta que ninguno
 * atiende (o cuyo contenedor no tiene URL configurada) responde 404. Desde el corte del 27/10/2026 ya no hay demo detrás.
 */
export type ContainerName = 'plataforma' | 'comercial' | 'operaciones' | 'qhse';

interface RouteRule {
  target: ContainerName;
  prefixes: string[];
}

export const ROUTE_RULES: RouteRule[] = [
  {
    target: 'plataforma',
    prefixes: [
      '/api/auth',
      '/api/users',
      '/api/roles',
      '/api/permissions',
      '/api/directorio',
      '/api/plataforma',
      '/api/as2',
      '/api/integraciones',
      '/api/archivos',
      '/api/avisos',
      '/api/auditoria',
      '/api/firmas',
      '/api/encuestas',
      // Catálogos (ids UUID): el gateway reescribe este prefijo a `/api/catalogos` al reenviarlo (ver PATH_REWRITE).
      '/api/v2/catalogos',
    ],
  },
  { target: 'comercial', prefixes: ['/api/comercial'] },
  { target: 'operaciones', prefixes: ['/api/operaciones'] },
  // QHSE (ids UUID) bajo `/api/v2/qhse`, reescrito a `/api/qhse` (ver PATH_REWRITE).
  { target: 'qhse', prefixes: ['/api/v2/qhse'] },
];

/** Prefijos que el gateway reescribe al reenviar al contenedor. */
export const PATH_REWRITE: Record<string, string> = {
  '^/api/v2/catalogos': '/api/catalogos',
  '^/api/v2/qhse': '/api/qhse',
};

/** Rutas que no exigen token en el gateway aunque vayan a un contenedor. */
export const PUBLIC_PATHS: readonly string[] = [
  '/api/auth/login',
  '/api/auth/refresh',
  '/api/auth/jwks',
];

/**
 * Rutas públicas con un tramo variable. El formulario de una encuesta lo abre el cliente con el enlace del correo, sin sesión: el
 * token (de 43 caracteres, 256 bits) es lo que autoriza. Solo ese tramo; el resto de `/api/encuestas` exige token de sesión.
 */
export const PUBLIC_PATH_PATTERNS: readonly RegExp[] = [
  /^\/api\/encuestas\/publico\/[A-Za-z0-9_-]{20,128}$/,
];

export type TargetUrls = Partial<Record<ContainerName, string>>;

export interface ResolvedTarget {
  name: ContainerName;
  url: string;
}

const matches = (pathname: string, prefix: string) =>
  pathname === prefix || pathname.startsWith(`${prefix}/`);

/** El contenedor que atiende la ruta, o `null` si ninguno la atiende (el gateway responde 404). */
export function resolveTarget(pathname: string, urls: TargetUrls): ResolvedTarget | null {
  for (const rule of ROUTE_RULES) {
    const url = urls[rule.target];
    if (url && rule.prefixes.some((p) => matches(pathname, p))) {
      return { name: rule.target, url };
    }
  }
  return null;
}

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.includes(pathname) || PUBLIC_PATH_PATTERNS.some((p) => p.test(pathname));
}
