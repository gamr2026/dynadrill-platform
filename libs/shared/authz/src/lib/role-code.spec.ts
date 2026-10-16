import { ModuleRoles } from './module-roles';
import { ADMIN_ROLE_CODES, ALL_ROLE_CODES, isRoleCode, RoleCode, withAdmins } from './role-code';

describe('authz', () => {
  it('define los 15 roles vigentes (sin Ingeniería de Ventas FCR ni Coordinador HSE)', () => {
    expect(ALL_ROLE_CODES).toHaveLength(15);
    expect(new Set(ALL_ROLE_CODES).size).toBe(15);
  });

  it('withAdmins agrega Superadmin y Jefe de Base sin duplicar', () => {
    const roles = withAdmins(RoleCode.FACTURACION, RoleCode.SUPERADMIN);
    for (const admin of ADMIN_ROLE_CODES) expect(roles).toContain(admin);
    expect(roles.filter((r) => r === RoleCode.SUPERADMIN)).toHaveLength(1);
  });

  it('users es solo Superadmin; ipercApprove excluye administradores', () => {
    expect(ModuleRoles.users).toEqual([RoleCode.SUPERADMIN]);
    expect(ModuleRoles.ipercApprove).not.toContain(RoleCode.SUPERADMIN);
  });

  it('toda entrada de ModuleRoles usa solo roles válidos', () => {
    for (const [permiso, roles] of Object.entries(ModuleRoles)) {
      for (const r of roles) expect([permiso, isRoleCode(r)]).toEqual([permiso, true]);
    }
  });

  it('reportarQhse admite a todos los roles', () => {
    expect(ModuleRoles.reportarQhse).toHaveLength(15);
  });
});
