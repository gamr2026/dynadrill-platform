import { ModuleRoles } from './module-roles';
import {
  ALL_PERMISSION_CODES,
  Permission,
  PERMISSION_CATALOG,
  PERMISSION_REPLACEMENTS,
  STANDARD_ACTIONS,
  SUPERADMIN_PROTECTED_PERMISSIONS,
} from './permissions';
import { MENU_PERMISSION_CATALOG } from './menu-permissions';
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

  it('el objeto Permission y el catálogo declaran los mismos códigos (los de menú no se usan en @RequirePermission)', () => {
    const sinMenu = ALL_PERMISSION_CODES.filter((c) => !c.startsWith('menu.'));
    expect(Object.values(Permission).sort()).toEqual([...sinMenu].sort());
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

  it('cada permiso retirado no está en el catálogo y sus reemplazos, si los tiene, existen y no son él mismo', () => {
    for (const { retired, replacedBy } of PERMISSION_REPLACEMENTS) {
      expect(ALL_PERMISSION_CODES).not.toContain(retired);
      expect(replacedBy).not.toContain(retired);
      for (const code of replacedBy) expect(ALL_PERMISSION_CODES).toContain(code);
    }
  });

  it('un permiso retirado sin reemplazo se declara a propósito (lista cerrada)', () => {
    expect(
      PERMISSION_REPLACEMENTS.filter((r) => r.replacedBy.length === 0).map((r) => r.retired),
    ).toEqual(['comercial.cierre.gestionar', 'pumping.requisitos.puente', 'fcr.requisitos.puente']);
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
      'catalogos.unidades_medida.crear',
      'catalogos.unidades_medida.editar',
      'catalogos.unidades_medida.inactivar',
    ]);
    expect(cat.some((p) => p.accion === 'ver')).toBe(false); // lectura abierta, sin permiso
    for (const p of cat.filter((x) => x.recurso === 'ubicacion'))
      expect(p.matrixKey).toBe('catalogosWrite');
    // el transporte (guía de remisión) lo opera Facturación: tiene sus propios roles, no los de personas
    // las unidades de medida (IN9) las administra quien administra los artículos: la matriz de Inventario
    for (const p of cat.filter((x) => x.recurso === 'unidades_medida'))
      expect(p.matrixKey).toBe('inventario');
    for (const p of cat.filter(
      (x) => !['ubicacion', 'transporte', 'unidades_medida'].includes(x.recurso),
    ))
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

describe('permisos dedicados (exonerar, responsable, disponibilidad, revisar documentos)', () => {
  const defaults = (code: string) =>
    [...PERMISSION_CATALOG.find((p) => p.code === code)!.defaultRoles].sort();
  const R = RoleCode;

  it('exonerar un requisito: Pumping como quien reabre jornadas; FCR como quien supervisa el ticket', () => {
    expect(defaults(Permission.PUMPING_REQUISITOS_EXONERAR)).toEqual(
      defaults(Permission.PUMPING_JORNADA_REABRIR),
    );
    expect(defaults(Permission.FCR_REQUISITOS_EXONERAR)).toEqual(
      [R.SUPERADMIN, R.JEFE_BASE, R.SUPERVISOR, R.SUPERVISOR_OPERACIONES_FCR].sort(),
    );
  });

  it('responsable del ticket: FCR para quien supervisa; Pumping para el Jefe de Base y Superadmin', () => {
    expect(defaults(Permission.FCR_RESPONSABLE_GESTIONAR)).toEqual(
      defaults(Permission.FCR_REQUISITOS_EXONERAR),
    );
    expect(defaults(Permission.PUMPING_RESPONSABLE_GESTIONAR)).toEqual(
      [R.SUPERADMIN, R.JEFE_BASE].sort(),
    );
  });

  it('disponibilidad del personal: Jefe de Base y Superadmin; revisar documentos QHSE: los mismos que los gestionan', () => {
    expect(defaults(Permission.PUMPING_DISPONIBILIDAD_VER)).toEqual(
      [R.SUPERADMIN, R.JEFE_BASE].sort(),
    );
    expect(defaults(Permission.DOCUMENTOS_REVISAR)).toEqual(
      defaults(Permission.DOCUMENTOS_GESTIONAR),
    );
  });

  it('cada permiso dedicado se otorga solo a roles que ya podían entrar al módulo con el permiso general', () => {
    const dentro = (nuevo: string, general: string) => {
      const g = new Set(defaults(general));
      for (const r of defaults(nuevo)) expect(g.has(r)).toBe(true);
    };
    dentro(Permission.FCR_REQUISITOS_EXONERAR, Permission.FCR_OPERAR);
    dentro(Permission.FCR_RESPONSABLE_GESTIONAR, Permission.FCR_OPERAR);
    dentro(Permission.PUMPING_RESPONSABLE_GESTIONAR, Permission.PUMPING_OPERAR);
    dentro(Permission.PUMPING_DISPONIBILIDAD_VER, Permission.PUMPING_OPERAR);
  });
});

describe('permisos de menú', () => {
  const menu = PERMISSION_CATALOG.filter((p) => p.modulo === 'menu');
  const verDe = (rol: RoleCode) =>
    menu
      .filter((p) => p.defaultRoles.includes(rol))
      .map((p) => p.code.replace(/^menu\./, '').replace(/\.ver$/, ''))
      .sort();
  const defaults = (code: string) => PERMISSION_CATALOG.find((p) => p.code === code)!.defaultRoles;

  it('el catálogo incluye todos los de menu, con la forma menu.<grupo>_<destino>.ver y descripción en español', () => {
    expect(menu).toHaveLength(MENU_PERMISSION_CATALOG.length);
    for (const p of menu) {
      expect(p.accion).toBe('ver');
      expect(p.recurso).toMatch(
        /^(ventas|operaciones|qhse|flota|inventario|configuracion)_[a-z0-9_]+$/,
      );
      expect(p.descripcion.startsWith('Ver en el menú: ')).toBe(true);
      expect(p.matrixKey).toBeNull();
    }
  });

  it('los permisos de menú son solo de menú: no los exige ningún endpoint ni protegen a Superadmin', () => {
    for (const p of menu) expect(Object.values(Permission)).not.toContain(p.code);
    expect(SUPERADMIN_PROTECTED_PERMISSIONS.some((c) => c.startsWith('menu.'))).toBe(false);
  });

  it('los destinos que hoy salen de un permiso funcional heredan sus roles por defecto', () => {
    const igual = (menuCode: string, funcional: string) =>
      expect([...defaults(menuCode)].sort()).toEqual([...defaults(funcional)].sort());
    igual('menu.flota_unidades.ver', Permission.UNIDADES_VER);
    igual('menu.flota_inspecciones.ver', Permission.INSPECCIONES_VER);
    igual('menu.flota_conductores.ver', Permission.CONDUCTORES_VER);
    igual('menu.configuracion_usuarios.ver', Permission.USUARIOS_VER);
    igual('menu.configuracion_roles.ver', Permission.ROLES_VER);
    igual('menu.configuracion_auditoria.ver', Permission.AUDITORIA_VER);
    igual('menu.configuracion_encuestas.ver', Permission.ENCUESTAS_GESTIONAR);
  });

  it('Gerenciamiento de viaje: unión de solicitar/aprobar/autorizar_mayor sin el Conductor', () => {
    const unionFuncional = new Set<RoleCode>([
      ...defaults(Permission.VIAJES_SOLICITAR),
      ...defaults(Permission.VIAJES_APROBAR),
      ...defaults(Permission.VIAJES_AUTORIZAR_MAYOR),
    ]);
    unionFuncional.delete(RoleCode.CONDUCTOR);
    expect([...defaults('menu.flota_viajes.ver')].sort()).toEqual([...unionFuncional].sort());
    expect(defaults('menu.flota_viajes.ver')).not.toContain(RoleCode.CONDUCTOR);
  });

  it('matriz de menú por defecto: Jefe de Base ve solo Pumping y Flota (como hoy)', () => {
    expect(verDe(RoleCode.JEFE_BASE)).toEqual([
      'flota_conductores',
      'flota_inspecciones',
      'flota_unidades',
      'flota_viajes',
      'operaciones_pumping_pedidos',
    ]);
  });

  it('matriz de menú por defecto: Supervisor Pumping', () => {
    expect(verDe(RoleCode.SUPERVISOR_PUMPING)).toEqual([
      'flota_conductores',
      'flota_inspecciones',
      'flota_unidades',
      'flota_viajes',
      'operaciones_pumping_aprobaciones',
      'operaciones_pumping_pedidos',
    ]);
  });

  it('matriz de menú por defecto: Gerente HSE', () => {
    expect(verDe(RoleCode.GERENTE_HSE)).toEqual([
      'flota_viajes',
      'operaciones_fcr_pedidos',
      'qhse_aspectos',
      'qhse_desechos',
      'qhse_documentos',
      'qhse_epi',
      'qhse_incidentes',
      'qhse_indicadores',
      'qhse_inspecciones',
      'qhse_iperc',
      'qhse_legal',
      'qhse_objetivos',
      'qhse_ptw',
      'qhse_stop',
      'qhse_swa',
      'qhse_terminos',
    ]);
  });

  it('matriz de menú por defecto: Bodeguero ve Inventario y la lectura de Flota', () => {
    expect(verDe(RoleCode.BODEGUERO)).toEqual([
      'flota_unidades',
      'inventario_articulos',
      'inventario_mis_tareas',
      'inventario_vehiculos',
    ]);
  });

  it('matriz de menú por defecto: Superadmin ve todo menos lo que hoy es de otro rol', () => {
    const todos = menu.map((p) => p.recurso).sort();
    const sinSuyo = new Set([
      'operaciones_pumping_aprobaciones',
      'operaciones_mis_viajes',
      'flota_mis_tareas',
      'flota_mantenimiento',
    ]);
    expect(verDe(RoleCode.SUPERADMIN)).toEqual(todos.filter((r) => !sinSuyo.has(r)));
  });

  it('el Conductor ve Mis viajes y la lectura de Flota, pero no la bandeja de Gerenciamiento de viaje', () => {
    expect(verDe(RoleCode.CONDUCTOR)).toEqual([
      'flota_conductores',
      'flota_inspecciones',
      'flota_unidades',
      'operaciones_mis_viajes',
    ]);
  });
});
