import cv2
import numpy as np
from sinteticos import dibujar_firma, negativo_sello_redondo, pagina_formulario

from firmas_ocr.firma import analizar_pagina

UMBRAL = 0.60


def test_detecta_firmas_en_formulario(formulario_firmado):
    r = analizar_pagina(formulario_firmado)
    assert any(c.puntaje >= UMBRAL for c in r.candidatos)


def test_formulario_sin_firmar_no_da_candidatos_fuertes(formulario_sin_firmar):
    r = analizar_pagina(formulario_sin_firmar)
    assert all(c.puntaje < UMBRAL for c in r.candidatos)


def test_hoja_en_blanco_se_marca_sin_calidad():
    r = analizar_pagina(np.full((2339, 1654, 3), 255, np.uint8))
    assert not r.candidatos
    assert not r.calidad.suficiente
    assert 'página casi en blanco' in r.calidad.motivos


def test_resolucion_muy_baja_se_marca(formulario_firmado):
    chica = cv2.resize(formulario_firmado, None, fx=0.2, fy=0.2, interpolation=cv2.INTER_AREA)
    assert 'resolución muy baja' in analizar_pagina(chica).calidad.motivos


def test_caja_en_coordenadas_de_la_imagen_original(rng):
    base, _ = pagina_formulario(rng, firmantes=1)
    img = base.copy()
    dibujar_firma(img, (600, 1500, 400, 180), rng)
    mejor = analizar_pagina(img).candidatos[0]
    assert abs(mejor.x - 600) < 80 and abs(mejor.y - 1500) < 80
    assert 300 < mejor.ancho < 520


def test_sello_redondo_no_es_firma(rng):
    r = analizar_pagina(negativo_sello_redondo(rng))
    assert all(c.puntaje < UMBRAL for c in r.candidatos)


def test_resultado_estable_con_otro_tamano_de_render(formulario_firmado):
    grande = cv2.resize(formulario_firmado, None, fx=1.6, fy=1.6, interpolation=cv2.INTER_CUBIC)
    r = analizar_pagina(grande)
    assert any(c.puntaje >= UMBRAL for c in r.candidatos)
