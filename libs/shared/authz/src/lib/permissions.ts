import { ModuleRoles } from './module-roles';
import { ADMIN_ROLE_CODES, RoleCode } from './role-code';

/**
 * Catálogo de permisos del sistema (RBAC). Cada permiso es un código `<modulo>.<recurso>.<accion>`.
 *
 * Los permisos los define el código (cada endpoint exige uno) y los roles reciben permisos desde la
 * base de datos (`identidad.rol_permiso`), que un administrador edita desde la app. Este catálogo es
 * también la semilla: `defaultRoles` reproduce exactamente la matriz `ModuleRoles` de la demo, de modo
 * que el día uno nadie gana ni pierde acceso. Después de sembrado, lo manda la base de datos.
 */
export interface PermissionDef {
  code: string;
  modulo: string;
  recurso: string;
  accion: string;
  descripcion: string;
  /** Clave de `ModuleRoles` de la que sale; `null` si el permiso es nuevo y no existía en la matriz. */
  matrixKey: keyof typeof ModuleRoles | null;
  /** Roles que lo reciben al sembrar por primera vez. */
  defaultRoles: readonly RoleCode[];
}

const def = (
  matrixKey: keyof typeof ModuleRoles,
  code: string,
  descripcion: string,
): PermissionDef => {
  const [modulo, recurso, accion] = code.split('.');
  return {
    code,
    modulo,
    recurso,
    accion,
    descripcion,
    matrixKey,
    defaultRoles: ModuleRoles[matrixKey],
  };
};

/** Permiso que no existía en la matriz de la demo: nace aquí, con sus roles por defecto explícitos. */
const nuevo = (
  code: string,
  descripcion: string,
  defaultRoles: readonly RoleCode[],
): PermissionDef => {
  const [modulo, recurso, accion] = code.split('.');
  return { code, modulo, recurso, accion, descripcion, matrixKey: null, defaultRoles };
};

/**
 * Acciones estándar por recurso. La pantalla de roles las muestra como columnas de una matriz; cualquier
 * otra acción (`aprobar`, `operar`, `editar_permisos`...) es propia del negocio y se lista aparte.
 * No todo recurso usa las cinco: p. ej. los documentos se `anulan` y los catálogos/usuarios se `inactivan`.
 */
export const STANDARD_ACTIONS = ['ver', 'crear', 'editar', 'anular', 'inactivar'] as const;

/**
 * Permisos retirados del catálogo y quiénes los reemplazan. La siembra traspasa las asignaciones: todo rol
 * que tenía el permiso viejo recibe los nuevos (aunque un administrador se lo haya dado desde la app) y
 * luego el viejo se elimina. Así un cambio de catálogo nunca le quita acceso a nadie por sorpresa.
 */
export const PERMISSION_REPLACEMENTS: ReadonlyArray<{
  retired: string;
  replacedBy: readonly string[];
}> = [
  {
    retired: 'identidad.usuarios.administrar',
    replacedBy: [
      'identidad.usuarios.ver',
      'identidad.usuarios.crear',
      'identidad.usuarios.editar',
      'identidad.usuarios.inactivar',
    ],
  },
  {
    retired: 'identidad.roles.administrar',
    replacedBy: ['identidad.roles.ver', 'identidad.roles.editar_permisos'],
  },
  {
    retired: 'catalogos.ubicacion.escribir',
    replacedBy: [
      'catalogos.ubicacion.crear',
      'catalogos.ubicacion.editar',
      'catalogos.ubicacion.inactivar',
    ],
  },
  {
    // En la demo un solo permiso cubría clientes y personas de contacto: quien lo tenía conserva ambos.
    retired: 'catalogos.personas.escribir',
    replacedBy: [
      'catalogos.clientes.crear',
      'catalogos.clientes.editar',
      'catalogos.clientes.inactivar',
      'catalogos.personas.crear',
      'catalogos.personas.editar',
      'catalogos.personas.inactivar',
    ],
  },
];

