from firmas_ocr.coincidencia import evaluar, normalizar, similitud


def test_normaliza_tildes_y_signos():
    assert normalizar('Ing. Efrén Yugsi').split() == ['ing', 'efren', 'yugsi']


def test_similitud_tolera_orden_y_errores_de_ocr():
    assert similitud('Katalina Coello', 'Nombre: Ing. Coello Katalina') == 1.0
    assert similitud('Katalina Coello', 'Katalina Coelo') > 0.9


def test_similitud_baja_con_otra_persona():
    assert similitud('Katalina Coello', 'Marco Alban') < 0.6


def test_prefiere_texto_cercano_a_la_firma():
    r = evaluar('Marco Alban', 'Nombre: Marco Alban', 'otro texto')
    assert r['encontrado'] and r['ubicacion'] == 'cerca_de_firma'


def test_cae_al_documento_completo():
    r = evaluar('Marco Alban', 'sin nombre', 'Elaborado por: Marco Alban')
    assert r['encontrado'] and r['ubicacion'] == 'documento'


def test_no_encontrado():
    r = evaluar('Marco Alban', 'Juan Perez', 'Pedro Gomez')
    assert not r['encontrado'] and r['ubicacion'] is None
