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
