import { ModuleRoles } from './module-roles';
import { ADMIN_ROLE_CODES, RoleCode } from './role-code';
import type { PermissionDef } from './permissions';

/**
 * Permisos del MENÚ lateral: uno por destino. Deciden qué ve cada rol en el menú, no qué puede hacer:
 * las funciones siguen protegidas por sus permisos funcionales (que ningún rol pierde por esto).
 *
 * Esquema: `menu.<grupo>_<destino>.ver`. El módulo es siempre `menu`, el recurso junta grupo y destino
 * (así la pantalla de roles muestra una fila por destino, agrupadas por el prefijo del grupo) y la acción
 * es siempre `ver`, la acción estándar. «Inicio» no tiene permiso: lo ve todo el mundo.
 *
 * `defaultRoles` reproduce EXACTAMENTE lo que cada rol veía en el menú antes de que dependiera de permisos
 * (el `switch` por nombre de rol de `navigation.service.ts` del frontend). Ojo: no coincide siempre con el
 * permiso funcional (p. ej. Jefe de Base tiene acceso total en el backend, pero a pedido del cliente su menú
 * solo muestra Pumping y Flota). Se siembran una sola vez; después los edita un administrador.
 */

/** `[código, descripción, roles que lo ven hoy]`. */
type MenuRow = readonly [code: string, descripcion: string, roles: readonly RoleCode[]];

const SA = RoleCode.SUPERADMIN;
const JB = RoleCode.JEFE_BASE;
const HSE = [RoleCode.TECNICO_HSE, RoleCode.GERENTE_HSE] as const;

/** Destinos que hoy ya salían de un permiso funcional: mismos roles por defecto que ese permiso. */
const FLOTA_UNIDADES: readonly RoleCode[] = [
  ...ModuleRoles.maintenanceReadOps,
  RoleCode.BODEGUERO,
  RoleCode.CONDUCTOR,
];
/** `flota.inspecciones.ver` y `flota.conductores.ver` comparten roles por defecto. */
const FLOTA_INSPECCIONES: readonly RoleCode[] = [
  ...ModuleRoles.maintenanceReadOps,
  RoleCode.CONDUCTOR,
];
const FLOTA_CONDUCTORES = FLOTA_INSPECCIONES;
/**
 * Gerenciamiento de viaje: unión de solicitar / aprobar / autorizar_mayor, sin el Conductor (`ocultoParaRol`):
 * él completa su gerenciamiento desde «Mis viajes» y la bandeja no le toca aunque su rol traiga el permiso.
 */
const FLOTA_VIAJES: readonly RoleCode[] = [
  ...new Set<RoleCode>([
    ...ModuleRoles.gerenciamientoViajeApprove,
    ...ADMIN_ROLE_CODES,
    RoleCode.GERENTE_HSE,
  ]),
];