export const PERMISSION_CATALOG: readonly PermissionDef[] = [
  // identidad — usuarios: las cuatro acciones estándar (la baja es lógica, de ahí `inactivar`, no `anular`).
  // Los cuatro salen de la entrada `users` de la matriz de la demo (antes un solo permiso grueso).
  def('users', 'identidad.usuarios.ver', 'Ver la lista y el detalle de los usuarios'),
  def('users', 'identidad.usuarios.crear', 'Crear usuarios nuevos'),
  def('users', 'identidad.usuarios.editar', 'Editar usuarios: datos, rol y contraseña'),
  def(
    'users',
    'identidad.usuarios.inactivar',
    'Inactivar cuentas (cierra sus sesiones; no borra datos)',
  ),
  // identidad — roles: los 17 roles son fijos, así que solo se ven y se les editan los permisos.
  nuevo('identidad.roles.ver', 'Ver los roles, el catálogo de permisos y el historial de cambios', [
    RoleCode.SUPERADMIN,
  ]),
  nuevo('identidad.roles.editar_permisos', 'Asignar y quitar permisos a los roles', [
    RoleCode.SUPERADMIN,
  ]),
  // identidad — copia local de los empleados de AS2 (ERP). Contiene cédulas: solo Superadmin por defecto.
  nuevo(
    'identidad.as2.ver',
    'Ver los empleados de AS2, su historial y el estado de la sincronización',
    [RoleCode.SUPERADMIN],
  ),
  nuevo('identidad.as2.sincronizar', 'Sincronizar a pedido la copia local de empleados con AS2', [
    RoleCode.SUPERADMIN,
  ]),
  nuevo(
    'identidad.as2.crear_cuentas',
    'Crear las cuentas (inactivas) de los empleados activos de AS2 que tienen correo',
    [RoleCode.SUPERADMIN],
  ),
  // integraciones — configuración de las APIs de terceros. Un cambio aquí puede redirigir datos: solo Superadmin.
  nuevo(
    'integraciones.configuracion.ver',
    'Ver los proveedores, sus operaciones, mapeos y la bitácora de integraciones',
    [RoleCode.SUPERADMIN],
  ),
  nuevo(
    'integraciones.configuracion.editar',
    'Editar un proveedor, crear versiones de sus operaciones y activarlas',
    [RoleCode.SUPERADMIN],
  ),
  nuevo(
    'integraciones.configuracion.probar',
    'Probar una versión de una operación llamando al tercero (solo devuelve conteos)',
    [RoleCode.SUPERADMIN],
  ),
  def(
    'pedidos',
    'integraciones.as2_pedidos.ver',
    'Consultar en AS2 los pedidos de cliente (solo lectura) para completarlos o vincularlos',
  ),
  // comercial — documentos y secuenciales (numeración de pedidos, prefacturas...). Solo Superadmin por defecto.
  nuevo(
    'comercial.secuencias.ver',
    'Ver los documentos y sus secuenciales, y los números emitidos',
    [RoleCode.SUPERADMIN],
  ),
  nuevo('comercial.secuencias.editar', 'Anular un número emitido de un documento (con motivo)', [
    RoleCode.SUPERADMIN,
  ]),
  // catálogos — la lectura es abierta a cualquier usuario autenticado (todos los formularios necesitan estos
  // datos), así que solo se protegen las escrituras. Heredan los roles de las entradas de la demo.
  // `ubicacion` agrupa bloques, campos, pozos y taladros.
  def('catalogosWrite', 'catalogos.ubicacion.crear', 'Crear bloques, campos, pozos y taladros'),
  def('catalogosWrite', 'catalogos.ubicacion.editar', 'Editar bloques, campos, pozos y taladros'),
  def(
    'catalogosWrite',
    'catalogos.ubicacion.inactivar',
    'Inactivar bloques, campos, pozos y taladros (no se borran)',
  ),
  def('personasWrite', 'catalogos.clientes.crear', 'Crear clientes'),
  def('personasWrite', 'catalogos.clientes.editar', 'Editar clientes'),
  def('personasWrite', 'catalogos.clientes.inactivar', 'Inactivar clientes (no se borran)'),
  def('personasWrite', 'catalogos.personas.crear', 'Crear personas de contacto'),
  def('personasWrite', 'catalogos.personas.editar', 'Editar personas de contacto'),
  def(
    'personasWrite',
    'catalogos.personas.inactivar',
    'Inactivar personas de contacto (no se borran)',
  ),
  // comercial
  def('pedidos', 'comercial.pedidos.gestionar', 'Ver y editar pedidos (Facturación y Ventas)'),
  def('pedidosCreate', 'comercial.pedidos.crear', 'Dar de alta un pedido nuevo'),
  def('pedidosRead', 'comercial.pedidos.ver', 'Ver el detalle de un pedido de solo lectura'),
  def(
    'pedidos',
    'comercial.pedidos.editar',
    'Editar un pedido (datos, ítems) y llevarlo a corrección',
  ),
  def('facturacion', 'comercial.pedidos.anular', 'Anular un pedido (con motivo)'),
  def(
    'facturacion',
    'comercial.pedidos.rechazar',
    'Devolver un pedido a Ventas para corrección (con motivo)',
  ),
  def(
    'facturacion',
    'comercial.pedidos.asignar_analista',
    'Asignar o reasignar el analista de facturación de un pedido',
  ),
  nuevo(
    'comercial.pedidos.forzar_estado',
    'Forzar el estado de un pedido saltándose el flujo (con motivo; queda registrado)',
    [RoleCode.SUPERADMIN],
  ),
  def(
    'facturacion',
    'comercial.facturacion.gestionar',
    'Listas de precios, prefacturas, guías de remisión y AOT',
  ),
  def('listasPreciosRead', 'comercial.listas_precios.ver', 'Consultar las listas de precios'),
  def(
    'documentosOperativosRead',
    'comercial.documentos_operativos.ver',
    'Ver los documentos operativos de un pedido',
  ),
  def(
    'documentosOperativosPush',
    'comercial.documentos_operativos.enviar',
    'Enviar un documento operativo (Reporte Job o de Herramientas) al pedido',
  ),
  def(
    'facturacion',
    'comercial.documentos_operativos.eliminar',
    'Eliminar un documento operativo del pedido (Facturación)',
  ),
  def(
    'prefacturaTicket',
    'comercial.prefacturas.vista_ticket',
    'Ver desde el ticket la prefactura vigente o una preliminar con lo generado hasta el momento',
  ),
  def(
    'prefacturaTicket',
    'comercial.prefacturas.firma_company_man',
    'Subir desde el ticket el documento firmado por el Company Man (genera o recalcula la prefactura y la deja firmada)',
  ),
  def(
    'facturacion',
    'comercial.documentos_operativos.corregir',
    'Corregir un día del Reporte Job de un pedido antes de que salga al cliente para firmas (Facturación)',
  ),
  def(
    'pedidos',
    'catalogos.transporte.crear',
    'Crear transportistas, vehículos y choferes (para la guía de remisión)',
  ),
  def('pedidos', 'catalogos.transporte.editar', 'Editar transportistas, vehículos y choferes'),
  def(
    'facturacion',
    'catalogos.transporte.inactivar',
    'Inactivar transportistas, vehículos y choferes',
  ),
  def(
    'pedidos',
    'comercial.ordenes_trabajo.ver',
    'Ver la orden de trabajo y el cierre de un pedido',
  ),
  def(
    'facturacion',
    'comercial.ordenes_trabajo.emitir',
    'Generar la orden de trabajo de un pedido',
  ),
  def('facturacion', 'comercial.ordenes_trabajo.firmar', 'Marcar la orden de trabajo como firmada'),
  def(
    'facturacion',
    'comercial.cierre.gestionar',
    'Enviar a control de costos, dejar listo para facturar y registrar la factura del pedido',
  ),
  def('pedidos', 'comercial.guias.ver', 'Ver las guías de remisión de un pedido'),
  def(
    'facturacion',
    'comercial.guias.emitir',
    'Emitir, editar, reasignar el número y anular guías de remisión',
  ),
  def('facturacion', 'comercial.guias.firmar', 'Registrar la guía de remisión firmada'),
  def(
    'facturacion',
    'comercial.despachos.solicitar',
    'Solicitar a Bodega el despacho de un pedido',
  ),
  def('pedidos', 'comercial.prefacturas.ver', 'Ver las prefacturas de un pedido'),
  def(
    'facturacion',
    'comercial.prefacturas.generar',
    'Generar o recalcular la prefactura y registrar su número de ticket',
  ),
  def('facturacion', 'comercial.prefacturas.enviar', 'Enviar la prefactura al cliente'),
  def(
    'facturacion',
    'comercial.prefacturas.firmar',
    'Registrar las firmas de la prefactura y darla por firmada',
  ),
  def(
    'facturacion',
    'comercial.prefacturas.rechazar',
    'Registrar el rechazo de la prefactura por el cliente (con motivo)',
  ),
  // inventario
  def(
    'solicitudDespachoBodegaRead',
    'inventario.despachos.ver',
    'Ver las solicitudes de despacho a bodega',
  ),
  def(
    'solicitudDespachoBodegaGestion',
    'inventario.despachos.gestionar',
    'Despachar o rechazar solicitudes de despacho',
  ),
  def('inventario', 'inventario.articulos.gestionar', 'Administrar artículos y su kardex'),
  def('articulosRead', 'inventario.articulos.ver', 'Consultar el catálogo de artículos'),
  def('inventarioConsumo', 'inventario.movimientos.consumir', 'Registrar consumo de inventario'),
  // fcr
  def('fcr', 'fcr.tickets.operar', 'Operar el flujo de tickets FCR'),
  def('fcrRead', 'fcr.tickets.ver', 'Consultar tickets FCR de solo lectura'),
  // pumping
  def('pumping', 'pumping.tickets.operar', 'Operar el flujo de tickets de Pumping'),
  def(
    'pumpingDocumentosRead',
    'pumping.documentos.ver',
    'Ver los documentos subidos a un ticket de Pumping',
  ),
  def(
    'pumpingCambiosItems',
    'pumping.cambios_items.solicitar',
    'Proponer cambios de ítems del pedido desde Pumping',
  ),
  def(
    'pumpingAprobarCambioItems',
    'pumping.cambios_items.aprobar',
    'Aprobar o rechazar cambios de ítems del pedido',
  ),
  nuevo(
    'pumping.requisitos.puente',
    'Confirmar a mano un requisito de otro módulo que aún no existe (puente temporal del traslado de salida)',
    [RoleCode.SUPERADMIN, RoleCode.JEFE_BASE],
  ),
  nuevo(
    'pumping.ejecucion.formalizar',
    'Formalizar la ejecución: confirmar que el Company Man aprobó el inicio del trabajo',
    [RoleCode.SUPERADMIN, RoleCode.SUPERVISOR, RoleCode.SUPERVISOR_PUMPING],
  ),
  // flota
  def(
    'vehicleInspectionApprove',
    'flota.inspecciones.aprobar',
    'Aprobar la inspección vehicular de salida',
  ),
  def(
    'gerenciamientoViajeRequest',
    'flota.viajes.solicitar',
    'Solicitar el Gerenciamiento de Viaje propio',
  ),
  def(
    'gerenciamientoViajeApprove',
    'flota.viajes.aprobar',
    'Autorizar o rechazar un Gerenciamiento de Viaje',
  ),
  // flota — unidades y lecturas (tramo F1). Lectura: la de la demo para Operaciones más Bodega (patrimonio); escritura: Bodega y Jefe de Mantenimiento.
  nuevo('flota.unidades.ver', 'Consultar las unidades, sus lecturas y alertas preventivas', [
    ...ModuleRoles.maintenanceReadOps,
    RoleCode.BODEGUERO,
  ]),
  nuevo('flota.unidades.crear', 'Dar de alta una unidad', ModuleRoles.inventario),
  nuevo(
    'flota.unidades.editar',
    'Editar los datos de una unidad (incluye el patrimonio)',
    ModuleRoles.inventario,
  ),
  nuevo('flota.unidades.inactivar', 'Dar de baja o reactivar una unidad', ModuleRoles.inventario),
  nuevo(
    'flota.lecturas.registrar',
    'Registrar a mano el horómetro o el kilometraje de una unidad',
    ModuleRoles.maintenance,
  ),
  nuevo(
    'flota.preventivos.registrar',
    'Registrar un mantenimiento preventivo de una unidad',
    ModuleRoles.maintenance,
  ),
  nuevo(
    'flota.proveedores.gestionar',
    'Administrar los proveedores externos de mantenimiento',
    ModuleRoles.maintenance,
  ),
  nuevo(
    'flota.lecturas.anular',
    'Anular una lectura de horómetro o kilometraje mal tomada',
    ModuleRoles.maintenance,
  ),
  nuevo(
    'flota.preventivos.anular',
    'Anular un mantenimiento preventivo mal registrado',
    ModuleRoles.maintenance,
  ),
  // flota — inspección de vehículos y documentos de los conductores (tramos F2 y F3). Ver y crear: quien conduce y quien revisa;
  // anular y administrar documentos: Mantenimiento. Aprobar sigue siendo `flota.inspecciones.aprobar` (matriz de la demo).
  nuevo('flota.inspecciones.ver', 'Consultar las inspecciones de vehículos y sus casos', [
    ...ModuleRoles.maintenanceReadOps,
    RoleCode.CONDUCTOR,
  ]),
  nuevo('flota.inspecciones.crear', 'Registrar la inspección de un vehículo (DYN-SGI-RE-068)', [
    ...ModuleRoles.maintenanceOperatorReports,
    RoleCode.CONDUCTOR,
  ]),
  nuevo(
    'flota.inspecciones.anular',
    'Anular una inspección de vehículo mal registrada',
    ModuleRoles.maintenance,
  ),
  nuevo(
    'flota.conductores.ver',
    'Consultar los documentos con vigencia de los conductores y si reúnen las condiciones',
    [...ModuleRoles.maintenanceReadOps, RoleCode.CONDUCTOR],
  ),
  nuevo(
    'flota.conductores.gestionar',
    'Registrar y anular los documentos de un conductor',
    ModuleRoles.maintenance,
  ),
  // flota — gerenciamiento de viaje (tramo F4): `flota.viajes.aprobar` autoriza los niveles que la tabla `umbral_riesgo_viaje` le asigna
  // (BAJO y MEDIO); el ALTO exige este permiso, que además autoriza cualquier nivel.
  nuevo(
    'flota.viajes.autorizar_mayor',
    'Autorizar o rechazar un Gerenciamiento de Viaje de riesgo ALTO (y cualquier otro nivel)',
    [...ADMIN_ROLE_CODES, RoleCode.GERENTE_HSE],
  ),
  // mantenimiento
  def(
    'maintenance',
    'mantenimiento.ordenes.gestionar',
    'Gestionar órdenes y sub-órdenes de mantenimiento',
  ),
  def('maintenanceRead', 'mantenimiento.ordenes.ver', 'Consultar órdenes de mantenimiento'),
  def(
    'maintenanceOperatorTasks',
    'mantenimiento.tareas.ejecutar',
    'Ejecutar las tareas de mantenimiento asignadas',
  ),
  def(
    'maintenanceOperatorReports',
    'mantenimiento.reportes.gestionar',
    'Crear y gestionar reportes de unidad',
  ),
  def('maintenanceReadOps', 'mantenimiento.operaciones.ver', 'Ver mantenimiento desde Operaciones'),
  def(
    'maintenanceOperativoReview',
    'mantenimiento.revision_operativa.gestionar',
    'Revisar la parte operativa de una sub-orden',
  ),
  // qhse
  def('qhse', 'qhse.general.gestionar', 'Acceso al módulo QHSE'),
  def('ipercApprove', 'qhse.iperc.aprobar', 'Aprobar matrices IPERC'),
  def(
    'reportarQhse',
    'qhse.eventos.reportar',
    'Reportar un evento de seguridad (cualquier trabajador)',
  ),
  // ---- qhse (contenedor nuevo): entrega de EPI (tramo Q1). Los demás subdominios agregan aquí su bloque.
  nuevo(
    'qhse.epi.ver',
    'Ver las entregas de EPI y ropa de trabajo (DYN-SGI-RE-032)',
    ModuleRoles.qhse,
  ),
  nuevo('qhse.epi.crear', 'Registrar a mano una entrega de EPI y sus renglones', ModuleRoles.qhse),
  nuevo(
    'qhse.epi.aprobar',
    'Aprobar o rechazar (con motivo) una solicitud de EPI',
    ModuleRoles.qhse,
  ),
  nuevo(
    'qhse.epi.despachar',
    'Despachar la entrega de EPI, revertirla y registrar la firma de Talento Humano',
    ModuleRoles.qhse,
  ),
];

