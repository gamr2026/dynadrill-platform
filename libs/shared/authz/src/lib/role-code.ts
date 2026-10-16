/**
 * Identificadores estables de rol para autorización. Se corresponden 1:1 con
 * la columna `roles.code` (ver prisma/seed.ts) y NUNCA con `roles.name`, que
 * lleva tildes/espacios y es texto de UI.
 *
 * La matriz "qué rol puede qué" está en docs/PLAN-PROFESIONALIZACION.md,
 * derivada de los guards de ruta del `dynadrill-frontend`.
 */
export const RoleCode = {
  SUPERVISOR: 'supervisor',
  /** Supervisor exclusivo de Pumping (supervisor.pumping@dynadrill.com) — mismas acciones que SUPERVISOR pero solo dentro de Pumping/Aprobaciones, nunca FCR. */
  SUPERVISOR_PUMPING: 'supervisor_pumping',
  OPERADOR: 'operador',
  /** Operador exclusivo de FCR (operador.fcr@dynadrill.com) — mismas acciones que OPERADOR pero solo dentro de FCR, nunca Pumping. operador@dynadrill.com (Pumping) ya no entra a FCR. */
  OPERADOR_FCR: 'operador_fcr',
  JEFE_BASE: 'jefe_base',
  JEFE_MANTENIMIENTO: 'jefe_mantenimiento',
  OPERADOR_MANTENIMIENTO: 'operador_mantenimiento',
  INGENIERIA_VENTAS: 'ingenieria_ventas',
  TECNICO_HSE: 'tecnico_hse',
  GERENTE_HSE: 'gerente_hse',
  BODEGUERO: 'bodeguero',
  SUPERADMIN: 'superadmin',
  FACTURACION: 'facturacion',
  /** Aprueba la entrada SERVICIOS del flujo FCR (fase `aprobacion_supervisor_operaciones`). Distinto del `SUPERVISOR` genérico, que sigue a cargo de la entrada VENTA. */
  SUPERVISOR_OPERACIONES_FCR: 'supervisor_operaciones_fcr',
  /** Conductor — solicita su propio Gerenciamiento de Viaje (DYN-SGI-RE-049). Sin acceso a ningún otro módulo. */
  CONDUCTOR: 'conductor',
} as const;

export type RoleCode = (typeof RoleCode)[keyof typeof RoleCode];

export const ALL_ROLE_CODES: readonly RoleCode[] = Object.values(RoleCode);

/**
 * Roles con acceso total (salvo lo que se restrinja a propósito, como
 * `/api/users`). El frontend trata a Jefe de Base igual que Superadmin.
 */
export const ADMIN_ROLE_CODES = [RoleCode.SUPERADMIN, RoleCode.JEFE_BASE] as const;

/**
 * Agrega Superadmin + Jefe de Base a una lista de roles. Azúcar para los
 * `@Roles(...)` de módulos donde los admin también entran (casi todos).
 *
 * @example @Roles(...withAdmins(RoleCode.FACTURACION, RoleCode.INGENIERIA_VENTAS))
 */
export function withAdmins(...roles: RoleCode[]): RoleCode[] {
  return Array.from(new Set([...roles, ...ADMIN_ROLE_CODES]));
}

export function isRoleCode(value: unknown): value is RoleCode {
  return typeof value === 'string' && (ALL_ROLE_CODES as readonly string[]).includes(value);
}
