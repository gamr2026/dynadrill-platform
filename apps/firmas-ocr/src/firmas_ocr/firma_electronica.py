"""Validación de firmas digitales PAdES/PKCS#7 incrustadas en un PDF (con pyHanko).

Todo ocurre en memoria y sin red: no se consultan OCSP/CRL ni se descargan certificados.
Si la cadena no llega a una raíz cargada, la firma se informa igual, como "firmante no
verificado".
"""

import io
import logging
import re
import time
from datetime import datetime, timezone

from asn1crypto import x509
from pyhanko.pdf_utils.misc import PdfReadError
from pyhanko.pdf_utils.reader import PdfFileReader
from pyhanko.sign.validation import validate_pdf_signature
from pyhanko.sign.validation.status import ModificationLevel, SignatureCoverageLevel
from pyhanko_certvalidator import ValidationContext

from .errores import DocumentoNoProcesable, Plazo
from .esquemas import (
    Cadena,
    Certificado,
    Emisor,
    FirmaDigital,
    Firmante,
    Integridad,
    RaizDeclarada,
    RespuestaFirmaElectronica,
)
from .raices import nombre_corto

# pyHanko registra con nivel ERROR cada cadena que no logra construir (y es lo esperado
# cuando falta la raíz); el servicio ya lo informa en la respuesta.
logging.getLogger('pyhanko').setLevel(logging.CRITICAL)
logging.getLogger('pyhanko_certvalidator').setLevel(logging.CRITICAL)

# OID del número de identificación (cédula/RUC) que cada entidad pone en el certificado.
OIDS_IDENTIFICACION = (
    '1.3.6.1.4.1.37746.3.1',  # Security Data
    '1.3.6.1.4.1.37442.10.4',  # ANF AC Ecuador
    '1.3.6.1.4.1.37442.3.1',  # ANF AC Ecuador
    '1.3.6.1.4.1.59382.3.1',  # Lazzate
)
_NUMERO = re.compile(r'(?<!\d)(\d{13}|\d{10})(?!\d)')
_BENIGNOS = (ModificationLevel.NONE, ModificationLevel.LTA_UPDATES, ModificationLevel.FORM_FILLING)


def _utf8(valor: bytes | str) -> str | None:
    """Los OID propietarios guardan un UTF8String DER: se quita la cabecera de tipo/longitud."""
    if isinstance(valor, str):
        return valor
    if len(valor) >= 2 and valor[0] in (0x0C, 0x13, 0x16) and valor[1] == len(valor) - 2:
        valor = valor[2:]
    try:
        return valor.decode('utf-8')
    except UnicodeDecodeError:
        return None


def extraer_identificacion(cert: x509.Certificate) -> str | None:
    subject = cert.subject.native
    for oid in OIDS_IDENTIFICACION:
        if oid in subject and _NUMERO.search(str(subject[oid])):
            return _NUMERO.search(str(subject[oid])).group(1)
    for extension in cert['tbs_certificate']['extensions'] or []:
        if extension['extn_id'].dotted in OIDS_IDENTIFICACION:
            texto = _utf8(extension['extn_value'].native)
            if texto and (m := _NUMERO.search(texto)):
                return m.group(1)
    serie = subject.get('serial_number')
    if serie and (m := _NUMERO.search(str(serie))):  # p. ej. "0401686662-140126144519"
        return m.group(1)
    return None


def _correo(cert: x509.Certificate) -> str | None:
    if correo := cert.subject.native.get('email_address'):
        return str(correo)
    return next(iter(cert.subject_alt_name_value.native if cert.subject_alt_name_value else []), None)


def _nombre_firmante(cert: x509.Certificate) -> str | None:
    s = cert.subject.native
    if s.get('common_name'):
        return str(s['common_name'])
    partes = [s.get('given_name'), s.get('surname')]
    return ' '.join(p for p in partes if p) or None


