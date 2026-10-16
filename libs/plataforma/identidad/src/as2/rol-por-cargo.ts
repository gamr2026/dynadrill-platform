import type { RoleCode } from '@dyn/authz';

const sinTildes = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Reglas en orden: gana la primera que coincide. Son un BORRADOR a partir del cargo en AS2, no una decisión. */
const REGLAS: ReadonlyArray<readonly [RegExp, RoleCode]> = [
  [/JEFE DE BASE/, 'jefe_base' as RoleCode],
  [/GERENTE.*(QHSE|HSE|SSO)/, 'gerente_hse' as RoleCode],
  [/(QHSE|\bHSE\b|SEGURIDAD|AMBIENTE)/, 'tecnico_hse' as RoleCode],
  [/JEFE DE MANTENIMIENTO/, 'jefe_mantenimiento' as RoleCode],
  [/(MECANIC|SOLDADOR|MANTENIMIENTO)/, 'operador_mantenimiento' as RoleCode],
  [/(FISHING|\bFCR\b)/, 'operador_fcr' as RoleCode],
  // Decisión del 13/10/2026: contadores y personal administrativo usan el rol de facturación.
  [/(FACTURACION|CONTAD|CONTABLE|ADMINISTRATIV)/, 'facturacion' as RoleCode],
  // Talento humano usa el rol técnico de QHSE (el más básico de esa línea).
  [/TALENTO HUMANO/, 'tecnico_hse' as RoleCode],
  [/(BODEGUER|DESPACHADOR|AUXILIAR DE BASE)/, 'bodeguero' as RoleCode],
  [/(CONDUCTOR|CHOFER)/, 'conductor' as RoleCode],
  [/VENTAS/, 'ingenieria_ventas' as RoleCode],
  [
    /(OPERADOR|AUXILIAR DE OPERACIONES|TRAINEE|ESPECIALISTA DE CAMPO|OPERACIONES)/,
    'operador' as RoleCode,
  ],
];

export interface RolSugerido {
  rol: RoleCode;
  /** false: ninguna regla reconoció el cargo y se dejó el rol más básico; hay que asignarlo a mano. */
  reconocido: boolean;
}

/**
 * Rol del portal que se sugiere para un cargo de AS2. NO concede acceso por sí solo: las cuentas nacen inactivas y
 * un administrador revisa el rol antes de activarlas. Los cargos de AS2 no siempre reflejan la función real.
 */
export function sugerirRol(cargo: string | null | undefined): RolSugerido {
  const texto = sinTildes((cargo ?? '').toUpperCase());
  for (const [patron, rol] of REGLAS) if (patron.test(texto)) return { rol, reconocido: true };
  return { rol: 'operador' as RoleCode, reconocido: false };
}
