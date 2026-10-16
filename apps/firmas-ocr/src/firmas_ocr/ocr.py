"""OCR con Tesseract invocado como subproceso local.

La imagen viaja por stdin y el resultado vuelve por stdout: no se crean archivos
temporales, de modo que el documento nunca toca el disco.
"""

import shutil
import subprocess
from dataclasses import dataclass

import cv2
import numpy as np

from .errores import DocumentoNoProcesable, ErrorApi, Plazo, TiempoAgotado

CONFIANZA_MINIMA = 30  # las "palabras" con menos confianza suelen ser trazos de firma o ruido


@dataclass
class Palabra:
    texto: str
    x: int
    y: int
    ancho: int
    alto: int
    confianza: float

    @property
    def centro(self) -> tuple[float, float]:
        return self.x + self.ancho / 2, self.y + self.alto / 2


class OcrNoDisponible(ErrorApi):
    estado = 503
    codigo = 'ocr_no_disponible'


def tesseract_disponible() -> bool:
    return shutil.which('tesseract') is not None


def _tsv_a_palabras(salida: str) -> list[Palabra]:
    palabras: list[Palabra] = []
    for linea in salida.splitlines()[1:]:
        campos = linea.split('\t')
        if len(campos) < 12 or campos[0] != '5':
            continue
        texto = campos[11].strip()
        try:
            confianza = float(campos[10])
        except ValueError:
            continue
        if not texto or confianza < CONFIANZA_MINIMA:
            continue
        palabras.append(
            Palabra(
                texto, int(campos[6]), int(campos[7]), int(campos[8]), int(campos[9]), confianza
            )
        )
    return palabras


def reconocer(imagen_bgr: np.ndarray, idiomas: str, plazo: Plazo) -> list[Palabra]:
    if not tesseract_disponible():
        raise OcrNoDisponible('Tesseract no está instalado en este entorno.')
    ok, png = cv2.imencode('.png', imagen_bgr)
    if not ok:
        raise DocumentoNoProcesable('No se pudo preparar la página para OCR.')
    plazo.verificar()
    try:
        proceso = subprocess.run(
            ['tesseract', 'stdin', 'stdout', '-l', idiomas, '--psm', '3', 'tsv'],
            input=png.tobytes(),
            capture_output=True,
            timeout=max(0.5, plazo.restante()),
            check=False,
            env={'OMP_THREAD_LIMIT': '1', 'PATH': '/usr/bin:/usr/local/bin:/bin'},
        )
    except subprocess.TimeoutExpired as exc:
        raise TiempoAgotado('El análisis superó el tiempo máximo permitido.') from exc
    if proceso.returncode != 0:
        raise DocumentoNoProcesable('Tesseract no pudo leer la página.')
    return _tsv_a_palabras(proceso.stdout.decode('utf-8', errors='replace'))


def palabras_a_texto(palabras: list[Palabra]) -> str:
    """Reconstruye el texto en orden de lectura aproximado (líneas por posición vertical)."""
    if not palabras:
        return ''
    ordenadas = sorted(palabras, key=lambda p: (p.centro[1], p.x))
    alto_tipico = float(np.median([p.alto for p in ordenadas])) or 10.0
    lineas: list[list[Palabra]] = [[ordenadas[0]]]
    for palabra in ordenadas[1:]:
        anterior = lineas[-1][-1]
        if abs(palabra.centro[1] - anterior.centro[1]) <= 0.6 * alto_tipico:
            lineas[-1].append(palabra)
        else:
            lineas.append([palabra])
    return '\n'.join(' '.join(p.texto for p in sorted(linea, key=lambda p: p.x)) for linea in lineas)
