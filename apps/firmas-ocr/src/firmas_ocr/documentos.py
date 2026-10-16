"""Lectura de PDF e imágenes a matrices BGR. Todo ocurre en memoria; nada se escribe a disco."""

import io
from dataclasses import dataclass

import numpy as np
import pypdfium2 as pdfium
from PIL import Image, ImageOps
from pypdf import PdfReader

from .errores import DocumentoNoProcesable, Plazo, TipoNoSoportado

Image.MAX_IMAGE_PIXELS = None  # el límite se aplica a mano, antes de decodificar


@dataclass
class DocumentoCargado:
    tipo: str  # 'pdf' | 'imagen'
    paginas: list[np.ndarray]  # BGR uint8
    campos_firma_pdf: int  # campos /Sig del PDF (firma electrónica), 0 si no aplica


def detectar_tipo(datos: bytes) -> str:
    """Decide por los primeros bytes, nunca por la extensión ni el Content-Type declarado."""
    cabecera = datos[:16]
    if b'%PDF-' in datos[:1024]:
        return 'pdf'
    if cabecera.startswith(b'\x89PNG\r\n\x1a\n'):
        return 'imagen'
    if cabecera.startswith(b'\xff\xd8\xff'):
        return 'imagen'
    if cabecera[:4] in (b'II*\x00', b'MM\x00*'):
        return 'imagen'
    if cabecera.startswith(b'BM'):
        return 'imagen'
    raise TipoNoSoportado('Solo se aceptan PDF, PNG, JPEG, TIFF o BMP.')


def _rgb_a_bgr(imagen: Image.Image) -> np.ndarray:
    return np.ascontiguousarray(np.asarray(imagen.convert('RGB'))[:, :, ::-1])


def _cargar_imagen(datos: bytes, max_paginas: int, max_pixeles: int) -> list[np.ndarray]:
    try:
        imagen = Image.open(io.BytesIO(datos))
        marcos = getattr(imagen, 'n_frames', 1)
        if marcos > max_paginas:
            raise DocumentoNoProcesable(
                f'El documento tiene {marcos} páginas; el máximo permitido es {max_paginas}.'
            )
        paginas = []
        for indice in range(marcos):
            imagen.seek(indice)
            ancho, alto = imagen.size
            if ancho * alto > max_pixeles:
                raise DocumentoNoProcesable('La imagen supera el tamaño máximo en píxeles.')
            marco = ImageOps.exif_transpose(imagen)
            if marco.mode in ('RGBA', 'LA', 'P'):
                marco = marco.convert('RGBA')
                fondo = Image.new('RGBA', marco.size, (255, 255, 255, 255))
                marco = Image.alpha_composite(fondo, marco)
            paginas.append(_rgb_a_bgr(marco))
        return paginas
    except DocumentoNoProcesable:
        raise
    except Exception as exc:  # PIL lanza tipos muy variados ante archivos corruptos
        raise DocumentoNoProcesable('No se pudo leer la imagen: archivo corrupto.') from exc


def _contar_campos_firma(datos: bytes) -> int:
    try:
        lector = PdfReader(io.BytesIO(datos))
        campos = lector.get_fields() or {}
        return sum(1 for campo in campos.values() if campo.get('/FT') == '/Sig')
    except Exception:
        return 0


def _cargar_pdf(
    datos: bytes, dpi: int, max_paginas: int, max_pixeles: int, plazo: Plazo
) -> list[np.ndarray]:
    try:
        pdf = pdfium.PdfDocument(datos)
    except pdfium.PdfiumError as exc:
        mensaje = 'El PDF está protegido con contraseña.' if 'password' in str(exc).lower() else (
            'No se pudo leer el PDF: archivo corrupto.'
        )
        raise DocumentoNoProcesable(mensaje) from exc
    try:
        try:
            pdf.init_forms()  # sin esto pdfium no dibuja los sellos de firma electrónica
        except Exception:
            pass
        total = len(pdf)
        if total == 0:
            raise DocumentoNoProcesable('El PDF no tiene páginas.')
        if total > max_paginas:
            raise DocumentoNoProcesable(
                f'El documento tiene {total} páginas; el máximo permitido es {max_paginas}.'
            )
        paginas = []
        for indice in range(total):
            plazo.verificar()
            pagina = pdf[indice]
            ancho_pt, alto_pt = pagina.get_size()
            escala = dpi / 72
            if (ancho_pt * escala) * (alto_pt * escala) > max_pixeles:
                escala = (max_pixeles / (ancho_pt * alto_pt)) ** 0.5
            mapa = pagina.render(scale=escala, rev_byteorder=False)  # BGR
            paginas.append(np.ascontiguousarray(mapa.to_numpy()[:, :, :3]))
        return paginas
    except DocumentoNoProcesable:
        raise
    except Exception as exc:
        raise DocumentoNoProcesable('No se pudo procesar el PDF: archivo corrupto.') from exc
    finally:
        pdf.close()


def cargar_documento(
    datos: bytes, *, dpi: int, max_paginas: int, max_pixeles: int, plazo: Plazo
) -> DocumentoCargado:
    tipo = detectar_tipo(datos)
    if tipo == 'pdf':
        paginas = _cargar_pdf(datos, dpi, max_paginas, max_pixeles, plazo)
        return DocumentoCargado(tipo, paginas, _contar_campos_firma(datos))
    return DocumentoCargado(tipo, _cargar_imagen(datos, max_paginas, max_pixeles), 0)
