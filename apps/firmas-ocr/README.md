# firmas-ocr · ayuda para revisar firmas manuscritas

Microservicio de Facturación. Dado un PDF o una imagen escaneada, indica si se detecta una
**firma manuscrita**, dónde está, con qué confianza y qué texto la rodea (nombre, cargo).

> **Es solo una ayuda para que Facturación revise. Nunca certifica la autenticidad de una
> firma.** Un resultado "firma detectada" significa "hay trazos que parecen una firma
> manuscrita en esta zona", no "esta persona firmó". El detalle de aciertos y fallos
> está en [`evaluacion/INFORME.md`](evaluacion/INFORME.md); léalo antes de confiar en él.

Proyecto Python autocontenido, **fuera de Nx** (no tiene `project.json`).

## Resultados posibles

| `resultado`       | Significado                                                                                                             |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `firma_detectada` | Hay al menos un grupo de trazos con puntaje ≥ 0,60. Se devuelven sus cajas.                                             |
| `no_detectada`    | Ningún grupo de trazos alcanza 0,50 y la calidad de la imagen es suficiente.                                            |
| `no_concluyente`  | Imagen de mala calidad, página con gráficos/planos/fotos, o trazos dudosos (0,50–0,60). **Debe revisarlo una persona.** |

Los documentos con **firma electrónica** (FirmaEC) y sin trazos manuscritos dan
`no_detectada` (o `no_concluyente`), con la observación correspondiente y el campo
`firma_electronica`. Para validar esas firmas digitales use `POST /v1/firma-electronica`
(sección siguiente).

## Privacidad

- Todo corre en el contenedor: no hay llamadas a internet en ejecución.
- No se guarda ningún documento. Tesseract recibe la imagen por stdin y devuelve el texto
  por stdout (sin archivos temporales). En compose el sistema de archivos es de solo lectura
  y `/tmp` es memoria (Starlette puede volcar cargas grandes a `/tmp`; ahí desaparece).
- Los logs no incluyen contenido de los documentos.

## API

Autenticación de servicio a servicio con la llave interna en `X-API-Key` (solo en `/v1/*`).

### `GET /salud`

```json
{ "estado": "ok", "version": "1.0.0", "ocr_disponible": true, "raices_cargadas": 1 }
```

### `POST /v1/verificar` (`multipart/form-data`)

| Campo             | Obligatorio | Descripción                                                                                                 |
| ----------------- | ----------- | ----------------------------------------------------------------------------------------------------------- |
| `archivo`         | sí          | PDF, PNG, JPEG, TIFF o BMP (se decide por el contenido, no por el nombre).                                  |
| `nombre_esperado` | no          | Se busca (tolerando errores de OCR) junto a las firmas y, si no, en todo el documento. Máx. 200 caracteres. |
| `cargo_esperado`  | no          | Igual que el nombre.                                                                                        |

```bash
curl -H "X-API-Key: dev_firmas_ocr" \
  -F "archivo=@orden.pdf" -F "nombre_esperado=Katalina Coello" \
  http://localhost:8090/v1/verificar
```

Respuesta (resumida):

```json
{
  "resultado": "firma_detectada",
  "confianza": 0.95,
  "firmas": [
    {
      "pagina": 1,
      "caja": {
        "x": 0.19,
        "y": 0.88,
        "ancho": 0.09,
        "alto": 0.03,
        "x_px": 330,
        "y_px": 1932,
        "ancho_px": 156,
        "alto_px": 71
      },
      "confianza": 0.81,
      "texto_cercano": "Nombre: Ing. Katalina Coello\nCargo: Representante Legal"
    }
  ],
  "texto": [{ "pagina": 1, "texto": "ORDEN DE TRABAJO ..." }],
  "coincidencias": {
    "nombre": {
      "esperado": "Katalina Coello",
      "encontrado": true,
      "similitud": 1.0,
      "ubicacion": "cerca_de_firma"
    },
    "cargo": null
  },
  "firma_electronica": { "campos_firma_pdf": 0, "sello_texto": false },
  "observaciones": [],
  "paginas_analizadas": 1,
  "duracion_ms": 4683,
  "aviso": "Ayuda para la revisión de Facturación: ..."
}
```

- `caja`: relativa a la página (0–1) y en píxeles de la página renderizada (200 dpi para PDF).
- `confianza` (raíz): confianza en el `resultado` indicado. En `firma_detectada` es el puntaje
  de la mejor firma; en `no_detectada`, `1 − mejor puntaje descartado`; en `no_concluyente`,
  el mejor puntaje descartado (no es una probabilidad calibrada).

### `POST /v1/firma-electronica` (`multipart/form-data`, solo `archivo` PDF)