def _iso(momento: datetime | None) -> str | None:
    return momento.isoformat() if momento else None


def _raiz_declarada(firma) -> RaizDeclarada | None:
    for c in [firma.signer_cert, *firma.other_embedded_certs]:
        if c.ca and c.issuer == c.subject:
            return RaizDeclarada(nombre=nombre_corto(c), huella_sha256=c.sha256.hex())
    return None


def _integridad(estado_pdf) -> Integridad:
    cobertura = {
        SignatureCoverageLevel.ENTIRE_FILE: 'archivo_completo',
        SignatureCoverageLevel.ENTIRE_REVISION: 'revision',
    }.get(estado_pdf.coverage, 'parcial')
    nivel = estado_pdf.modification_level
    cambios = {
        ModificationLevel.NONE: 'ninguno',
        ModificationLevel.LTA_UPDATES: 'firmas_o_formularios',
        ModificationLevel.FORM_FILLING: 'firmas_o_formularios',
        ModificationLevel.ANNOTATIONS: 'anotaciones',
    }.get(nivel, 'otros')
    valida, intacta = bool(estado_pdf.valid), bool(estado_pdf.intact)

    if not (valida and intacta):
        estado = 'firma_invalida'
        detalle = (
            'El contenido firmado no coincide con la firma: el documento fue alterado o la '
            'firma está dañada.'
        )
    elif cobertura == 'parcial' or (cobertura == 'revision' and nivel not in _BENIGNOS):
        estado = 'modificado_despues_de_firmar'
        detalle = (
            'La firma es correcta para el contenido firmado, pero el archivo tiene cambios '
            'posteriores que no corresponden a otras firmas ni a llenado de formularios.'
        )
    elif cobertura == 'revision':
        estado = 'intacto_con_revisiones_posteriores'
        detalle = 'Hay revisiones posteriores (normalmente otras firmas) que no alteran el contenido.'
    else:
        estado = 'intacto'
        detalle = 'El archivo es exactamente el que se firmó.'
    return Integridad(
        estado=estado,
        firma_valida=valida,
        documento_intacto=intacta,
        cobertura=cobertura,
        cambios_posteriores=cambios,
        detalle=detalle,
    )


def _fecha_firma(estado_pdf) -> tuple[datetime | None, str]:
    """Prefiere el sello de tiempo (si es válido); si no, la fecha que declara el firmante."""
    sello = getattr(estado_pdf, 'timestamp_validity', None)
    if sello is not None and sello.valid and sello.intact:
        return sello.timestamp, 'sello_de_tiempo'
    declarada = getattr(estado_pdf, 'signer_reported_dt', None)
    if declarada is not None:
        return declarada, 'declarada_por_el_firmante'
    return None, 'desconocida'


def _entidad_raiz(estado_pdf, raices: list[x509.Certificate]) -> str | None:
    camino = getattr(estado_pdf, 'validation_path', None)
    if camino is None:
        return None
    try:
        ancla = camino.first
        cert = getattr(ancla, 'certificate', ancla)
        return nombre_corto(cert)
    except Exception:
        return None


