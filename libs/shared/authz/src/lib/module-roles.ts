import { ALL_ROLE_CODES, RoleCode, withAdmins } from './role-code';

/**
 * La matriz de acceso por módulo (Capa A), en un solo lugar. Derivada de los
 * `roleGuard` de ruta y el `sidebar.ts` del `dynadrill-frontend` — ver
 * docs/PLAN-PROFESIONALIZACION.md.
 *
 * `withAdmins(...)` agrega Superadmin + Jefe de Base (acceso total). Donde NO
 * deben entrar (`users`), la lista es explícita y sin ellos.
 *
 * Uso en un controller:  `@Roles(...ModuleRoles.qhse)`
 */
export const ModuleRoles = {
  /** Administración de usuarios — SOLO Superadmin (ni Jefe de Base). */
  users: [RoleCode.SUPERADMIN],

  /** Escritura de catálogos de ubicación. La lectura es de cualquier autenticado (sin @Roles). */
  catalogosWrite: withAdmins(RoleCode.INGENIERIA_VENTAS),
  /**
   * Escritura del catálogo de personas de contacto y clientes del Pedido —
   * a pedido del cliente, lo gestiona Ventas (igual que el alta de Pedidos).
   * La lectura es de cualquier autenticado (poblar los selects con búsqueda).
   */
  personasWrite: withAdmins(RoleCode.INGENIERIA_VENTAS),

  /** Pedidos: Facturación + Ventas (Ventas solo Pedidos, no el resto del módulo). */
  pedidos: withAdmins(RoleCode.FACTURACION, RoleCode.INGENIERIA_VENTAS),
  /**
   * Lectura de Documentos Operativos — la lista de Pedidos (`pedidos-list-page`)
   * los trae junto con los pedidos (notificación "llegó hace <72h") vía
   * `forkJoin`: si esto 403, se cae TODO el forkJoin y la tabla de pedidos
   * queda vacía para Ventas aunque `GET /pedidos` sí haya funcionado. La
   * escritura (POST) sigue en `documentosOperativosPush`, sin cambios.
   *
   * Supervisor/Operador también leen acá: "ver documentos generados del
   * ticket" (Job Log) desde la pestaña de Tickets Aprobados de Pumping usa
   * este mismo endpoint (`listDePedido`) — sin esto, el Supervisor recibía
   * un 403 al abrir ese modal aunque él mismo haya empujado esos documentos
   * (ver `documentosOperativosPush`, que ya lo incluye).
   */
  documentosOperativosRead: withAdmins(
    RoleCode.FACTURACION,
    RoleCode.INGENIERIA_VENTAS,
    RoleCode.SUPERVISOR,
    RoleCode.SUPERVISOR_PUMPING,
    RoleCode.OPERADOR,
  ),
  /**
   * Alta de un Pedido (`POST`) — solo Ventas, a pedido del cliente: el
   * registro es responsabilidad exclusiva de Ventas; Facturación solo ve lo
   * que Ventas carga y puede editarlo después (sigue en `ModuleRoles.pedidos`),
   * pero no puede dar de alta un pedido nuevo.
   */
  pedidosCreate: withAdmins(RoleCode.INGENIERIA_VENTAS),
  /**
   * Lectura de un Pedido puntual (`GET :id`) — además de quien ya puede
   * escribir Pedidos, los roles de FCR necesitan ver de solo lectura el
   * Pedido que originó su ticket (fase 'revision_inicial': Supervisor revisa la
   * propuesta/pedido completa antes de aprobar). Mismo criterio en espejo
   * que `ModuleRoles.fcrRead` incluye a Facturación para el sentido inverso.
   * HSE también: desde el listado de PTW ve los ítems estimados del Pedido
   * vinculado, para dar contexto de qué se va a usar en el trabajo (ver
   * `VerPedidoDialog` desde `ptw-list-page`).
   */
  pedidosRead: withAdmins(
    RoleCode.FACTURACION,
    RoleCode.INGENIERIA_VENTAS,
    RoleCode.SUPERVISOR,
    RoleCode.SUPERVISOR_PUMPING,
    RoleCode.OPERADOR,
    RoleCode.OPERADOR_FCR,
    RoleCode.BODEGUERO,
    RoleCode.SUPERVISOR_OPERACIONES_FCR,
    RoleCode.TECNICO_HSE,
    RoleCode.GERENTE_HSE,
  ),
  /** Resto de Facturación: listas de precios, prefacturas, guías, AOT, documentos operativos. */
  facturacion: withAdmins(RoleCode.FACTURACION),
  /**
   * Solicitud de Despacho a Bodega (correlación con "Orden Salida Material"
   * de AS2) — ambos lados la necesitan ver: Facturación la crea y consulta,
   * Bodega la ve en su bandeja para resolverla.
   */
  solicitudDespachoBodegaRead: withAdmins(RoleCode.FACTURACION, RoleCode.BODEGUERO),
  /** Solo Bodega resuelve (despacha/rechaza) la solicitud — Facturación únicamente la crea. */
  solicitudDespachoBodegaGestion: withAdmins(RoleCode.BODEGUERO),
  /**
   * Solo lectura de Listas de Precios (GET) — Ventas la necesita en
   * "Nuevo Pedido" para el aviso "código fuera de la Lista de Precios" y
   * para autocompletar el precio unitario al elegir un químico/herramienta
   * de Inventario (ver nuevo-pedido-dialog.ts). Sin esto, `listaService.list()`
   * le daba 403 en silencio y esas dos funcionalidades quedaban rotas para
   * Ventas aunque funcionaran para Facturación (mismo patrón que
   * `articulosRead`). La escritura sigue solo en `ModuleRoles.facturacion`.
   */
  listasPreciosRead: withAdmins(RoleCode.FACTURACION, RoleCode.INGENIERIA_VENTAS),

  /**
   * Empujar un documento operativo (Reporte Job / Herramientas) al pedido —
   * lo hace Operaciones desde el frontend cuando el operador firma el reporte
   * (POST /api/facturacion/documentos-operativos). GET/PUT/DELETE siguen en
   * `ModuleRoles.facturacion`.
   */
  documentosOperativosPush: withAdmins(
    RoleCode.FACTURACION,
    RoleCode.SUPERVISOR,
    RoleCode.SUPERVISOR_PUMPING,
    RoleCode.OPERADOR,
  ),
  /** Prefactura desde el ticket (demo `prefacturaTicket`): ver la vigente o la preliminar y subir la firma del Company Man. */
  prefacturaTicket: withAdmins(RoleCode.SUPERVISOR, RoleCode.SUPERVISOR_PUMPING),

  /**
   * Operaciones · FCR — acceso al módulo (el paso a paso lo restringe el
   * WorkflowRoleGuard). Los 3 roles HSE entran porque firman "Liberado por
   * QHSE" en el checklist de inspección por herramienta (fcr-checklist-inspeccion).
   */
  fcr: withAdmins(
    RoleCode.SUPERVISOR,
    RoleCode.OPERADOR_FCR,
    RoleCode.BODEGUERO,
    RoleCode.SUPERVISOR_OPERACIONES_FCR,
    RoleCode.TECNICO_HSE,
    RoleCode.GERENTE_HSE,
  ),
  /** Operaciones · Pumping — acceso al módulo. */
  pumping: withAdmins(RoleCode.SUPERVISOR, RoleCode.SUPERVISOR_PUMPING, RoleCode.OPERADOR),
  /**
   * Lectura de documentos reales subidos al ticket (monitoreo, mezcla de
   * químicos) — además de Pumping, Facturación necesita recuperarlos desde
   * el Pedido (documentos de respaldo antes de "Enviar al cliente"). Subir/
   * borrar sigue siendo exclusivo de Pumping (`@Roles` de clase).
   */
  pumpingDocumentosRead: withAdmins(
    RoleCode.SUPERVISOR,
    RoleCode.SUPERVISOR_PUMPING,
    RoleCode.OPERADOR,
    RoleCode.FACTURACION,
  ),
  /**
   * Solicitudes de cambio de ítems del pedido (Operador propone, ver/listar
   * las propias) — mismo acceso que el módulo Pumping. La decisión final
   * (aprobar/rechazar) es solo del Supervisor, ver `pumpingAprobarCambioItems`.
   */
  pumpingCambiosItems: withAdmins(
    RoleCode.SUPERVISOR,
    RoleCode.SUPERVISOR_PUMPING,
    RoleCode.OPERADOR,
  ),
  /** Aprobar/rechazar una solicitud de cambio de ítems — solo el Supervisor (bandeja de "Aprobaciones"). */
  pumpingAprobarCambioItems: withAdmins(RoleCode.SUPERVISOR, RoleCode.SUPERVISOR_PUMPING),

  /**
   * Lectura de tickets FCR. Además de los roles operativos, Facturación y
   * Ventas: el detalle del Pedido (`pedido-detail-page`, que ambos abren —
   * ver `ModuleRoles.pedidosRead`) muestra el estado operativo del ticket
   * FCR vinculado (puente Pedido -> FCR) vía un `forkJoin` que incluye
   * `listTickets()` — sin este acceso ese forkJoin 403 completo y ni
   * Facturación ni Ventas pueden abrir el detalle del pedido, aunque
   * `GET /pedidos/:id` sí les haya funcionado. Las acciones del flujo
   * siguen en `ModuleRoles.fcr`.
   */
  fcrRead: withAdmins(
    RoleCode.SUPERVISOR,
    RoleCode.OPERADOR_FCR,
    RoleCode.BODEGUERO,
    RoleCode.INGENIERIA_VENTAS,
    RoleCode.FACTURACION,
    RoleCode.SUPERVISOR_OPERACIONES_FCR,
    RoleCode.TECNICO_HSE,
    RoleCode.GERENTE_HSE,
  ),

  /** Mantenimiento — gestión (Jefe de Mantenimiento + admins). */
  maintenance: withAdmins(RoleCode.JEFE_MANTENIMIENTO),
  /** Lectura de órdenes/reportes: también los dos operadores que trabajan sobre ellas. */
  maintenanceRead: withAdmins(
    RoleCode.JEFE_MANTENIMIENTO,
    RoleCode.OPERADOR,
    RoleCode.OPERADOR_MANTENIMIENTO,
  ),
  /**
   * Ejecuta una sub-orden asignada (guardar diagnóstico/avance, enviar a
   * revisión): el Operador de Mantenimiento en las suyas ("Mis tareas",
   * Mecánico/Instrumental) y el Operador de Pumping/FCR en las
   * "Operativo" derivadas a su bandeja (operator-maintenance-page) —
   * mismo endpoint de `SubOrdersController`, dos poblaciones de operador.
   */
  maintenanceOperatorTasks: withAdmins(
    RoleCode.JEFE_MANTENIMIENTO,
    RoleCode.OPERADOR_MANTENIMIENTO,
    RoleCode.OPERADOR,
    RoleCode.OPERADOR_FCR,
  ),
  /** Reportes de unidad / inspección de vehículo que llena el Operador ("Operativo"). */
  maintenanceOperatorReports: withAdmins(RoleCode.JEFE_MANTENIMIENTO, RoleCode.OPERADOR),
  /** Firma de la inspección de vehículo — el Supervisor (Plan 2026, 5.3). */
  vehicleInspectionApprove: withAdmins(
    RoleCode.SUPERVISOR,
    RoleCode.SUPERVISOR_PUMPING,
    RoleCode.JEFE_MANTENIMIENTO,
  ),

  /** Gerenciamiento de Viaje (DYN-SGI-RE-049) — solo el Conductor lo solicita y ve los suyos. */
  gerenciamientoViajeRequest: withAdmins(RoleCode.CONDUCTOR),
  /**
   * Autorizar/rechazar un Gerenciamiento de Viaje — riesgo BAJO lo autoriza
   * el Supervisor (de Pumping); MEDIO/ALTO lo autoriza el Jefe de Base (ya
   * incluido en `withAdmins`). El corte por nivel de riesgo lo aplica
   * `GerenciamientoViajeController` (un Supervisor que intente autorizar
   * MEDIO/ALTO recibe 403), no esta lista de roles.
   */
  gerenciamientoViajeApprove: withAdmins(RoleCode.SUPERVISOR, RoleCode.SUPERVISOR_PUMPING),

  /**
   * Lectura del dominio de Mantenimiento / Unidades desde el flujo de
   * Operaciones. El ticket de Pumping necesita, según el paso:
   *  - Supervisor: leer órdenes de mantenimiento, reportes de unidad,
   *    inspecciones de vehículo y unidades para validar la salida de las
   *    unidades (Plan 2026, 5.3/5.4) y revisar los mantenimientos operativos.
   *  - Operador: leer unidades e inspecciones para llenar la inspección de
   *    vehículo y el reporte de unidad de salida/llegada.
   * La ESCRITURA de esos módulos sigue restringida a sus roles (abajo, por método).
   */
  maintenanceReadOps: withAdmins(
    RoleCode.JEFE_MANTENIMIENTO,
    RoleCode.OPERADOR_MANTENIMIENTO,
    RoleCode.OPERADOR,
    RoleCode.SUPERVISOR,
    RoleCode.SUPERVISOR_PUMPING,
  ),

  /**
   * Revisar (cerrar / solicitar corrección) una sub-orden de mantenimiento
   * Operativo. En Pumping la revisa el Supervisor en el paso `mantenimiento`,
   * una vez que el Jefe de Mantenimiento la derivó a Operaciones.
   */
  maintenanceOperativoReview: withAdmins(
    RoleCode.JEFE_MANTENIMIENTO,
    RoleCode.SUPERVISOR,
    RoleCode.SUPERVISOR_PUMPING,
  ),

  /** Inventario — administración de artículos: Bodeguero + Jefe de Mantenimiento. */
  inventario: withAdmins(RoleCode.BODEGUERO, RoleCode.JEFE_MANTENIMIENTO),
  /**
   * Solo lectura del catálogo de artículos (GET) — además de quien
   * consume inventario de verdad, Ventas necesita leerlo al armar un
   * Pedido: el código de un ítem "Químico" se elige del catálogo real de
   * Inventario (categoría QUÍMICA), no se tipea libre (ver
   * nuevo-pedido-dialog.ts) — sin esto, el select quedaba vacío (403
   * silencioso). Separado de `inventarioConsumo`: Ventas NO debe poder
   * registrar movimientos de stock (salida/devolución), solo leer.
   */
  articulosRead: withAdmins(
    RoleCode.BODEGUERO,
    RoleCode.JEFE_MANTENIMIENTO,
    RoleCode.SUPERVISOR,
    RoleCode.SUPERVISOR_PUMPING,
    RoleCode.OPERADOR,
    RoleCode.INGENIERIA_VENTAS,
  ),
  /**
   * Consumo de inventario: leer el catálogo de artículos y registrar
   * movimientos (salida/devolución). Lo usa además el flujo de Pumping cuando
   * el Supervisor/Operador asigna químicos a un ticket y devuelve el sobrante.
   */
  inventarioConsumo: withAdmins(
    RoleCode.BODEGUERO,
    RoleCode.JEFE_MANTENIMIENTO,
    RoleCode.SUPERVISOR,
    RoleCode.SUPERVISOR_PUMPING,
    RoleCode.OPERADOR,
  ),

  /** QHSE — staff HSE. El Supervisor NO entra (corregido a pedido del cliente, ver qhse.routes.ts). */
  qhse: withAdmins(RoleCode.TECNICO_HSE, RoleCode.GERENTE_HSE),
  /** Aprobar una Matriz IPERC — solo el Gerente HSE (sin admins). */
  ipercApprove: [RoleCode.GERENTE_HSE],
  /**
   * Activar un flujo "Reportar" (Stop Work Authority, Tarjeta STOP,
   * inspección pre-operacional, alerta de derrame/emergencia): HSE-MASTER-001
   * lo asigna a "Cualquier Trabajador". La gestión posterior del evento
   * (evaluar, cerrar) sigue siendo `qhse`.
   */
  reportarQhse: [...ALL_ROLE_CODES],
} as const satisfies Record<string, readonly RoleCode[]>;
