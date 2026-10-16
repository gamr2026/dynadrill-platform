# Informe de evaluación · firmas-ocr

Ejecutado con el contenedor real (OpenCV 4.10, Tesseract spa+eng), pipeline completo con OCR,
semilla sintética 3. Tiempo medio por documento: 3,7 s (máximo 21 s, un PDF de 5 páginas).
Reproducir: ver `README.md`, sección "Evaluación". Resultados por caso: `salida/resultados.json`.

**Resumen honesto:** sobre los 4 escaneos reales con firma manuscrita el servicio acierta 4 de 4,
pero **son solo 4 documentos (8 firmas) y los pesos del detector se ajustaron mirando esos mismos
documentos**. Esa cifra no demuestra que vaya a funcionar con otros escaneos. El único otro
dato real es que en 23 PDF sin firma manuscrita hubo 1 falso positivo.

## Qué se evaluó

| Conjunto                                                                                                                        | Casos | Verdad                      |
| ------------------------------------------------------------------------------------------------------------------------------- | ----: | --------------------------- |
| `real_manuscrita`: 4 escaneos de Órdenes de Trabajo (OPR / `3976_SOP`) con 2 firmas a mano cada uno                             |     4 | firma detectada             |
| `real_firma_electronica`: los otros 23 PDF de SOPORTES EJEMPLO (sellos FirmaEC con QR, gráficos, mapas, fotos)                  |    23 | no detectada (ver límite 1) |
| Sintéticos positivos: formularios generados con firma dibujada, y firma pegada sobre páginas reales de los PDF                  |    48 | firma detectada             |
| Sintéticos negativos: texto tipeado, nombre en fuente cursiva, sello redondo, QR, texto denso, gráficos, foto, página en blanco |    24 | no detectada                |
| Degradados: firma presente pero imagen a 22 % de resolución o muy desenfocada                                                   |     8 | firma detectada             |

Cada caso puede ser acierto, **abstención** (`no_concluyente`) o fallo (falso positivo / falso negativo).

## Resultados

| Categoría                         |   Casos | Aciertos | Abstenciones | Falsos negativos | Falsos positivos |
| --------------------------------- | ------: | -------: | -----------: | ---------------: | ---------------: |
| real_manuscrita                   |       4 |        4 |            0 |                0 |                0 |
| real_firma_electronica            |      23 |       21 |            1 |                0 |                1 |
| sintetica_positiva_formulario     |      24 |       23 |            1 |                0 |                0 |
| sintetica_positiva_sobre_pdf_real |      24 |       22 |            2 |                0 |                0 |
| sintetica_negativa_tipeado        |       3 |        3 |            0 |                0 |                0 |
| sintetica_negativa_nombre_cursivo |       3 |        3 |            0 |                0 |                0 |
| sintetica_negativa_sello_redondo  |       3 |        3 |            0 |                0 |                0 |
| sintetica_negativa_codigo_qr      |       3 |        3 |            0 |                0 |                0 |
| sintetica_negativa_texto_denso    |       3 |        3 |            0 |                0 |                0 |
| sintetica_negativa_grafico        |       3 |        0 |            3 |                0 |                0 |
| sintetica_negativa_foto           |       3 |        0 |            3 |                0 |                0 |
| sintetica_negativa_en_blanco      |       3 |        0 |            3 |                0 |                0 |
| degradada_baja_resolucion         |       4 |        4 |            0 |                0 |                0 |
| degradada_borrosa                 |       4 |        0 |            4 |                0 |                0 |
| **TOTAL**                         | **107** |   **89** |       **17** |            **0** |            **1** |

Las pruebas unitarias y de API (`pytest`) pasan: 46 de 46.

## Fallos y abstenciones, uno por uno