def _validar_firma(
    firma, raices: list[x509.Certificate], intermedias: list[x509.Certificate]
) -> FirmaDigital:
    cert = firma.signer_cert
    advertencias: list[str] = []

    # Primera pasada sin raíces: da integridad, firma y fecha sin depender de la cadena.
    base = validate_pdf_signature(
        firma, ValidationContext(trust_roots=[], allow_fetching=False)
    )
    fecha, origen = _fecha_firma(base)
    # Segunda pasada con las raíces, evaluando la cadena en el momento de la firma.
    estado_pdf = base
    if raices:
        contexto = ValidationContext(
            trust_roots=raices,
            other_certs=intermedias,
            allow_fetching=False,
            moment=fecha if fecha else None,
        )
        estado_pdf = validate_pdf_signature(firma, contexto)

    integridad = _integridad(estado_pdf)
    desde, hasta = cert.not_valid_before, cert.not_valid_after
    vigente = None
    if fecha is not None:
        vigente = bool(desde <= fecha.astimezone(timezone.utc) <= hasta)
        if not vigente:
            advertencias.append('El certificado no estaba vigente en la fecha de la firma.')
    else:
        advertencias.append('No se pudo determinar la fecha de la firma; no se evaluó la vigencia.')
    if origen == 'declarada_por_el_firmante':
        advertencias.append(
            'La fecha la declara el propio firmante (no hay sello de tiempo): no es prueba de cuándo se firmó.'
        )

    reconocida = bool(estado_pdf.trusted) and bool(raices)
    if reconocida:
        entidad = _entidad_raiz(estado_pdf, raices)
        detalle_cadena = 'La cadena llega a una raíz de confianza cargada.'
    else:
        entidad = None
        detalle_cadena = (
            'No hay ninguna raíz de confianza cargada.'
            if not raices
            else 'La cadena no llega a ninguna de las raíces cargadas (o la cadena está incompleta).'
        )
    cadena = Cadena(
        reconocida=reconocida,
        entidad=entidad,
        detalle=detalle_cadena,
        raiz_declarada_en_pdf=_raiz_declarada(firma),
    )

    integra = integridad.estado in ('intacto', 'intacto_con_revisiones_posteriores')
    verificado = integra and reconocida and vigente is True
    if integridad.estado == 'firma_invalida':
        conclusion = 'Firma inválida: el documento fue alterado después de firmar o la firma está dañada.'
    elif integridad.estado == 'modificado_despues_de_firmar':
        conclusion = 'El documento tiene cambios posteriores a esta firma.'
    elif verificado:
        conclusion = 'Firmante verificado.'
    else:
        motivos = []
        if not reconocida:
            motivos.append('la cadena no llega a una entidad de certificación reconocida')
        if vigente is False:
            motivos.append('el certificado no estaba vigente al firmar')
        if vigente is None:
            motivos.append('no se pudo comprobar la vigencia')
        conclusion = 'Firmante no verificado: ' + '; '.join(motivos) + '.'

    return FirmaDigital(
        campo=firma.field_name,
        integridad=integridad,
        firmante=Firmante(
            nombre=_nombre_firmante(cert), identificacion=extraer_identificacion(cert), correo=_correo(cert)
        ),
        emisor=Emisor(
            nombre=cert.issuer.native.get('common_name'),
            organizacion=cert.issuer.native.get('organization_name'),
        ),
        certificado=Certificado(
            serie=str(cert.serial_number),
            vigente_desde=_iso(desde),
            vigente_hasta=_iso(hasta),
            huella_sha256=cert.sha256.hex(),
        ),
        fecha_firma=_iso(fecha),
        origen_fecha=origen,
        vigente_al_firmar=vigente,
        cadena=cadena,
        firmante_verificado=verificado,
        conclusion=conclusion,
        advertencias=advertencias,
    )


def _firma_con_error(firma, motivo: str) -> FirmaDigital:
    cert = firma.signer_cert
    return FirmaDigital(
        campo=firma.field_name,
        integridad=Integridad(
            estado='firma_invalida',
            firma_valida=False,
            documento_intacto=False,
            cobertura='parcial',
            cambios_posteriores='otros',
            detalle=motivo,
        ),
        firmante=Firmante(nombre=_nombre_firmante(cert), identificacion=extraer_identificacion(cert), correo=_correo(cert)),
        emisor=Emisor(nombre=cert.issuer.native.get('common_name'), organizacion=cert.issuer.native.get('organization_name')),
        certificado=Certificado(
            serie=str(cert.serial_number),
            vigente_desde=_iso(cert.not_valid_before),
            vigente_hasta=_iso(cert.not_valid_after),
            huella_sha256=cert.sha256.hex(),
        ),
        fecha_firma=None,
        origen_fecha='desconocida',
        vigente_al_firmar=None,
        cadena=Cadena(reconocida=False, entidad=None, detalle='No evaluada.', raiz_declarada_en_pdf=_raiz_declarada(firma)),
        firmante_verificado=False,
        conclusion='No se pudo validar la firma: ' + motivo,
        advertencias=[],
    )


