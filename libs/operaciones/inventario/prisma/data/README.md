# Datos de carga de Inventario

## `inventario.json`, `descuentos.json`

Exports reales de AS2 tomados del `main` de la demo: 641 artículos con costo y saldo, y el descuento sugerido por código. Los carga
`npm run db:cargar:inventario` (idempotente).

## `epp.json` — equipo de protección personal (EPP)

Reporte «Atributos por Producto» de AS2 (`INVENTARIO PRODUCTO ATRIBUTO AS2.xlsx`, impreso el 17/10/2026 por DIGITEC), categoría
**EQUIPO PROTECCION PERSONAL (EPP)**, subcategoría «INV EPP»: 74 productos (`EPP-0001` a `EPP-0074`). Lo carga
`npm run db:cargar:epp` (idempotente; no registra saldos porque el reporte no trae existencias). El archivo ya viene **depurado**:

| Qué se hizo               | Productos                                                                                                                              | Por qué                                                                                                           |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Excluidos                 | `EPP-0068` a `EPP-0072` (overoles «bordado» con nombre y apellido de un empleado)                                                      | Dato personal dentro del nombre del producto; no va a un catálogo compartido                                      |
| Fusionados por talla      | `EPP-0039` a `0042` en `EPP-0038` (botas de seguridad); `0050`, `0051` en `0049` (botas de caucho); `0065` a `0067` en `0073` (overol) | AS2 maneja cada talla como un producto aparte. La talla **no es parte del artículo**: se elige al entregar (QHSE) |
| Fusionados por duplicado  | `EPP-0006` en `0005` (mismo nombre)                                                                                                    | Duplicado                                                                                                         |
| Fusionados por digitación | `EPP-0047` («PATALON JEANS») en `0048` («PANTALON JEANS»)                                                                              | Error de digitación                                                                                               |
| Nombre corregido          | `EPP-0052` (IMPEREMEABLE → IMPERMEABLE), `EPP-0073` (→ OVEROL)                                                                         | Digitación; el código no cambia                                                                                   |

Los códigos fusionados se conservan en `articulo_equivalencia` (con su motivo) para conciliar con AS2 por cualquiera de ellos.

Resultado: **58 artículos** (74 − 5 excluidos − 11 fusionados), de los cuales **37 se entregan a una persona**
(`entrega_personal`, formato DYN-SGI-RE-032) y llevan su tipo de talla (`ropa`, `calzado` o `guante`; 9 de guante, 6 de ropa, 2 de
calzado y 20 sin talla). Los otros 21 son equipo de las instalaciones, no de entrega personal (6 extintores, absorbentes y
barreras, fundas industriales, cadena y cinta, barreta, talacho, acerrín, botiquín, lavaojos, puente de batería): quedan en
Inventario como artículos, sin entrega personal.

QHSE recibe los 37 por el evento `operaciones.inventario.articulo_epi_actualizado` (réplica `qhse.epi_elemento`).
Para volver a mandarlos: `POST /api/operaciones/inventario/articulos/epi/republicar` (permiso `inventario.articulos.gestionar`).

**Pendiente de confirmar con Dynadrill:** qué productos de «entrega personal» se entregan de verdad (la clasificación la hizo
Claude a partir del nombre) y los seriales que AS2 guarda en la columna de nombre comercial de los extintores.

## `as2-bienes.json` — bienes de AS2 que Inventario no tenía

Del mismo reporte de AS2: los productos de las categorías de **bienes** que no estaban en Inventario. Los carga `npm run db:cargar:bienes`
(idempotente; sin saldos, costo ni bodega porque el reporte no los trae; unidad «Unidad» por defecto).

| Categoría de AS2                                       | Artículos nuevos |
| ------------------------------------------------------ | ---------------- |
| QUIMICA                                                | 342              |
| COMPLETION BIENES                                      | 98               |
| FISHING CONSUMO                                        | 129              |
| FISHING & TOOLS                                        | 46               |
| MANTENIMIENTO (suministros y mantenimiento: repuestos) | 653              |
| **Total**                                              | **1.268**        |

**Los servicios no se cargan**: «SERVICIO FISHING», «SERVICIOS PUMPING», «COMPLETION SERVICIOS», «SERVICIOS COILED TUBING» y «SERVICIOS» son
conceptos de facturación (listas de precios de Comercial), y «COMPRA IVA», «COMPRA 0%» y «GASTOS INDIRECTOS» son conceptos contables.

**Códigos con espacios (normalización).** El alta de artículos no admite espacios en el código. La regla (`src/catalog/codigos.ts`): los
espacios alrededor de «-» y «/» se pegan y los demás pasan a «-» (`DYFE - 100` → `DYFE-100`; `CT-MCR/ CT95706 9/5` →
`CT-MCR/CT95706-9/5`). El código original queda como equivalencia con el motivo `formato`. Si el normalizado ya es de otro producto de AS2
(que sí venía limpio), el normalizado recibe el sufijo `-2`: `DYFE - 200` → `DYFE-200-2`, `DYS - 302` → `DYS-302-2`, `DYFE - 100` → `DYFE-100-2`.
Se normalizaron 103 códigos de este archivo y los 78 de la carga inicial de la demo (`npm run db:normalizar:codigos`, idempotente).
**Orden de carga:** `db:cargar:inventario`, `db:cargar:epp`, `db:cargar:bienes` y al final `db:normalizar:codigos`.

**Sin nombre en AS2:** 51 productos (casi todos de completion y fishing) no traen nombre ni nombre comercial; se cargan con su código
como nombre y una nota que lo dice.

**No se cargó:** la marca (casi siempre «GENERAL») ni el proveedor (GTM-ECUADOR S.A. en los de mantenimiento, ASOCIACION GRUPO 4 REGION
ORIENTE en el EPP), porque Inventario no tiene catálogo de proveedores; si Mantenimiento o Compras lo necesitan, se modela como tabla y se
vuelve a leer del reporte.

**Repuestos.** La categoría MANTENIMIENTO lleva la marca `es_repuesto` (el comportamiento depende de la marca, no del nombre):
`GET /api/operaciones/inventario/articulos?repuestos=true&q=<texto>` devuelve solo repuestos y suministros. Es lo que Mantenimiento
ofrece al registrar el repuesto usado de una sub-orden (`mantenimiento.suborden_repuesto.articulo_id`, FK a `inventario.articulo`).