const MENU: readonly MenuRow[] = [
  // Ventas (hoy «Facturación» en el frontend)
  [
    'menu.ventas_pedidos.ver',
    'Ver en el menú: Ventas › Pedidos',
    [SA, RoleCode.FACTURACION, RoleCode.INGENIERIA_VENTAS],
  ],
  [
    'menu.ventas_prefacturas.ver',
    'Ver en el menú: Ventas › Prefacturas',
    [SA, RoleCode.FACTURACION],
  ],
  [
    'menu.ventas_lista_precios.ver',
    'Ver en el menú: Ventas › Lista de precios',
    [SA, RoleCode.FACTURACION],
  ],
  ['menu.ventas_reporteria.ver', 'Ver en el menú: Ventas › Reportería', [SA, RoleCode.FACTURACION]],
  // Operaciones
  [
    'menu.operaciones_pumping_pedidos.ver',
    'Ver en el menú: Operaciones › Pumping › Pedidos',
    [SA, JB, RoleCode.SUPERVISOR_PUMPING, RoleCode.OPERADOR],
  ],
  [
    'menu.operaciones_pumping_aprobaciones.ver',
    'Ver en el menú: Operaciones › Pumping › Aprobaciones',
    [RoleCode.SUPERVISOR_PUMPING],
  ],
  [
    'menu.operaciones_fcr_pedidos.ver',
    'Ver en el menú: Operaciones › FCR › Pedidos',
    [SA, RoleCode.SUPERVISOR, RoleCode.OPERADOR_FCR, RoleCode.SUPERVISOR_OPERACIONES_FCR, ...HSE],
  ],
  [
    'menu.operaciones_fcr_codigos.ver',
    'Ver en el menú: Operaciones › FCR › Códigos por cliente',
    [SA],
  ],
  [
    'menu.operaciones_mis_viajes.ver',
    'Ver en el menú: Operaciones › Mis viajes (portal del Conductor)',
    [RoleCode.CONDUCTOR],
  ],
  // QHSE: Indicadores y los destinos de Planificación, Registros y Eventos
  ['menu.qhse_indicadores.ver', 'Ver en el menú: QHSE › Indicadores', [SA, ...HSE]],
  ['menu.qhse_iperc.ver', 'Ver en el menú: QHSE › Planificación › IPERC', [SA, ...HSE]],
  ['menu.qhse_ptw.ver', 'Ver en el menú: QHSE › Planificación › PTW / Recibimiento', [SA, ...HSE]],
  [
    'menu.qhse_documentos.ver',
    'Ver en el menú: QHSE › Planificación › Documentos por pedido',
    [SA, ...HSE],
  ],
  [
    'menu.qhse_terminos.ver',
    'Ver en el menú: QHSE › Planificación › Términos y condiciones',
    [SA, ...HSE],
  ],
  [
    'menu.qhse_legal.ver',
    'Ver en el menú: QHSE › Planificación › Cumplimiento legal',
    [SA, ...HSE],
  ],
  [
    'menu.qhse_objetivos.ver',
    'Ver en el menú: QHSE › Planificación › Objetivos ambientales',
    [SA, ...HSE],
  ],
  ['menu.qhse_inspecciones.ver', 'Ver en el menú: QHSE › Registros › Inspecciones', [SA, ...HSE]],
  ['menu.qhse_desechos.ver', 'Ver en el menú: QHSE › Registros › Desechos', [SA, ...HSE]],
  [
    'menu.qhse_aspectos.ver',
    'Ver en el menú: QHSE › Registros › Aspectos ambientales',
    [SA, ...HSE],
  ],
  ['menu.qhse_epi.ver', 'Ver en el menú: QHSE › Registros › Entrega de EPI', [SA, ...HSE]],
  ['menu.qhse_stop.ver', 'Ver en el menú: QHSE › Eventos › STOP', [SA, ...HSE]],
  ['menu.qhse_swa.ver', 'Ver en el menú: QHSE › Eventos › Stop Work Authority', [SA, ...HSE]],
  [
    'menu.qhse_incidentes.ver',
    'Ver en el menú: QHSE › Eventos › Incidentes y Emergencias',
    [SA, ...HSE],
  ],
  // Flota y mantenimiento
  ['menu.flota_unidades.ver', 'Ver en el menú: Flota y mantenimiento › Unidades', FLOTA_UNIDADES],
  [
    'menu.flota_conductores.ver',
    'Ver en el menú: Flota y mantenimiento › Conductores',
    FLOTA_CONDUCTORES,
  ],
  [
    'menu.flota_inspecciones.ver',
    'Ver en el menú: Flota y mantenimiento › Inspecciones',
    FLOTA_INSPECCIONES,
  ],
  [
    'menu.flota_viajes.ver',
    'Ver en el menú: Flota y mantenimiento › Gerenciamiento de viaje',
    FLOTA_VIAJES,
  ],
  [
    'menu.flota_bandeja.ver',
    'Ver en el menú: Flota y mantenimiento › Bandeja de mantenimiento',
    [SA, RoleCode.JEFE_MANTENIMIENTO],
  ],
  [
    'menu.flota_indicadores.ver',
    'Ver en el menú: Flota y mantenimiento › Indicadores de mantenimiento',
    [SA, RoleCode.JEFE_MANTENIMIENTO],
  ],
  [
    'menu.flota_mis_tareas.ver',
    'Ver en el menú: Flota y mantenimiento › Mis tareas de mantenimiento',
    [RoleCode.OPERADOR_MANTENIMIENTO],
  ],
  [
    'menu.flota_mantenimiento.ver',
    'Ver en el menú: Flota y mantenimiento › Mantenimiento operativo',
    [RoleCode.OPERADOR],
  ],
  // Inventario
  [
    'menu.inventario_articulos.ver',
    'Ver en el menú: Inventario › Artículos',
    [SA, RoleCode.BODEGUERO],
  ],
  [
    'menu.inventario_vehiculos.ver',
    'Ver en el menú: Inventario › Vehículos',
    [SA, RoleCode.BODEGUERO],
  ],
  [
    'menu.inventario_mis_tareas.ver',
    'Ver en el menú: Inventario › Mis tareas',
    [SA, RoleCode.BODEGUERO],
  ],
  // Configuración. Usuarios, Roles, Auditoría y Encuestas salen de los permisos funcionales que hoy los muestran.
  [
    'menu.configuracion_catalogos.ver',
    'Ver en el menú: Configuración › Catálogos',
    [SA, RoleCode.INGENIERIA_VENTAS],
  ],
  [
    'menu.configuracion_usuarios.ver',
    'Ver en el menú: Configuración › Usuarios',
    ModuleRoles.users,
  ],
  ['menu.configuracion_roles.ver', 'Ver en el menú: Configuración › Roles y permisos', [SA]],
  ['menu.configuracion_encuestas.ver', 'Ver en el menú: Configuración › Encuestas', [SA]],
  ['menu.configuracion_auditoria.ver', 'Ver en el menú: Configuración › Auditoría', [SA]],
];

export const MENU_PERMISSION_CATALOG: readonly PermissionDef[] = MENU.map(
  ([code, descripcion, defaultRoles]) => {
    const [modulo, recurso, accion] = code.split('.');
    return { code, modulo, recurso, accion, descripcion, matrixKey: null, defaultRoles };
  },
);