Valida las firmas digitales incrustadas (PAdES / PKCS#7) con pyHanko, **sin salir a internet**.
Responde siempre que el PDF se pueda leer, aunque no llegue a una raíz conocida:
en ese caso la firma se informa como **"firmante no verificado"**.

```bash
curl -H "X-API-Key: dev_firmas_ocr" -F "archivo=@documento-firmado.pdf"   http://localhost:8090/v1/firma-electronica
```

Por cada firma (`firmas[]`):

| Campo                                | Contenido                                                                                                                                                                                                                                                             |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `integridad.estado`                  | `intacto` · `intacto_con_revisiones_posteriores` (otras firmas/formularios después) · `modificado_despues_de_firmar` · `firma_invalida` (los bytes firmados no coinciden). Además `firma_valida`, `documento_intacto`, `cobertura`, `cambios_posteriores`, `detalle`. |
| `firmante`                           | `nombre`, `identificacion` (cédula/RUC; de los OID de Security Data, ANF y Lazzate, o del `serialNumber`) y `correo`.                                                                                                                                                 |
| `emisor` / `certificado`             | CN y organización del emisor; serie, vigencia y huella SHA-256 del certificado.                                                                                                                                                                                       |
| `fecha_firma` + `origen_fecha`       | `sello_de_tiempo` si hay un sello válido; si no, `declarada_por_el_firmante` (no prueba cuándo se firmó).                                                                                                                                                             |
| `vigente_al_firmar`                  | El certificado estaba dentro de su vigencia en `fecha_firma` (`null` si no hay fecha).                                                                                                                                                                                |
| `cadena`                             | `reconocida` y `entidad` (raíz cargada a la que llega). `raiz_declarada_en_pdf` es la raíz que el PDF dice usar: **no es de confianza**, solo indica cuál pedir a la entidad.                                                                                         |
| `firmante_verificado` / `conclusion` | Verdadero solo si la firma es íntegra, el certificado estaba vigente y la cadena llega a una raíz cargada.                                                                                                                                                            |

`estado` global: `sin_firmas_digitales` · `verificado` · `verificado_con_advertencias` ·
`firmantes_no_verificados` (íntegro, pero algún firmante sin verificar) · `alterado` (alguna firma
inválida, o cambios posteriores a la última firma).

**Raíces de confianza:** son configuración, no código. Se leen al arrancar de la carpeta
`FIRMAS_OCR_RAICES_DIR` (por defecto `raices/`); ver [`raices/README.md`](raices/README.md).
Hoy trae las raíces de **ANF AC Ecuador, Security Data, Uanataca y Banco Central del Ecuador** (con sus intermedias; el detalle, las huellas y su origen están en `raices/README.md`). **Falta la de Lazzate** y las de otras entidades acreditadas por ARCOTEL: no se deben tomar de un PDF. Mientras falten, sus firmantes salen como "no verificados" aunque el documento esté íntegro. `GET /salud` informa `raices_cargadas`.

Límites: **no se consulta la revocación** (OCSP/CRL; el servicio no sale a internet; la
respuesta lo indica con `revocacion: "no_verificada"`), y la fecha de firma normalmente es la que declara
el firmante. Los PDF de FirmaEC con xref híbrido se leen en modo tolerante. En los documentos de
ejemplo, la primera firma de varios PDF de Security Data aparece como `modificado_despues_de_firmar`:
el generador reescribió la estructura de etiquetas del PDF tras esa firma. El `estado` global no
lo trata como alteración si la última firma cubre el archivo completo.

### Errores

Cuerpo: `{ "error": { "codigo": "...", "mensaje": "..." } }`

| HTTP | `codigo`                                           | Cuándo                                                                                                                       |
| ---- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 400  | `solicitud_invalida`                               | Falta `archivo` o está vacío.                                                                                                |
| 401  | `no_autorizado`                                    | `X-API-Key` ausente o inválida (se revisa antes de leer el cuerpo).                                                          |
| 413  | `archivo_demasiado_grande`                         | Supera `FIRMAS_OCR_MAX_BYTES` (10 MB).                                                                                       |
| 415  | `tipo_no_soportado`                                | No es PDF ni imagen soportada (`/v1/firma-electronica` acepta solo PDF).                                                     |
| 422  | `documento_no_procesable` / `parametros_invalidos` | PDF/imagen corrupto o con contraseña, más de `MAX_PAGINAS` páginas, imagen enorme en píxeles, o parámetros fuera de formato. |
| 504  | `tiempo_agotado`                                   | El análisis superó `FIRMAS_OCR_TIMEOUT_S` (60 s).                                                                            |
| 503  | `ocr_no_disponible`                                | Tesseract no está instalado en el entorno (no ocurre en el contenedor).                                                      |

## Configuración (variables de entorno)

| Variable                         | Defecto         |                                                                                           |
| -------------------------------- | --------------- | ----------------------------------------------------------------------------------------- |
| `FIRMAS_OCR_API_KEY`             | — (obligatoria) | El servicio no arranca sin ella. En compose: `dev_firmas_ocr`. En Azure, desde Key Vault. |
| `FIRMAS_OCR_MAX_BYTES`           | 10485760        | Tamaño máximo del archivo.                                                                |
| `FIRMAS_OCR_MAX_PAGINAS`         | 10              | Páginas máximas.                                                                          |
| `FIRMAS_OCR_TIMEOUT_S`           | 60              | Tiempo máximo por solicitud.                                                              |
| `FIRMAS_OCR_MAX_CONCURRENTES`    | 2               | Análisis simultáneos (el resto espera dentro del mismo plazo).                            |
| `FIRMAS_OCR_DPI`                 | 200             | Resolución de render de PDF.                                                              |
| `FIRMAS_OCR_MAX_PIXELES`         | 40000000        | Píxeles máximos por página.                                                               |
| `FIRMAS_OCR_IDIOMAS`             | `spa+eng`       | Idiomas de Tesseract.                                                                     |
| `FIRMAS_OCR_RAICES_DIR`          | `/app/raices`   | Carpeta con las raíces de confianza para `/v1/firma-electronica`.                         |
| `FIRMAS_OCR_UMBRAL_DETECTADA`    | 0.60            | Puntaje mínimo para `firma_detectada`.                                                    |
| `FIRMAS_OCR_UMBRAL_NO_DETECTADA` | 0.50            | Por debajo de esto (y con buena calidad) → `no_detectada`.                                |

## Cómo funciona

1. **Carga** (`documentos.py`): PDF → imágenes a 200 dpi con pypdfium2; imágenes con Pillow
   (TIFF multipágina, orientación EXIF). Se valida tipo por bytes, páginas y píxeles.
2. **Detección visual** (`firma.py`, OpenCV): binarizado adaptativo, se quitan líneas largas
   de tablas, se agrupan trazos conectados y se puntúa cada grupo según tamaño, grosor del
   trazo, dirección oblicua, densidad, número de piezas y proporción. Se descartan códigos QR
   (alternancia tinta/papel), sellos redondos (concentración radial) y páginas con muchos
   candidatos (gráficos, mapas).
3. **OCR** (`ocr.py`, Tesseract `spa+eng`): texto de cada página y texto junto a cada firma.
4. **Decisión** (`analisis.py`): los tres resultados, observaciones y coincidencias
   (`coincidencia.py`: parecido por palabra, tolerante al orden y a errores de lectura).

No es un modelo entrenado: es un heurístico con pesos fijados a mano. Por eso existe
`no_concluyente`, y por eso el informe de evaluación importa más que este README.

## Ejecutar

```bash
# desde dynadrill-platform/
docker compose -f infra/docker-compose.yml --profile ocr up -d --build firmas-ocr
curl localhost:8090/salud
```

Solo escucha en `127.0.0.1:8090` (`FIRMAS_OCR_PORT` para cambiarlo). Si el servicio será
consumido desde otro contenedor (p. ej. la API de Facturación), conéctelo a la red de compose
y use `http://firmas-ocr:8090`; el puerto publicado en el host es solo para pruebas.

## Pruebas

```bash
# desde apps/firmas-ocr/
docker build --target pruebas -t dynadrill-firmas-ocr:pruebas .
docker run --rm dynadrill-firmas-ocr:pruebas            # pytest (incluye las que usan Tesseract)
```

Sin Docker: `pip install -r requirements-dev.txt && pytest` (las pruebas con Tesseract se omiten
si no está instalado).

## Evaluación

```bash
docker run --rm -v "$PWD:/app" \
  -v "<ruta>/documentacion/facturacion/SOPORTES EJEMPLO:/soportes:ro" \
  dynadrill-firmas-ocr:pruebas python evaluacion/evaluar.py --soportes /soportes --semilla 2
```

Usa los PDF reales de `SOPORTES EJEMPLO` más positivos y negativos sintéticos
(`evaluacion/sinteticos.py`), y escribe `evaluacion/salida/` (`resultados.json`, `tablas.md`).
`--rapido` omite el OCR (solo detector visual). `--guardar-fallos DIR` guarda las imágenes
sintéticas no acertadas. Ver [`evaluacion/INFORME.md`](evaluacion/INFORME.md).
