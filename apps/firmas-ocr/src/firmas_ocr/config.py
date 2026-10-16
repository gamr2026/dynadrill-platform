"""Configuración por variables de entorno (prefijo FIRMAS_OCR_)."""

import os
from dataclasses import dataclass


def _entero(nombre: str, defecto: int) -> int:
    return int(os.environ.get(f'FIRMAS_OCR_{nombre}', defecto))


def _decimal(nombre: str, defecto: float) -> float:
    return float(os.environ.get(f'FIRMAS_OCR_{nombre}', defecto))


@dataclass(frozen=True)
class Configuracion:
    api_key: str
    # Carpeta con las raíces de confianza (PEM/DER) para validar firmas electrónicas.
    raices_dir: str = '/app/raices'
    max_bytes: int = 10 * 1024 * 1024
    max_paginas: int = 10
    timeout_s: float = 60.0
    max_concurrentes: int = 2
    dpi: int = 200
    max_pixeles: int = 40_000_000
    idiomas: str = 'spa+eng'
    # Puntaje mínimo de un candidato para declarar "firma detectada".
    umbral_detectada: float = 0.60
    # Por debajo de este puntaje máximo (y con calidad suficiente) se declara "no detectada".
    umbral_no_detectada: float = 0.50

    @staticmethod
    def desde_entorno() -> 'Configuracion':
        return Configuracion(
            api_key=os.environ.get('FIRMAS_OCR_API_KEY', ''),
            raices_dir=os.environ.get('FIRMAS_OCR_RAICES_DIR', '/app/raices'),
            max_bytes=_entero('MAX_BYTES', 10 * 1024 * 1024),
            max_paginas=_entero('MAX_PAGINAS', 10),
            timeout_s=_decimal('TIMEOUT_S', 60.0),
            max_concurrentes=_entero('MAX_CONCURRENTES', 2),
            dpi=_entero('DPI', 200),
            max_pixeles=_entero('MAX_PIXELES', 40_000_000),
            idiomas=os.environ.get('FIRMAS_OCR_IDIOMAS', 'spa+eng'),
            umbral_detectada=_decimal('UMBRAL_DETECTADA', 0.60),
            umbral_no_detectada=_decimal('UMBRAL_NO_DETECTADA', 0.50),
        )
