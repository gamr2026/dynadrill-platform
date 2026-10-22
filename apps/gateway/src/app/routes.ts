/**
 * Tabla de rutas del gateway (documento de arquitectura, anexo E). Los prefijos son los de la demo,
 * porque el contrato HTTP del frontend está congelado. Lo que ningún contenedor nuevo atiende
 * todavía (o cuyo contenedor no tiene URL configurada) cae en `demo-legacy` (cap. 16.1).
 */
export type ContainerName = 'plataforma' | 'comercial' | 'operaciones' | 'qhse';

interface RouteRule {
  target: ContainerName;
  prefixes: string[];
}

export const ROUTE_RULES: RouteRule[] = [
  {
    target: 'plataforma',
    // Solo lo que el contenedor ya implementa: una ruta que ningún módulo atiende devolvería 404 en vez
    // de caer en demo-legacy. Se agregan `/api/catalogos` y `/api/files` cuando existan esos módulos.
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
      // Catálogos del contenedor nuevo (ids UUID). `/api/catalogos` sigue siendo el de la demo (ids numéricos) y el
      // gateway reescribe este prefijo a `/api/catalogos` al reenviarlo (ver PATH_REWRITE).
      '/api/v2/catalogos',
    ],
  },
  // `/api/facturacion` se suma aquí en el CORTE de Pedidos (plan: PLAN-MIGRACION-PEDIDOS.md §7); hasta entonces sigue
  // en demo-legacy. Mientras tanto el contenedor expone lo nuevo bajo `/api/comercial`.
  { target: 'comercial', prefixes: ['/api/comercial'] },
  // Solo lo que el contenedor ya implementa (Pumping nuevo). Los prefijos de la demo (`/api/operations`, `/api/unidades`,
  // `/api/maintenance-orders`, `/api/articulos`...) se suman aquí a medida que cada módulo se migra; hasta entonces
  // siguen en demo-legacy.
  { target: 'operaciones', prefixes: ['/api/operaciones'] },
  // QHSE nuevo (ids UUID) bajo `/api/v2/qhse`, reescrito a `/api/qhse` (ver PATH_REWRITE). `/api/qhse` sigue siendo el QHSE de la demo
  // (ids numéricos) y cae en demo-legacy hasta el corte de cada subdominio.
  { target: 'qhse', prefixes: ['/api/v2/qhse'] },
];

/** Prefijos que el gateway reescribe al reenviar al contenedor. */
export const PATH_REWRITE: Record<string, string> = {
  '^/api/v2/catalogos': '/api/catalogos',
  '^/api/v2/qhse': '/api/qhse',
};

/** Rutas que no exigen token en el gateway aunque vayan a un contenedor nuevo. */
export const PUBLIC_PATHS: readonly string[] = [
  '/api/auth/login',
  '/api/auth/refresh',
  '/api/auth/jwks',
];

export type TargetUrls = Partial<Record<ContainerName, string>> & { legacy: string };

export interface ResolvedTarget {
  name: ContainerName | 'legacy';
  url: string;
}

const matches = (pathname: string, prefix: string) =>
  pathname === prefix || pathname.startsWith(`${prefix}/`);

export function resolveTarget(pathname: string, urls: TargetUrls): ResolvedTarget {
  for (const rule of ROUTE_RULES) {
    const url = urls[rule.target];
    if (url && rule.prefixes.some((p) => matches(pathname, p))) {
      return { name: rule.target, url };
    }
  }
  return { name: 'legacy', url: urls.legacy };
}

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.includes(pathname);
}
