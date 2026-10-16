"""Comparación tolerante entre el nombre/cargo esperado y el texto leído por OCR."""

import re
import unicodedata
from difflib import SequenceMatcher

UMBRAL_COINCIDENCIA = 0.80


def normalizar(texto: str) -> str:
    sin_tildes = ''.join(
        c for c in unicodedata.normalize('NFKD', texto) if not unicodedata.combining(c)
    )
    return re.sub(r'[^a-z0-9 ]+', ' ', sin_tildes.lower())


def _tokens(texto: str) -> list[str]:
    return [t for t in normalizar(texto).split() if len(t) >= 2]


def similitud(esperado: str, leido: str) -> float:
    """Promedio, por cada palabra esperada, de su mejor parecido con alguna palabra leída.

    No depende del orden (el OCR puede leer "Coello Katalina" o "Katalina Coello") y tolera
    errores de lectura de una o dos letras.
    """
    buscadas = _tokens(esperado)
    disponibles = _tokens(leido)
    if not buscadas or not disponibles:
        return 0.0
    total = 0.0
    for buscada in buscadas:
        total += max(SequenceMatcher(None, buscada, d).ratio() for d in disponibles)
    return round(total / len(buscadas), 3)


def evaluar(esperado: str, texto_cercano: str, texto_documento: str) -> dict:
    """Busca primero junto a las firmas y, si no aparece, en todo el documento."""
    cerca = similitud(esperado, texto_cercano)
    en_documento = similitud(esperado, texto_documento)
    if cerca >= UMBRAL_COINCIDENCIA:
        return {
            'esperado': esperado,
            'encontrado': True,
            'similitud': cerca,
            'ubicacion': 'cerca_de_firma',
        }
    if en_documento >= UMBRAL_COINCIDENCIA:
        return {
            'esperado': esperado,
            'encontrado': True,
            'similitud': en_documento,
            'ubicacion': 'documento',
        }
    return {
        'esperado': esperado,
        'encontrado': False,
        'similitud': max(cerca, en_documento),
        'ubicacion': None,
    }
