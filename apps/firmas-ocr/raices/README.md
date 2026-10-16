# Raíces de confianza

Todo archivo `.pem`, `.crt`, `.cer` o `.der` de esta carpeta es una **ancla de confianza** para
`POST /v1/firma-electronica`. La carpeta se lee al arrancar (`FIRMAS_OCR_RAICES_DIR`, por defecto
`/app/raices`). El servicio nunca descarga raíces ni confía en la que traiga un PDF.

Si la raíz de un firmante no está aquí, el servicio igual responde, con "firmante no verificado".

## Cargadas

Raíces (anclas de confianza; un certificado autofirmado):

| Archivo                                  | Entidad                                                                                                                 | SHA-256                                                            | Origen                                                                                                                                                                                                         |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `anf-high-assurance-ecuador-root-ca.pem` | ANF AC Ecuador — _ANF High Assurance Ecuador Root CA_ (vence 2039-10-12)                                                | `0f361d8b258123ea9bb84dd3f2c821c0285479626e1185e12f1a04b85546e459` | `https://crl.anf.es/certificates-download/ANFHighAssuranceEcuadorRootCA.cer` (sitio de ANF por HTTPS). Coincide con la raíz que traen los PDF de ejemplo y con la que firma su intermedia.                     |
| `security-data-raiz-ca-2.pem`            | Security Data — _AUTORIDAD DE CERTIFICACION RAIZ CA-2 SECURITY DATA_ (vence 2039-10-06)                                 | `503b5960fa8cc58f3367642a911fd8f8277e474d6891637fe56ca2a69f069cbd` | Descargada por el equipo de Dynadrill el 2026-10-15 (`SECDATA-CA-2.cer`). Su huella coincide con la que declaran los PDF de ejemplo.                                                                           |
| `uanataca-root-2016.pem`                 | Uanataca — _UANATACA ROOT 2016_ (vence 2041-03-11)                                                                      | `44607b3d0ebd0d2bf181cb62f3cea9766dbb6718743f55b153a320ea99dfb5a6` | Descargada por el equipo de Dynadrill el 2026-10-15 (`ca_raiz.cer`). Las intermedias de abajo verifican contra ella.                                                                                           |
| `bce-autoridad-raiz.pem`                 | Banco Central del Ecuador (ECIBCE) — _AUTORIDAD DE CERTIFICACION RAIZ DEL BANCO CENTRAL DEL ECUADOR_ (vence 2031-08-08) | `11c7c59be9d21d216f0e8151378d53d03b314060559adc49da161ec4f7829bec` | Sitio del Banco Central (`bce.fin.ec`, Centro de Descargas de la ECI): las descargas de macOS y de Linux (`1_AC_RAIZ.cer`) dan el mismo certificado, y coincide con el de `AC_RAIZ.p7b` que entregó Dynadrill. |

Intermedias (no dan confianza por sí solas: sirven para completar la cadena cuando el PDF no las trae, y la cadena debe terminar en una raíz de arriba; cada una se comprobó con la firma de su raíz):

| Archivo                                          | Entidad                   | SHA-256                                                            |
| ------------------------------------------------ | ------------------------- | ------------------------------------------------------------------ |
| `anf-high-assurance-ecuador-intermediate-ca.pem` | ANF                       | —                                                                  |
| `security-data-subca-2.pem`                      | Security Data — _SUBCA-2_ | `6bd1035a0b907aaca0374a18c96e26665bd57cd3b9ce7413096aa5479858ebc0` |
| `uanataca-ca2-2021.pem`                          | Uanataca — _CA2 2021_     | `15ceab339144d48d352eef1c227f4d2ef4fc1756dead602c22be32d52100e69a` |
| `uanataca-ca2-2016.pem`                          | Uanataca — _CA2 2016_     | `00ff2ff2efba98c6b023ad1035559a606dd9fc48a39d3407cc07a678379a7909` |
| `uanataca-ca1-2016.pem`                          | Uanataca — _CA1 2016_     | `35a99284a220789ba0e062eeff1b5f2f74be43754469977cb318c7c86ad48f9f` |

No se cargaron a propósito: la lista de revocación de Security Data (`crlfile.crl`; el servicio no consulta revocación), el certificado de sello de tiempo de Uanataca (`tsu01.cer`) y las dos raíces antiguas del Banco Central que trae `AC_RAIZ.p7b` (2008 y 2010; hoy los PDF llegan a la de 2011). Si aparece una firma que dependa de ellas, se agregan.

## Pendientes (hay que obtenerlas de la entidad)

No se deben copiar desde un PDF: el PDF es justamente lo que se quiere verificar. La huella de la tabla es la que declaran los PDF de `SOPORTES EJEMPLO`; úsela **solo para comparar** con el archivo que le entregue la entidad:

| Entidad                                         | Raíz             | SHA-256 declarada en los PDF                                       |
| ----------------------------------------------- | ---------------- | ------------------------------------------------------------------ |
| Lazzate                                         | Lazzate Root CA2 | `aa9d6d0d79839e5a1a5f2c1022952954f73a47de1c539ebd4567431f75a8e589` |
| Datil / otras entidades acreditadas por ARCOTEL | por obtener      | —                                                                  |

## Cómo agregar una raíz

1. Obtenga el certificado raíz del sitio oficial de la entidad (o solicítelo a su soporte).
2. Calcule su huella y compárela con la que publica la entidad por un canal independiente:
   `openssl x509 -in raiz.crt -noout -fingerprint -sha256` (si es DER: `-inform der`).
3. Cópielo aquí y reinicie el servicio. `GET /salud` muestra `raices_cargadas`.
4. Para saber qué raíz pedir para un PDF concreto:
   `python -m firmas_ocr.raices documento.pdf` (lista las raíces que declara, con su huella).

Las intermedias no hace falta cargarlas: viajan dentro del PDF y se validan contra la raíz de aquí.
