"""Contrato de respuesta de la API."""

from typing import Literal

from pydantic import BaseModel, Field

AVISO = (
    'Ayuda para la revisión de Facturación: este resultado no certifica la autenticidad '
    'de ninguna firma ni reemplaza la verificación humana.'
)

Resultado = Literal['firma_detectada', 'no_detectada', 'no_concluyente']


class Caja(BaseModel):
    # Coordenadas relativas al tamaño de la página (0 a 1) y en píxeles de la página analizada.
    x: float
    y: float
    ancho: float
    alto: float
    x_px: int
    y_px: int
    ancho_px: int
    alto_px: int


class FirmaDetectada(BaseModel):
    pagina: int = Field(description='Número de página, desde 1.')
    caja: Caja
    confianza: float = Field(ge=0, le=1)
    texto_cercano: str = Field(description='Texto OCR junto a la firma (nombre, cargo, etc.).')


class TextoPagina(BaseModel):
    pagina: int
    texto: str


class Coincidencia(BaseModel):
    esperado: str
    encontrado: bool
    similitud: float = Field(ge=0, le=1)
    ubicacion: Literal['cerca_de_firma', 'documento'] | None


class Coincidencias(BaseModel):
    nombre: Coincidencia | None = None
    cargo: Coincidencia | None = None


class FirmaElectronica(BaseModel):
    campos_firma_pdf: int = Field(description='Campos de firma digital dentro del PDF.')
    sello_texto: bool = Field(description='Se leyó un sello tipo "Firmado electrónicamente por".')


class RespuestaVerificacion(BaseModel):
    resultado: Resultado
    confianza: float = Field(ge=0, le=1, description='Confianza en el resultado indicado.')
    firmas: list[FirmaDetectada]
    texto: list[TextoPagina]
    coincidencias: Coincidencias
    firma_electronica: FirmaElectronica
    observaciones: list[str]
    paginas_analizadas: int
    duracion_ms: int
    aviso: str = AVISO


class RespuestaSalud(BaseModel):
    estado: Literal['ok', 'degradado']
    version: str
    ocr_disponible: bool
    raices_cargadas: int = Field(description='Raíces de confianza cargadas para validar firmas electrónicas.')


# --- /v1/firma-electronica ----------------------------------------------------------------

AVISO_FIRMA_ELECTRONICA = (
    'Validación técnica de las firmas digitales incrustadas en el PDF. La revocación de los '
    'certificados no se consulta (el servicio no sale a internet). Es una ayuda para la '
    'revisión: no reemplaza la verificación oficial de la entidad de certificación.'
)

EstadoIntegridad = Literal[
    'intacto',
    'intacto_con_revisiones_posteriores',
    'modificado_despues_de_firmar',
    'firma_invalida',
]


class Integridad(BaseModel):
    estado: EstadoIntegridad
    firma_valida: bool = Field(description='La firma criptográfica es correcta.')
    documento_intacto: bool = Field(description='El resumen del contenido firmado coincide.')
    cobertura: Literal['archivo_completo', 'revision', 'parcial']
    cambios_posteriores: Literal['ninguno', 'firmas_o_formularios', 'anotaciones', 'otros']
    detalle: str


class Firmante(BaseModel):
    nombre: str | None
    identificacion: str | None = Field(description='Cédula o RUC del certificado.')
    correo: str | None


class Emisor(BaseModel):
    nombre: str | None
    organizacion: str | None


class Certificado(BaseModel):
    serie: str
    vigente_desde: str
    vigente_hasta: str
    huella_sha256: str


class RaizDeclarada(BaseModel):
    nombre: str
    huella_sha256: str


class Cadena(BaseModel):
    reconocida: bool
    entidad: str | None = Field(description='Raíz de confianza a la que llega la cadena.')
    detalle: str
    raiz_declarada_en_pdf: RaizDeclarada | None = Field(
        description='Raíz que el propio PDF dice usar. NO es de confianza; sirve para saber qué raíz pedir a la entidad.'
    )


class FirmaDigital(BaseModel):
    campo: str
    integridad: Integridad
    firmante: Firmante
    emisor: Emisor
    certificado: Certificado
    fecha_firma: str | None
    origen_fecha: Literal['sello_de_tiempo', 'declarada_por_el_firmante', 'desconocida']
    vigente_al_firmar: bool | None
    cadena: Cadena
    firmante_verificado: bool
    conclusion: str
    advertencias: list[str]


EstadoFirmasElectronicas = Literal[
    'sin_firmas_digitales',
    'verificado',
    'verificado_con_advertencias',
    'firmantes_no_verificados',
    'alterado',
]


class RespuestaFirmaElectronica(BaseModel):
    estado: EstadoFirmasElectronicas
    resumen: str
    firmas: list[FirmaDigital]
    raices_cargadas: int
    revocacion: Literal['no_verificada'] = 'no_verificada'
    duracion_ms: int
    aviso: str = AVISO_FIRMA_ELECTRONICA
