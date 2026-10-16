import numpy as np
import pytest
from conftest import CABECERAS, crear_cliente, pdf_de, png, tesseract

from firmas_ocr.config import Configuracion
from firmas_ocr.main import crear_app


def verificar(cliente, datos, nombre='doc.png', tipo='image/png', cabeceras=CABECERAS, **campos):
    return cliente.post(
        '/v1/verificar', headers=cabeceras, files={'archivo': (nombre, datos, tipo)}, data=campos
    )


def test_salud_no_exige_llave(cliente):
    r = cliente.get('/salud')
    assert r.status_code == 200
    assert r.json()['version'] and 'ocr_disponible' in r.json()


def test_arranque_exige_llave():
    with pytest.raises(RuntimeError, match='FIRMAS_OCR_API_KEY'):
        crear_app(Configuracion(api_key=''))


@pytest.mark.parametrize('cabeceras', [{}, {'X-API-Key': 'otra'}, {'X-API-Key': ''}])
def test_401_sin_llave_valida(cliente, formulario_sin_firmar, cabeceras):
    r = verificar(cliente, png(formulario_sin_firmar), cabeceras=cabeceras)
    assert r.status_code == 401
    assert r.json()['error']['codigo'] == 'no_autorizado'


def test_400_sin_archivo(cliente):
    r = cliente.post('/v1/verificar', headers=CABECERAS, data={'nombre_esperado': 'X'})
    assert r.status_code == 400


def test_400_archivo_vacio(cliente):
    assert verificar(cliente, b'').status_code == 400


def test_413_por_tamano(sin_ocr, formulario_sin_firmar):
    with crear_cliente(max_bytes=1000) as c:
        r = verificar(c, png(formulario_sin_firmar))
    assert r.status_code == 413
    assert r.json()['error']['codigo'] == 'archivo_demasiado_grande'


def test_415_tipo_no_soportado(cliente):
    r = verificar(cliente, b'esto es texto plano', nombre='a.pdf', tipo='application/pdf')
    assert r.status_code == 415


def test_422_pdf_corrupto(cliente):
    r = verificar(cliente, b'%PDF-1.4 roto', nombre='a.pdf', tipo='application/pdf')
    assert r.status_code == 422


def test_422_demasiadas_paginas(sin_ocr, formulario_sin_firmar):
    with crear_cliente(max_paginas=2, dpi=50) as c:
        r = verificar(c, pdf_de([formulario_sin_firmar] * 3), nombre='a.pdf', tipo='application/pdf')
    assert r.status_code == 422
    assert 'máximo' in r.json()['error']['mensaje']


def test_422_nombre_demasiado_largo(cliente, formulario_sin_firmar):
    r = verificar(cliente, png(formulario_sin_firmar), nombre_esperado='x' * 500)
    assert r.status_code == 422


def test_504_por_tiempo(sin_ocr, formulario_sin_firmar):
    with crear_cliente(timeout_s=0.000001) as c:
        r = verificar(c, png(formulario_sin_firmar))
    assert r.status_code == 504
    assert r.json()['error']['codigo'] == 'tiempo_agotado'


def test_respuesta_con_firma(cliente, formulario_firmado):
    r = verificar(cliente, png(formulario_firmado))
    assert r.status_code == 200, r.text
    cuerpo = r.json()
    assert cuerpo['resultado'] == 'firma_detectada'
    assert cuerpo['firmas'] and cuerpo['firmas'][0]['pagina'] == 1
    caja = cuerpo['firmas'][0]['caja']
    assert 0 <= caja['x'] <= 1 and 0 < caja['ancho'] <= 1
    assert 'no certifica' in cuerpo['aviso']


def test_respuesta_sin_firma(cliente, formulario_sin_firmar):
    r = verificar(cliente, png(formulario_sin_firmar))
    assert r.status_code == 200
    assert r.json()['resultado'] == 'no_detectada'
    assert r.json()['firmas'] == []


def test_pdf_con_firma(cliente, formulario_firmado):
    r = verificar(cliente, pdf_de([formulario_firmado]), nombre='a.pdf', tipo='application/pdf')
    assert r.status_code == 200
    assert r.json()['resultado'] == 'firma_detectada'


def test_hoja_en_blanco_es_no_concluyente(cliente):
    r = verificar(cliente, png(np.full((1200, 900, 3), 255, np.uint8)))
    assert r.json()['resultado'] == 'no_concluyente'


def test_el_tipo_se_decide_por_contenido_no_por_nombre(cliente, formulario_sin_firmar):
    r = verificar(cliente, png(formulario_sin_firmar), nombre='falso.pdf', tipo='application/pdf')
    assert r.status_code == 200


def test_sin_tesseract_responde_503(formulario_sin_firmar, monkeypatch):
    monkeypatch.setattr('firmas_ocr.ocr.tesseract_disponible', lambda: False)
    with crear_cliente() as c:
        r = verificar(c, png(formulario_sin_firmar))
    assert r.status_code == 503


@tesseract
def test_ocr_lee_texto_y_coincidencias(formulario_firmado):
    with crear_cliente() as c:
        r = verificar(
            c, png(formulario_firmado), nombre_esperado='Marco Alban', cargo_esperado='Representante'
        )
    cuerpo = r.json()
    assert r.status_code == 200
    assert cuerpo['coincidencias']['nombre']['encontrado'] is True
    assert cuerpo['coincidencias']['cargo']['encontrado'] is True
    assert 'BOMBEO' in cuerpo['texto'][0]['texto'].upper()


@tesseract
def test_ocr_nombre_ausente_no_coincide(formulario_firmado):
    with crear_cliente() as c:
        r = verificar(c, png(formulario_firmado), nombre_esperado='Zacarias Quimbiamba')
    assert r.json()['coincidencias']['nombre']['encontrado'] is False