- **Falso positivo real (1):** `3836_EDYL-013_GRÁFICOS MONITOREO-signed-signed.pdf` (2 páginas de
  curvas de monitoreo) se declara `firma_detectada` con confianza 1,00. Las curvas de un gráfico
  son trazos finos, oblicuos y sueltos: localmente se parecen a una firma. La regla "página con
  demasiados candidatos → no concluyente" marca una de sus páginas pero la otra queda con 3 o
  menos candidatos y pasa. **Un gráfico con pocas curvas puede dar falso positivo.**
- **Abstención en un PDF real:** `3976_GNTD-043_GEO.pdf` (mapa) → `no_concluyente` por exceso de
  trazos. Es la respuesta correcta para un mapa.
- **Abstenciones en sintéticos (16):**
  gráficos (3), fotos (3) y hojas en blanco (3): el servicio prefiere abstenerse. Para una hoja en
  blanco esto es discutible (no hay firma, pero también se pide revisión humana).
  Firmas muy desenfocadas (4): la binarización las borra y la página queda "casi en blanco".
  Dos firmas sobre PDF reales caen en páginas de gráficos; una firma del formulario sintético
  obtuvo puntaje 0,54 (entre 0,50 y 0,60).
- **Falsos negativos: 0** en esta corrida. No significa que no existan: una firma pequeña
  (alto menor de ~3 % de la página, ~70 px a 200 dpi) o una rúbrica de una sola línea puntúa bajo
  por diseño (la puerta de tamaño), y los 4 escaneos reales traían firmas grandes y claras.

## Cómo se llegó a estas cifras (lo que debe saber para interpretarlas)

- El detector se ajustó iterando sobre los 4 escaneos reales, los 23 PDF y los sintéticos de las
  semillas 1 y 2. En ese proceso se agregaron reglas específicas: descartar códigos QR (por
  alternancia tinta/papel), sellos redondos (concentración radial) y páginas con gráficos.
  La semilla 3 (la de este informe) no se usó para ajustar, pero **los 27 PDF reales sí**: sus
  resultados son optimistas.
- Una regla de QR anterior (patrones de esquina) falló con otra versión de OpenCV y con firmas
  reales; se reemplazó por la de alternancia. Muestra que estas reglas son frágiles.
- Los sintéticos los genera el propio proyecto (`sinteticos.py`). Una firma dibujada con curvas
  suaves no es una firma real; que el detector acierte en ellas prueba poco.

## Límites conocidos

1. **Los PDF con sello FirmaEC no llevan firma manuscrita**, así que se etiquetaron como "no
   detectada". La etiqueta se basa en haber mirado las zonas de firma de unos 12 de los 23
   documentos (el resto se asumió por pertenecer a las mismas familias de formato). El servicio
   informa de la firma electrónica aparte (`firma_electronica`) pero **no valida** firmas digitales.
2. Solo hay 4 escaneos con firma manuscrita real, de un único formato (Orden de Trabajo,
   contratista y EP Petroecuador). Sin más muestras (fotos de celular, otras tintas, firmas
   pequeñas, sellos con firma encima, hojas torcidas) no se puede estimar la tasa real de aciertos.
3. Las firmas que se solapan con texto impreso se detectan (las reales lo hacen), pero la caja
   puede incluir trozos de texto y el `texto_cercano` puede traer ruido (p. ej. líneas de la tabla
   superior en una firma grande).
4. El texto cercano asume la distribución de los formatos de Dynadrill (nombre y cargo bajo la
   firma, columna izquierda/derecha de la página).
5. `coincidencias` compara palabra por palabra con tolerancia a errores de OCR; un nombre de una
   sola palabra común puede coincidir por azar con el texto del documento.
6. El puntaje y la `confianza` no son probabilidades calibradas.

## Recomendación de uso

Tratar `firma_detectada` como "revisar esta zona", `no_detectada` como "no se vio firma
manuscrita" y `no_concluyente` como "revisar a mano". Antes de apoyarse en el servicio,
reunir 50 a 100 escaneos reales con y sin firma, etiquetarlos y volver a correr
`evaluar.py` añadiéndolos a `etiquetas.json`.