/** Códigos de permiso para usar en `@RequirePermission(Permission.X)` sin escribir strings sueltos. */
export const Permission = {
  USUARIOS_VER: 'identidad.usuarios.ver',
  USUARIOS_CREAR: 'identidad.usuarios.crear',
  USUARIOS_EDITAR: 'identidad.usuarios.editar',
  USUARIOS_INACTIVAR: 'identidad.usuarios.inactivar',
  ROLES_VER: 'identidad.roles.ver',
  ROLES_EDITAR_PERMISOS: 'identidad.roles.editar_permisos',
  AS2_VER: 'identidad.as2.ver',
  AS2_SINCRONIZAR: 'identidad.as2.sincronizar',
  AS2_CREAR_CUENTAS: 'identidad.as2.crear_cuentas',
  PEDIDOS_EDITAR: 'comercial.pedidos.editar',
  PEDIDOS_ANULAR: 'comercial.pedidos.anular',
  PEDIDOS_RECHAZAR: 'comercial.pedidos.rechazar',
  PEDIDOS_ASIGNAR_ANALISTA: 'comercial.pedidos.asignar_analista',
  PEDIDOS_FORZAR_ESTADO: 'comercial.pedidos.forzar_estado',
  SECUENCIAS_VER: 'comercial.secuencias.ver',
  SECUENCIAS_EDITAR: 'comercial.secuencias.editar',
  INTEGRACIONES_VER: 'integraciones.configuracion.ver',
  INTEGRACIONES_EDITAR: 'integraciones.configuracion.editar',
  INTEGRACIONES_PROBAR: 'integraciones.configuracion.probar',
  AS2_PEDIDOS_VER: 'integraciones.as2_pedidos.ver',
  UBICACION_CREAR: 'catalogos.ubicacion.crear',
  UBICACION_EDITAR: 'catalogos.ubicacion.editar',
  UBICACION_INACTIVAR: 'catalogos.ubicacion.inactivar',
  CLIENTES_CREAR: 'catalogos.clientes.crear',
  CLIENTES_EDITAR: 'catalogos.clientes.editar',
  CLIENTES_INACTIVAR: 'catalogos.clientes.inactivar',
  PERSONAS_CREAR: 'catalogos.personas.crear',
  PERSONAS_EDITAR: 'catalogos.personas.editar',
  PERSONAS_INACTIVAR: 'catalogos.personas.inactivar',
  PEDIDOS_GESTIONAR: 'comercial.pedidos.gestionar',
  PEDIDOS_CREAR: 'comercial.pedidos.crear',
  PEDIDOS_VER: 'comercial.pedidos.ver',
  FACTURACION_GESTIONAR: 'comercial.facturacion.gestionar',
  LISTAS_PRECIOS_VER: 'comercial.listas_precios.ver',
  DOCUMENTOS_OPERATIVOS_VER: 'comercial.documentos_operativos.ver',
  DOCUMENTOS_OPERATIVOS_ENVIAR: 'comercial.documentos_operativos.enviar',
  DOCUMENTOS_OPERATIVOS_ELIMINAR: 'comercial.documentos_operativos.eliminar',
  DOCUMENTOS_OPERATIVOS_CORREGIR: 'comercial.documentos_operativos.corregir',
  PREFACTURAS_VISTA_TICKET: 'comercial.prefacturas.vista_ticket',
  PREFACTURAS_FIRMA_COMPANY_MAN: 'comercial.prefacturas.firma_company_man',
  TRANSPORTE_CREAR: 'catalogos.transporte.crear',
  TRANSPORTE_EDITAR: 'catalogos.transporte.editar',
  TRANSPORTE_INACTIVAR: 'catalogos.transporte.inactivar',
  GUIAS_VER: 'comercial.guias.ver',
  GUIAS_EMITIR: 'comercial.guias.emitir',
  GUIAS_FIRMAR: 'comercial.guias.firmar',
  DESPACHO_SOLICITAR: 'comercial.despachos.solicitar',
  ORDENES_VER: 'comercial.ordenes_trabajo.ver',
  ORDENES_EMITIR: 'comercial.ordenes_trabajo.emitir',
  ORDENES_FIRMAR: 'comercial.ordenes_trabajo.firmar',
  CIERRE_GESTIONAR: 'comercial.cierre.gestionar',
  PREFACTURAS_VER: 'comercial.prefacturas.ver',
  PREFACTURAS_GENERAR: 'comercial.prefacturas.generar',
  PREFACTURAS_ENVIAR: 'comercial.prefacturas.enviar',
  PREFACTURAS_FIRMAR: 'comercial.prefacturas.firmar',
  PREFACTURAS_RECHAZAR: 'comercial.prefacturas.rechazar',
  DESPACHOS_VER: 'inventario.despachos.ver',
  DESPACHOS_GESTIONAR: 'inventario.despachos.gestionar',
  ARTICULOS_GESTIONAR: 'inventario.articulos.gestionar',
  ARTICULOS_VER: 'inventario.articulos.ver',
  INVENTARIO_CONSUMIR: 'inventario.movimientos.consumir',
  FCR_OPERAR: 'fcr.tickets.operar',
  FCR_VER: 'fcr.tickets.ver',
  PUMPING_OPERAR: 'pumping.tickets.operar',
  PUMPING_DOCUMENTOS_VER: 'pumping.documentos.ver',
  PUMPING_CAMBIOS_SOLICITAR: 'pumping.cambios_items.solicitar',
  PUMPING_CAMBIOS_APROBAR: 'pumping.cambios_items.aprobar',
  PUMPING_REQUISITOS_PUENTE: 'pumping.requisitos.puente',
  PUMPING_EJECUCION_FORMALIZAR: 'pumping.ejecucion.formalizar',
  INSPECCIONES_APROBAR: 'flota.inspecciones.aprobar',
  VIAJES_SOLICITAR: 'flota.viajes.solicitar',
  VIAJES_APROBAR: 'flota.viajes.aprobar',
  VIAJES_AUTORIZAR_MAYOR: 'flota.viajes.autorizar_mayor',
  UNIDADES_VER: 'flota.unidades.ver',
  UNIDADES_CREAR: 'flota.unidades.crear',
  UNIDADES_EDITAR: 'flota.unidades.editar',
  UNIDADES_INACTIVAR: 'flota.unidades.inactivar',
  LECTURAS_REGISTRAR: 'flota.lecturas.registrar',
  PREVENTIVOS_REGISTRAR: 'flota.preventivos.registrar',
  PROVEEDORES_MANTENIMIENTO_GESTIONAR: 'flota.proveedores.gestionar',
  LECTURAS_ANULAR: 'flota.lecturas.anular',
  PREVENTIVOS_ANULAR: 'flota.preventivos.anular',
  INSPECCIONES_VER: 'flota.inspecciones.ver',
  INSPECCIONES_CREAR: 'flota.inspecciones.crear',
  INSPECCIONES_ANULAR: 'flota.inspecciones.anular',
  CONDUCTORES_VER: 'flota.conductores.ver',
  CONDUCTORES_GESTIONAR: 'flota.conductores.gestionar',
  MANTENIMIENTO_GESTIONAR: 'mantenimiento.ordenes.gestionar',
  MANTENIMIENTO_VER: 'mantenimiento.ordenes.ver',
  MANTENIMIENTO_TAREAS: 'mantenimiento.tareas.ejecutar',
  MANTENIMIENTO_REPORTES: 'mantenimiento.reportes.gestionar',
  MANTENIMIENTO_OPERACIONES_VER: 'mantenimiento.operaciones.ver',
  MANTENIMIENTO_REVISION: 'mantenimiento.revision_operativa.gestionar',
  QHSE_GESTIONAR: 'qhse.general.gestionar',
  IPERC_APROBAR: 'qhse.iperc.aprobar',
  QHSE_REPORTAR: 'qhse.eventos.reportar',
  EPI_VER: 'qhse.epi.ver',
  EPI_CREAR: 'qhse.epi.crear',
  EPI_APROBAR: 'qhse.epi.aprobar',
  EPI_DESPACHAR: 'qhse.epi.despachar',
} as const;

export type PermissionCode = (typeof Permission)[keyof typeof Permission];

export const ALL_PERMISSION_CODES: readonly string[] = PERMISSION_CATALOG.map((p) => p.code);

/**
 * Permisos que el rol Superadmin NO puede perder: sin ellos nadie podría volver a administrar usuarios
 * ni permisos y el sistema quedaría sin administrador.
 */
export const SUPERADMIN_PROTECTED_PERMISSIONS: readonly string[] = [
  Permission.ROLES_VER,
  Permission.ROLES_EDITAR_PERMISOS,
  Permission.USUARIOS_VER,
  Permission.USUARIOS_EDITAR,
];
