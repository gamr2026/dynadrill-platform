import { ModuleRoles } from './module-roles';
import {
  ALL_PERMISSION_CODES,
  Permission,
  PERMISSION_CATALOG,
  PERMISSION_REPLACEMENTS,
  STANDARD_ACTIONS,
  SUPERADMIN_PROTECTED_PERMISSIONS,
} from './permissions';
import { RoleCode } from './role-code';

describe('catálogo de permisos', () => {
  it('cubre cada entrada de ModuleRoles y cada permiso derivado conserva sus roles por defecto', () => {
    const fromMatrix = PERMISSION_CATALOG.filter((p) => p.matrixKey !== null);
    const keys = new Set(fromMatrix.map((p) => p.matrixKey as string));
    expect([...keys].sort()).toEqual(Object.keys(ModuleRoles).sort());
    for (const p of fromMatrix) {
      expect([...p.defaultRoles].sort()).toEqual([...ModuleRoles[p.matrixKey!]].sort());
    }
  });

  it('una entrada de la matriz puede dar varios permisos (users → ver/crear/editar/inactivar)', () => {
    const usuarios = PERMISSION_CATALOG.filter((p) => p.matrixKey === 'users');
    expect(usuarios.map((p) => p.accion).sort()).toEqual(['crear', 'editar', 'inactivar', 'ver']);
    // los cuatro heredan los mismos roles que el permiso grueso de la demo: nadie gana ni pierde acceso
    for (const p of usuarios) expect(p.defaultRoles).toEqual([RoleCode.SUPERADMIN]);
  });

  it('los códigos son únicos y siguen <modulo>.<recurso>.<accion>', () => {
    expect(new Set(ALL_PERMISSION_CODES).size).toBe(ALL_PERMISSION_CODES.length);
    for (const p of PERMISSION_CATALOG) {
      expect(p.code).toMatch(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/);
      expect(p.code).toBe(`${p.modulo}.${p.recurso}.${p.accion}`);
      expect(p.descripcion.length).toBeGreaterThan(5);
    }
  });

  it('el objeto Permission y el catálogo declaran los mismos códigos', () => {
    expect(Object.values(Permission).sort()).toEqual([...ALL_PERMISSION_CODES].sort());
  });

  it('en identidad solo existen los permisos granulares: los gruesos están retirados', () => {
    const identidad = ALL_PERMISSION_CODES.filter((c) => c.startsWith('identidad.'));
    expect(identidad.sort()).toEqual([
      'identidad.as2.crear_cuentas',
      'identidad.as2.sincronizar',
      'identidad.as2.ver',
      'identidad.roles.editar_permisos',
      'identidad.roles.ver',
      'identidad.usuarios.crear',
      'identidad.usuarios.editar',
      'identidad.usuarios.inactivar',
      'identidad.usuarios.ver',
    ]);
    expect(ALL_PERMISSION_CODES).not.toContain('identidad.usuarios.administrar');
    expect(ALL_PERMISSION_CODES).not.toContain('identidad.roles.administrar');
  });

  it('cada permiso retirado tiene reemplazos que existen y que no son él mismo', () => {
    for (const { retired, replacedBy } of PERMISSION_REPLACEMENTS) {
      expect(ALL_PERMISSION_CODES).not.toContain(retired);
      expect(replacedBy.length).toBeGreaterThan(0);
      for (const code of replacedBy) expect(ALL_PERMISSION_CODES).toContain(code);
    }
  });

  it('catálogos: la lectura es abierta y las escrituras heredan los roles de la demo', () => {
    const cat = PERMISSION_CATALOG.filter((p) => p.modulo === 'catalogos');
    expect(cat.map((p) => p.code).sort()).toEqual([
      'catalogos.clientes.crear',
      'catalogos.clientes.editar',
      'catalogos.clientes.inactivar',
      'catalogos.personas.crear',
      'catalogos.personas.editar',
      'catalogos.personas.inactivar',
      'catalogos.transporte.crear',
      'catalogos.transporte.editar',
      'catalogos.transporte.inactivar',
      'catalogos.ubicacion.crear',
      'catalogos.ubicacion.editar',
      'catalogos.ubicacion.inactivar',
    ]);
    expect(cat.some((p) => p.accion === 'ver')).toBe(false); // lectura abierta, sin permiso
    for (const p of cat.filter((x) => x.recurso === 'ubicacion'))
      expect(p.matrixKey).toBe('catalogosWrite');
    // el transporte (guía de remisión) lo opera Facturación: tiene sus propios roles, no los de personas
    for (const p of cat.filter((x) => x.recurso !== 'ubicacion' && x.recurso !== 'transporte'))
      expect(p.matrixKey).toBe('personasWrite');
  });

  it('quien tenía el permiso grueso de personas conserva clientes Y personas (la demo los juntaba)', () => {
    const rep = PERMISSION_REPLACEMENTS.find((r) => r.retired === 'catalogos.personas.escribir')!;
    expect(rep.replacedBy.filter((c) => c.startsWith('catalogos.clientes.'))).toHaveLength(3);
    expect(rep.replacedBy.filter((c) => c.startsWith('catalogos.personas.'))).toHaveLength(3);
  });

  it('los permisos de roles nuevos solo los recibe Superadmin por defecto', () => {
    for (const code of [Permission.ROLES_VER, Permission.ROLES_EDITAR_PERMISOS]) {
      const p = PERMISSION_CATALOG.find((x) => x.code === code)!;
      expect(p.defaultRoles).toEqual([RoleCode.SUPERADMIN]);
      expect(p.matrixKey).toBeNull();
    }
  });

  it('los permisos protegidos de Superadmin existen y los tiene por defecto', () => {
    expect(SUPERADMIN_PROTECTED_PERMISSIONS).toEqual([
      'identidad.roles.ver',
      'identidad.roles.editar_permisos',
      'identidad.usuarios.ver',
      'identidad.usuarios.editar',
    ]);
    for (const code of SUPERADMIN_PROTECTED_PERMISSIONS) {
      const p = PERMISSION_CATALOG.find((x) => x.code === code)!;
      expect(p.defaultRoles).toContain(RoleCode.SUPERADMIN);
    }
  });

  it('las acciones estándar son las cinco acordadas', () => {
    expect([...STANDARD_ACTIONS]).toEqual(['ver', 'crear', 'editar', 'anular', 'inactivar']);
  });
});
