import io
import sys
from pathlib import Path

import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

RAIZ = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RAIZ / 'evaluacion'))

import sinteticos as sint  # noqa: E402
from firmas_ocr import ocr  # noqa: E402
from firmas_ocr.config import Configuracion  # noqa: E402
from firmas_ocr.main import crear_app  # noqa: E402

LLAVE = 'llave-de-prueba'
CABECERAS = {'X-API-Key': LLAVE}
tesseract = pytest.mark.skipif(not ocr.tesseract_disponible(), reason='Tesseract no instalado')


def png(img: np.ndarray) -> bytes:
    return cv2.imencode('.png', img)[1].tobytes()


def pdf_de(imagenes: list[np.ndarray]) -> bytes:
    paginas = [Image.fromarray(i[:, :, ::-1]) for i in imagenes]
    salida = io.BytesIO()
    paginas[0].save(salida, format='PDF', save_all=True, append_images=paginas[1:], resolution=200)
    return salida.getvalue()


def crear_cliente(**cambios) -> TestClient:
    return TestClient(crear_app(Configuracion(api_key=LLAVE, **cambios)))


@pytest.fixture
def rng():
    return np.random.default_rng(7)


@pytest.fixture
def formulario_firmado(rng):
    base, cajas = sint.pagina_formulario(rng, firmantes=2)
    return sint.con_firmas(base, cajas, rng, cuantas=2)


@pytest.fixture
def formulario_sin_firmar(rng):
    return sint.pagina_formulario(rng, firmantes=2)[0]


@pytest.fixture
def sin_ocr(monkeypatch):
    """Sustituye Tesseract: las pruebas de API no dependen de tenerlo instalado."""
    monkeypatch.setattr(ocr, 'reconocer', lambda imagen, idiomas, plazo: [])


@pytest.fixture
def cliente(sin_ocr):
    with crear_cliente() as c:
        yield c
