"""Orquesta carga, detección visual, OCR y decisión final de un documento."""

import re
import time

from . import coincidencia, ocr
from .config import Configuracion
from .documentos import cargar_documento
from .errores import Plazo
from .esquemas import (
    Caja,
    Coincidencia,
    Coincidencias,
    FirmaDetectada,
    FirmaElectronica,
    RespuestaVerificacion,
    TextoPagina,
)
from .firma import Candidato, analizar_pagina

MAX_TEXTO_PAGINA = 6000
# Muchos candidatos en una misma página indican gráficos, planos o fotos (abundan los trazos
# curvos), donde el heurístico no puede distinguir una firma. Una página de firmas real
# tiene 2 o 3 candidatos fuertes y pocos más.
MAX_CANDIDATOS_FUERTES = 3  # con puntaje >= UMBRAL_FUERTE
UMBRAL_FUERTE = 0.40
_SELLO = re.compile(r'firmado\s+electr', re.IGNORECASE)


def _texto_cercano(
    palabras: list[ocr.Palabra], c: Candidato, ancho_pagina: int, alto_pagina: int
) -> str:
    """Palabras de la columna de la firma, desde un poco arriba hasta bajo el bloque.

    En los formatos de Dynadrill el nombre y el cargo van debajo de la firma, y el rol
    ("Representante de la contratista") justo encima de ella.
    """
    centro_x = c.x + c.ancho / 2
    columna = (0, ancho_pagina / 2) if centro_x < ancho_pagina / 2 else (ancho_pagina / 2, ancho_pagina)
    arriba = c.y - 0.5 * c.alto
    abajo = c.y + c.alto + 0.07 * alto_pagina
    cerca = [
        p
        for p in palabras
        if columna[0] <= p.centro[0] <= columna[1] and arriba <= p.centro[1] <= abajo
    ]
    return ocr.palabras_a_texto(cerca)


def _a_firma(
    pagina: int, c: Candidato, ancho: int, alto: int, palabras: list[ocr.Palabra]
) -> FirmaDetectada:
    return FirmaDetectada(
        pagina=pagina,
        caja=Caja(
            x=round(c.x / ancho, 4),
            y=round(c.y / alto, 4),
            ancho=round(c.ancho / ancho, 4),
            alto=round(c.alto / alto, 4),
            x_px=c.x,
            y_px=c.y,
            ancho_px=c.ancho,
            alto_px=c.alto,
        ),
        confianza=round(c.puntaje, 3),
        texto_cercano=_texto_cercano(palabras, c, ancho, alto)[:500],
    )


def verificar(
    datos: bytes,
    cfg: Configuracion,
    plazo: Plazo,
    nombre_esperado: str | None = None,
    cargo_esperado: str | None = None,
) -> RespuestaVerificacion:
    inicio = time.monotonic()
    doc = cargar_documento(
        datos,
        dpi=cfg.dpi,
        max_paginas=cfg.max_paginas,
        max_pixeles=cfg.max_pixeles,
        plazo=plazo,
    )

    firmas: list[FirmaDetectada] = []
    textos: list[TextoPagina] = []
    observaciones: list[str] = []
    mejor_descartado = 0.0
    sello = False
    hay_dudas = False

    for numero, pagina in enumerate(doc.paginas, start=1):
        plazo.verificar()
        alto, ancho = pagina.shape[:2]
        visual = analizar_pagina(pagina, plazo)
        palabras = ocr.reconocer(pagina, cfg.idiomas, plazo)
        texto = ocr.palabras_a_texto(palabras)
        textos.append(TextoPagina(pagina=numero, texto=texto[:MAX_TEXTO_PAGINA]))
        sello = sello or bool(_SELLO.search(texto))

        fuertes = [c for c in visual.candidatos if c.puntaje >= UMBRAL_FUERTE]
        if len(fuertes) > MAX_CANDIDATOS_FUERTES:
            hay_dudas = True
            observaciones.append(
                f'Página {numero}: demasiados trazos candidatos (gráficos, planos o fotos); '
                'no se puede aislar una firma.'
            )
            continue
        if not visual.calidad.suficiente:
            hay_dudas = True
            observaciones.append(
                f'Página {numero}: calidad insuficiente ({", ".join(visual.calidad.motivos)}).'
            )
        for c in visual.candidatos:
            if c.puntaje >= cfg.umbral_detectada:
                firmas.append(_a_firma(numero, c, ancho, alto, palabras))
            else:
                mejor_descartado = max(mejor_descartado, c.puntaje)

    if firmas:
        resultado = 'firma_detectada'
        confianza = max(f.confianza for f in firmas)
    elif hay_dudas or mejor_descartado >= cfg.umbral_no_detectada:
        resultado = 'no_concluyente'
        confianza = round(max(mejor_descartado, 0.0), 3)
        if mejor_descartado >= cfg.umbral_no_detectada:
            observaciones.append('Hay trazos dudosos que no alcanzan para afirmar una firma.')
    else:
        resultado = 'no_detectada'
        confianza = round(1.0 - mejor_descartado, 3)

    firma_electronica = FirmaElectronica(campos_firma_pdf=doc.campos_firma_pdf, sello_texto=sello)
    if (doc.campos_firma_pdf or sello) and resultado != 'firma_detectada':
        observaciones.append(
            'El documento trae firma electrónica; este servicio solo evalúa firma manuscrita.'
        )

    texto_firmas = '\n'.join(f.texto_cercano for f in firmas)
    texto_total = '\n'.join(t.texto for t in textos)
    coincidencias = Coincidencias(
        nombre=_coincidencia(nombre_esperado, texto_firmas, texto_total),
        cargo=_coincidencia(cargo_esperado, texto_firmas, texto_total),
    )

    return RespuestaVerificacion(
        resultado=resultado,
        confianza=min(1.0, max(0.0, confianza)),
        firmas=firmas,
        texto=textos,
        coincidencias=coincidencias,
        firma_electronica=firma_electronica,
        observaciones=observaciones,
        paginas_analizadas=len(doc.paginas),
        duracion_ms=int((time.monotonic() - inicio) * 1000),
    )


def _coincidencia(
    esperado: str | None, texto_firmas: str, texto_total: str
) -> Coincidencia | None:
    if not esperado or not esperado.strip():
        return None
    return Coincidencia(**coincidencia.evaluar(esperado.strip(), texto_firmas, texto_total))