def _estado_global(firmas: list[FirmaDigital]) -> tuple[str, str]:
    if not firmas:
        return 'sin_firmas_digitales', 'El PDF no contiene firmas digitales.'
    ultima = firmas[-1]
    if any(f.integridad.estado == 'firma_invalida' for f in firmas) or (
        ultima.integridad.estado == 'modificado_despues_de_firmar'
    ):
        return 'alterado', 'El documento fue modificado después de firmarse o una firma es inválida.'
    sin_verificar = [f for f in firmas if not f.firmante_verificado]
    if sin_verificar:
        return (
            'firmantes_no_verificados',
            f'{len(sin_verificar)} de {len(firmas)} firmantes no verificados '
            '(cadena no reconocida o certificado no vigente al firmar); el documento está íntegro.',
        )
    if any(f.integridad.estado == 'modificado_despues_de_firmar' for f in firmas):
        return (
            'verificado_con_advertencias',
            'Todos los firmantes se verificaron, pero una firma anterior muestra cambios posteriores '
            'distintos de las firmas siguientes.',
        )
    return 'verificado', 'Todas las firmas son íntegras, vigentes y de una entidad reconocida.'


def _propagar_cambios_de_la_ultima(firmas: list[FirmaDigital]) -> None:
    """Un cambio posterior a la última firma también es posterior a todas las anteriores.

    pyHanko analiza cada firma contra las revisiones siguientes, pero un cambio puede quedar
    "explicado" para una firma anterior por la revisión de la firma siguiente.
    """
    if len(firmas) < 2 or firmas[-1].integridad.estado != 'modificado_despues_de_firmar':
        return
    for firma in firmas[:-1]:
        if firma.integridad.estado in ('intacto', 'intacto_con_revisiones_posteriores'):
            firma.integridad = firma.integridad.model_copy(
                update={
                    'estado': 'modificado_despues_de_firmar',
                    'cambios_posteriores': 'otros',
                    'detalle': 'El documento tiene cambios posteriores a la última firma, y por tanto a esta.',
                }
            )
            firma.firmante_verificado = False
            firma.conclusion = 'El documento tiene cambios posteriores a esta firma.'


def validar_pdf(
    datos: bytes,
    raices: list[x509.Certificate],
    plazo: Plazo,
    intermedias: list[x509.Certificate] | None = None,
) -> RespuestaFirmaElectronica:
    inicio = time.monotonic()
    try:
        # strict=False: los PDF de FirmaEC usan xref híbrido, que pyHanko rechaza en modo estricto.
        lector = PdfFileReader(io.BytesIO(datos), strict=False)
        firmas_pdf = lector.embedded_signatures
    except (PdfReadError, ValueError, KeyError, TypeError) as exc:
        raise DocumentoNoProcesable('No se pudo leer el PDF: archivo corrupto o cifrado.') from exc

    firmas: list[FirmaDigital] = []
    for firma in firmas_pdf:
        plazo.verificar()
        try:
            firmas.append(_validar_firma(firma, raices, intermedias or []))
        except Exception as exc:  # pyHanko lanza muchos tipos ante firmas mal formadas
            firmas.append(_firma_con_error(firma, type(exc).__name__))
    _propagar_cambios_de_la_ultima(firmas)
    estado, resumen = _estado_global(firmas)
    return RespuestaFirmaElectronica(
        estado=estado,
        resumen=resumen,
        firmas=firmas,
        raices_cargadas=len(raices),
        duracion_ms=int((time.monotonic() - inicio) * 1000),
    )
