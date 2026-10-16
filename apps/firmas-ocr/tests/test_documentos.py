import io

import numpy as np
import pytest
from conftest import pdf_de, png
from PIL import Image

from firmas_ocr.documentos import cargar_documento, detectar_tipo
from firmas_ocr.errores import DocumentoNoProcesable, Plazo, TipoNoSoportado

PARAMS = dict(dpi=100, max_paginas=3, max_pixeles=40_000_000)


def cargar(datos, **cambios):
    return cargar_documento(datos, plazo=Plazo(30), **{**PARAMS, **cambios})


def test_detecta_tipos_por_contenido():
    assert detectar_tipo(b'%PDF-1.7 ...') == 'pdf'
    assert detectar_tipo(b'\x89PNG\r\n\x1a\n....') == 'imagen'
    assert detectar_tipo(b'\xff\xd8\xff\xe0....') == 'imagen'


@pytest.mark.parametrize('datos', [b'hola mundo', b'MZ\x90\x00', b'<html></html>', b'PK\x03\x04zip'])
def test_rechaza_tipos_no_soportados(datos):
    with pytest.raises(TipoNoSoportado):
        detectar_tipo(datos)


def test_carga_png(formulario_sin_firmar):
    doc = cargar(png(formulario_sin_firmar))
    assert doc.tipo == 'imagen' and len(doc.paginas) == 1
    assert doc.paginas[0].shape == formulario_sin_firmar.shape


def test_carga_pdf_multipagina(formulario_sin_firmar):
    doc = cargar(pdf_de([formulario_sin_firmar] * 2))
    assert doc.tipo == 'pdf' and len(doc.paginas) == 2
    assert doc.campos_firma_pdf == 0


def test_demasiadas_paginas_pdf(formulario_sin_firmar):
    with pytest.raises(DocumentoNoProcesable, match='máximo'):
        cargar(pdf_de([formulario_sin_firmar] * 4))


def test_demasiadas_paginas_tiff(formulario_sin_firmar):
    marcos = [Image.fromarray(formulario_sin_firmar[:200, :200, ::-1])] * 4
    salida = io.BytesIO()
    marcos[0].save(salida, format='TIFF', save_all=True, append_images=marcos[1:])
    with pytest.raises(DocumentoNoProcesable, match='máximo'):
        cargar(salida.getvalue())


def test_pdf_corrupto():
    with pytest.raises(DocumentoNoProcesable):
        cargar(b'%PDF-1.4\nesto no es un pdf')


def test_png_corrupto():
    with pytest.raises(DocumentoNoProcesable):
        cargar(b'\x89PNG\r\n\x1a\n' + b'basura' * 20)


def test_imagen_demasiado_grande_en_pixeles():
    with pytest.raises(DocumentoNoProcesable, match='píxeles'):
        cargar(png(np.zeros((300, 300, 3), np.uint8)), max_pixeles=1000)
