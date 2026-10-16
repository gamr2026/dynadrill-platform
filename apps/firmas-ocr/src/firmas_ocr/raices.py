"""Raíces de confianza (entidades de certificación) cargadas desde una carpeta.

Cada archivo .pem/.crt/.cer/.der de la carpeta se toma como ancla de confianza. Nada se
descarga en ejecución: quien administra el servicio decide qué raíces confiar y debe
verificar su huella con la entidad antes de copiarlas (ver raices/README.md).

Ayuda para el administrador: ``python -m firmas_ocr.raices archivo.pdf`` lista las raíces
que declaran las firmas de un PDF (con su huella) para saber cuáles pedir a la entidad.
"""

import logging
import sys
from pathlib import Path

from asn1crypto import pem, x509

logger = logging.getLogger('firmas_ocr')
EXTENSIONES = {'.pem', '.crt', '.cer', '.der'}


def nombre_corto(certificado: x509.Certificate) -> str:
    return certificado.subject.native.get('common_name') or certificado.subject.human_friendly


def _leer_archivo(ruta: Path) -> list[x509.Certificate]:
    datos = ruta.read_bytes()
    if pem.detect(datos):
        return [x509.Certificate.load(der) for _, _, der in pem.unarmor(datos, multiple=True)]
    return [x509.Certificate.load(datos)]


def cargar_certificados(carpeta: str) -> tuple[list[x509.Certificate], list[x509.Certificate]]:
    """Devuelve (raíces, intermedias) de la carpeta.

    Un certificado autofirmado es una raíz (ancla de confianza). Los demás se usan solo para
    completar cadenas cuando el PDF no trae la intermedia: por sí solos no dan confianza,
    porque la cadena debe terminar igualmente en una raíz cargada.
    Un archivo ilegible se omite sin detener el servicio.
    """
    ruta = Path(carpeta)
    if not ruta.is_dir():
        logger.warning('Carpeta de raíces inexistente: %s', carpeta)
        return [], []
    todos: dict[bytes, x509.Certificate] = {}
    for archivo in sorted(ruta.iterdir()):
        if archivo.suffix.lower() not in EXTENSIONES or not archivo.is_file():
            continue
        try:
            for certificado in _leer_archivo(archivo):
                todos[certificado.sha256] = certificado
        except Exception:
            logger.warning('No se pudo leer el certificado %s', archivo.name)
    raices = [c for c in todos.values() if c.ca and c.issuer == c.subject]
    intermedias = [c for c in todos.values() if c not in raices]
    return raices, intermedias


def cargar_raices(carpeta: str) -> list[x509.Certificate]:
    return cargar_certificados(carpeta)[0]


def _listar(rutas: list[str]) -> int:  # pragma: no cover - herramienta manual
    from pyhanko.pdf_utils.reader import PdfFileReader

    logging.disable(logging.CRITICAL)
    vistas: dict[str, x509.Certificate] = {}
    for ruta in rutas:
        with open(ruta, 'rb') as f:
            for firma in PdfFileReader(f, strict=False).embedded_signatures:
                for c in [firma.signer_cert, *firma.other_embedded_certs]:
                    if c.ca and c.issuer == c.subject:
                        vistas[c.sha256.hex()] = c
    for huella, c in vistas.items():
        print(f'{nombre_corto(c)}\n  SHA-256: {huella}\n  vence: {c.not_valid_after:%Y-%m-%d}')
    print(
        '\nEstas raíces las declara el propio PDF: NO son de confianza hasta que obtenga el '
        'archivo de la entidad y compare la huella.'
    )
    return 0


if __name__ == '__main__':  # pragma: no cover
    raise SystemExit(_listar(sys.argv[1:]))
