"""Utilidades de prueba: crear entidades de certificación sintéticas y firmar PDF con pyHanko."""

import io
from datetime import datetime, timedelta, timezone

from asn1crypto import keys, x509 as a_x509
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID, ObjectIdentifier
from pyhanko.pdf_utils.incremental_writer import IncrementalPdfFileWriter
from pyhanko.sign import fields, signers
from pyhanko_certvalidator.registry import SimpleCertificateStore

OID_ID_SECURITY_DATA = ObjectIdentifier('1.3.6.1.4.1.37746.3.1')


def _llave():
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


def _nombre(cn: str, org: str = 'Entidad de Prueba', serie: str | None = None) -> x509.Name:
    atributos = [
        x509.NameAttribute(NameOID.COUNTRY_NAME, 'EC'),
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, org),
        x509.NameAttribute(NameOID.COMMON_NAME, cn),
    ]
    if serie:
        atributos.append(x509.NameAttribute(NameOID.SERIAL_NUMBER, serie))
    return x509.Name(atributos)


def crear_ca(cn: str = 'RAIZ DE PRUEBA'):
    llave = _llave()
    nombre = _nombre(cn)
    ahora = datetime.now(timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(nombre)
        .issuer_name(nombre)
        .public_key(llave.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(ahora - timedelta(days=3650))
        .not_valid_after(ahora + timedelta(days=3650))
        .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
        .add_extension(
            x509.KeyUsage(True, False, False, False, False, True, True, False, False), critical=True
        )
        .sign(llave, hashes.SHA256())
    )
    return cert, llave


def emitir(ca, nombre: str, cedula: str, desde_dias: int = -1, hasta_dias: int = 365):
    """Certificado de persona natural con la cédula en serialNumber y en el OID de Security Data."""
    cert_ca, llave_ca = ca
    llave = _llave()
    ahora = datetime.now(timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(_nombre(nombre, serie=f'{cedula}-140126144519'))
        .issuer_name(cert_ca.subject)
        .public_key(llave.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(ahora + timedelta(days=desde_dias))
        .not_valid_after(ahora + timedelta(days=hasta_dias))
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(
            x509.KeyUsage(True, True, False, False, False, False, False, False, False), critical=True
        )
        .add_extension(
            x509.UnrecognizedExtension(OID_ID_SECURITY_DATA, b'\x0c\x0a' + cedula.encode()), critical=False
        )
        .sign(llave_ca, hashes.SHA256())
    )
    return cert, llave


def a_pem(cert: x509.Certificate) -> bytes:
    return cert.public_bytes(serialization.Encoding.PEM)


def a_asn1(cert: x509.Certificate) -> a_x509.Certificate:
    return a_x509.Certificate.load(cert.public_bytes(serialization.Encoding.DER))


def _firmante(emitido, ca) -> signers.SimpleSigner:
    cert, llave = emitido
    clave = keys.PrivateKeyInfo.load(
        llave.private_bytes(
            serialization.Encoding.DER,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
    registro = SimpleCertificateStore()
    registro.register(a_asn1(ca[0]))
    return signers.SimpleSigner(signing_cert=a_asn1(cert), signing_key=clave, cert_registry=registro)


def firmar(pdf: bytes, emitido, ca, campo: str = 'Firma1') -> bytes:
    escritor = IncrementalPdfFileWriter(io.BytesIO(pdf))
    fields.append_signature_field(escritor, fields.SigFieldSpec(sig_field_name=campo))
    salida = io.BytesIO()
    signers.sign_pdf(
        escritor,
        signers.PdfSignatureMetadata(field_name=campo, md_algorithm='sha256'),
        signer=_firmante(emitido, ca),
        output=salida,
    )
    return salida.getvalue()


def agregar_cambio_posterior(pdf: bytes) -> bytes:
    """Actualización incremental posterior a la firma que cambia lo que muestra la primera página."""
    from pyhanko.pdf_utils import generic

    escritor = IncrementalPdfFileWriter(io.BytesIO(pdf), strict=False)
    referencia, pagina = escritor.find_page_for_modification(0)
    pagina = pagina.get_object() if hasattr(pagina, 'get_object') else pagina
    nuevo = generic.StreamObject(stream_data=b'1 0 0 rg 0 0 200 300 re f')  # rectángulo rojo encima
    pagina['/Contents'] = escritor.add_object(nuevo)
    escritor.mark_update(referencia)
    salida = io.BytesIO()
    escritor.write(salida)
    return salida.getvalue()
