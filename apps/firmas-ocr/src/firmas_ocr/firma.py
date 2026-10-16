"""Detección de trazos manuscritos tipo firma con visión clásica (OpenCV).

Idea: se separa la "tinta" del papel, se descartan las líneas largas de las tablas y se
buscan grupos de trazos conectados, grandes para ser texto impreso y delgados, curvos y
oblicuos para ser logos, códigos QR, sellos o recuadros. Cada grupo recibe un puntaje de 0
a 1 combinando esos rasgos. No es un modelo entrenado: es un heurístico, y por eso la
respuesta incluye "no concluyente".
"""

from dataclasses import dataclass, field

import cv2
import numpy as np

from .errores import Plazo

LADO_NORMALIZADO = 2200  # el lado mayor de la página se lleva a ~2200 px (≈200 dpi en A4)


@dataclass
class Candidato:
    x: int
    y: int
    ancho: int
    alto: int
    puntaje: float
    rasgos: dict[str, float] = field(default_factory=dict)


@dataclass
class CalidadPagina:
    suficiente: bool
    motivos: list[str]
    tinta: float
    nitidez: float


@dataclass
class ResultadoPagina:
    candidatos: list[Candidato]
    calidad: CalidadPagina


def _normalizar(imagen: np.ndarray) -> np.ndarray:
    alto, ancho = imagen.shape[:2]
    escala = min(2.0, max(0.5, LADO_NORMALIZADO / max(alto, ancho)))
    if 0.75 <= escala <= 1.34:
        return imagen
    interp = cv2.INTER_AREA if escala < 1 else cv2.INTER_CUBIC
    return cv2.resize(imagen, None, fx=escala, fy=escala, interpolation=interp)


def evaluar_calidad(gris: np.ndarray, binaria: np.ndarray, lado_original: int) -> CalidadPagina:
    motivos: list[str] = []
    tinta = float(np.count_nonzero(binaria)) / binaria.size
    nitidez = float(cv2.Laplacian(gris, cv2.CV_64F).var())
    oscuro = float(np.percentile(gris, 0.2))
    papel = float(np.median(gris))
    if lado_original < 800:
        motivos.append('resolución muy baja')
    if tinta < 0.0005:
        motivos.append('página casi en blanco')
    if tinta > 0.45:
        motivos.append('página demasiado oscura')
    if tinta >= 0.0005 and papel - oscuro < 40:
        motivos.append('contraste insuficiente')
    if nitidez < 15 and tinta >= 0.0005:
        motivos.append('imagen borrosa')
    return CalidadPagina(not motivos, motivos, tinta, nitidez)


def _binarizar(gris: np.ndarray) -> np.ndarray:
    return cv2.adaptiveThreshold(
        gris, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, 31, 15
    )


def _quitar_lineas(binaria: np.ndarray, largo: int) -> np.ndarray:
    horizontales = cv2.morphologyEx(
        binaria, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (largo, 1))
    )
    verticales = cv2.morphologyEx(
        binaria, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (1, largo))
    )
    lineas = cv2.dilate(cv2.bitwise_or(horizontales, verticales), np.ones((3, 3), np.uint8))
    return cv2.bitwise_and(binaria, cv2.bitwise_not(lineas))


def _longitud_esqueleto(mascara: np.ndarray) -> int:
    """Píxeles del esqueleto morfológico (aprox. longitud total del trazo)."""
    img = mascara.copy()
    cruz = cv2.getStructuringElement(cv2.MORPH_CROSS, (3, 3))
    esqueleto = np.zeros_like(img)
    for _ in range(60):
        erosion = cv2.erode(img, cruz)
        abierta = cv2.dilate(erosion, cruz)
        esqueleto = cv2.bitwise_or(esqueleto, cv2.subtract(img, abierta))
        img = erosion
        if not img.any():
            break
    return int(np.count_nonzero(esqueleto))


def _fraccion_oblicua(mascara: np.ndarray) -> float:
    """Peso de los bordes que NO son horizontales ni verticales (±12°).

    El texto impreso, los recuadros y los QR son casi todo horizontal/vertical; la
    escritura a mano tiene mucha dirección oblicua.
    """
    suave = cv2.GaussianBlur(mascara, (5, 5), 0).astype(np.float32)
    gx = cv2.Sobel(suave, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(suave, cv2.CV_32F, 0, 1, ksize=3)
    magnitud = np.hypot(gx, gy)
    total = float(magnitud.sum())
    if total <= 0:
        return 0.0
    angulo = (np.degrees(np.arctan2(gy, gx)) + 180.0) % 90.0  # 0 y 90 -> ejes
    distancia_eje = np.minimum(angulo, 90.0 - angulo)
    return float(magnitud[distancia_eje > 12.0].sum() / total)


def _fraccion_anillo(mascara: np.ndarray) -> float:
    """Concentración radial de la tinta alrededor del centro de la caja (0 a 1).

    Un sello redondo (con uno o dos aros, aunque la línea de firma lo corte) deja el centro
    casi vacío y pone la tinta en una franja estrecha de radios; una firma reparte la tinta
    por toda la caja.
    """
    alto, ancho = mascara.shape
    ys, xs = np.nonzero(mascara)
    if len(xs) == 0:
        return 0.0
    d = np.hypot((xs - (ancho - 1) / 2) / (ancho / 2), (ys - (alto - 1) / 2) / (alto / 2))
    mejor = max(float(np.mean((d >= s) & (d < s + 0.30))) for s in np.arange(0.4, 1.01, 0.05))
    centro_vacio = float(np.mean(d < 0.45)) < 0.2
    return mejor if centro_vacio else mejor * 0.5


def _alternancia(mascara: np.ndarray) -> float:
    """Cambios tinta/papel por cada 100 px, en el eje menos alternante (filas o columnas).

    Un QR (módulos de 3 a 5 px) alterna muchísimo en ambos ejes; un trazo de bolígrafo
    cruza cada fila o columna pocas veces.
    """
    binaria = (mascara > 0).astype(np.int8)
    por_eje = []
    for eje, largo in ((1, binaria.shape[1]), (0, binaria.shape[0])):
        cambios = np.abs(np.diff(binaria, axis=eje)).sum(axis=eje)
        con_tinta = binaria.sum(axis=eje) >= 2
        if not con_tinta.any():
            return 0.0
        por_eje.append(float(cambios[con_tinta].mean()) * 100.0 / largo)
    return min(por_eje)


def _anillo_dominante(
    etiquetas: np.ndarray, est: np.ndarray, miembros: list[int], area_grupo: int, mascara: np.ndarray
) -> float:
    """Fracción de anillo del trazo más grande del grupo (si domina), si no la del grupo.

    Un sello puede arrastrar trozos de texto o de la línea de firma que ensucian la caja.
    """
    mayor = max(miembros, key=lambda k: int(est[k][4]))
    if int(est[mayor][4]) < 0.4 * area_grupo:
        return _fraccion_anillo(mascara)
    x, y, w, h = (int(v) for v in est[mayor][:4])
    return _fraccion_anillo(np.where(etiquetas[y : y + h, x : x + w] == mayor, 255, 0).astype(np.uint8))


def _agrupar(cajas: list[tuple[int, int, int, int]], holgura: int) -> list[list[int]]:
    """Une cajas cuya separación sea menor que `holgura` (union-find)."""
    padre = list(range(len(cajas)))

    def raiz(i: int) -> int:
        while padre[i] != i:
            padre[i] = padre[padre[i]]
            i = padre[i]
        return i

    for i, (x1, y1, w1, h1) in enumerate(cajas):
        for j in range(i + 1, len(cajas)):
            x2, y2, w2, h2 = cajas[j]
            if (
                x1 - holgura <= x2 + w2
                and x2 - holgura <= x1 + w1
                and y1 - holgura <= y2 + h2
                and y2 - holgura <= y1 + h1
            ):
                padre[raiz(i)] = raiz(j)
    grupos: dict[int, list[int]] = {}
    for i in range(len(cajas)):
        grupos.setdefault(raiz(i), []).append(i)
    return list(grupos.values())


def _puntuar(rasgos: dict[str, float]) -> float:
    """Combina los rasgos en un puntaje 0..1 (pesos fijados a mano; ver INFORME.md)."""
    base = 0.0
    # Dirección oblicua: la escritura a mano tiene mucha; texto, recuadros y QR casi nada.
    base += 0.35 * np.clip((rasgos['oblicuo'] - 0.30) / 0.25, 0, 1)
    # Grosor del trazo: bolígrafo fino (1,5–7,5 px); texto en negrita y logos son más gruesos.
    grosor = rasgos['grosor']
    base += 0.20 * (1.0 if 1.5 <= grosor <= 7.5 else np.clip(1 - (grosor - 7.5) / 6, 0, 1))
    # Densidad: la tinta de una firma rellena poco su caja (sólidos, QR y sellos, mucho).
    base += 0.25 * np.clip(1 - max(0.0, rasgos['relleno'] - 0.12) / 0.25, 0, 1)
    # Conectividad: pocas piezas y no una nube de puntos.
    base += 0.20 * np.clip(1 - max(0.0, rasgos['piezas'] - 12) / 40, 0, 1)
    # Tamaño: puerta multiplicativa; lo diminuto (puntos, rayas, iniciales de logos) no es firma.
    por_ancho = np.clip((rasgos['ancho_rel'] - 0.04) / 0.04, 0, 1)
    por_alto = np.clip((rasgos['alto_rel'] - 0.02) / 0.015, 0, 1)
    puntaje = base * (0.2 + 0.8 * min(por_ancho, por_alto))
    # Proporción: ni raya ni columna.
    if rasgos['proporcion'] < 0.6 or rasgos['proporcion'] > 9:
        puntaje *= 0.4
    # Tinta muy compacta (rejillas de QR, sellos sólidos): una firma deja la caja casi vacía.
    puntaje *= float(np.clip(1 - (rasgos['relleno'] - 0.28) / 0.12, 0.3, 1))
    # Rejillas de módulos pequeños (códigos QR de los sellos FirmaEC): alternan tinta/papel
    # muchas veces por línea; una firma real, unas 4 a 8 por cada 100 px.
    puntaje *= float(np.clip(1 - (rasgos['alternancia'] - 10) / 4, 0.2, 1))
    # Sellos redondos: casi toda la tinta sobre el perímetro de una elipse.
    if rasgos['anillo'] > 0.6 and 0.6 <= rasgos['proporcion'] <= 1.7:
        puntaje *= 0.3
    # Una firma no ocupa media página: eso son gráficos, mapas o fotos.
    if rasgos['ancho_rel'] > 0.40 or rasgos['alto_rel'] > 0.16:
        puntaje *= 0.5
    return float(np.clip(puntaje, 0.0, 1.0))


def analizar_pagina(imagen_bgr: np.ndarray, plazo: Plazo | None = None) -> ResultadoPagina:
    lado_original = max(imagen_bgr.shape[:2])
    normal = _normalizar(imagen_bgr)
    alto_n, ancho_n = normal.shape[:2]
    escala_a_original = lado_original / max(alto_n, ancho_n)

    gris = cv2.cvtColor(normal, cv2.COLOR_BGR2GRAY)
    binaria = _binarizar(gris)
    calidad = evaluar_calidad(gris, binaria, lado_original)
    if plazo:
        plazo.verificar()

    sin_lineas = _quitar_lineas(binaria, largo=max(40, ancho_n // 25))
    unida = sin_lineas
    n, etiquetas, est, _ = cv2.connectedComponentsWithStats(unida, connectivity=8)

    minimo = 0.028 * ancho_n
    cajas, ids = [], []
    for k in range(1, n):
        x, y, w, h, area = (int(v) for v in est[k])
        if max(w, h) >= minimo and area >= 120 and min(w, h) >= 7:
            cajas.append((x, y, w, h))
            ids.append(k)
    if plazo:
        plazo.verificar()

    candidatos: list[Candidato] = []
    for grupo in _agrupar(cajas, holgura=int(0.012 * ancho_n)):
        miembros = [ids[i] for i in grupo]
        x1 = min(cajas[i][0] for i in grupo)
        y1 = min(cajas[i][1] for i in grupo)
        x2 = max(cajas[i][0] + cajas[i][2] for i in grupo)
        y2 = max(cajas[i][1] + cajas[i][3] for i in grupo)
        recorte_etiquetas = etiquetas[y1:y2, x1:x2]
        mascara = np.where(np.isin(recorte_etiquetas, miembros), 255, 0).astype(np.uint8)
        area = int(np.count_nonzero(mascara))
        w, h = x2 - x1, y2 - y1
        if area < 150:
            continue
        # Trazos sueltos pequeños dentro de la caja (puntos, rúbricas): cuentan como piezas.
        resto = cv2.bitwise_and(unida[y1:y2, x1:x2], cv2.bitwise_not(mascara))
        sueltos = cv2.connectedComponents(resto)[0] - 1
        rasgos = {
            'ancho_rel': w / ancho_n,
            'alto_rel': h / alto_n,
            'proporcion': w / h,
            'relleno': area / (w * h),
            'grosor': area / max(1, _longitud_esqueleto(mascara)),
            'oblicuo': _fraccion_oblicua(mascara),
            'alternancia': _alternancia(mascara),
            'anillo': _anillo_dominante(etiquetas, est, miembros, area, mascara),
            'piezas': float(len(miembros) + sueltos // 4),
        }
        puntaje = _puntuar(rasgos)
        candidatos.append(
            Candidato(
                x=int(x1 * escala_a_original),
                y=int(y1 * escala_a_original),
                ancho=int(w * escala_a_original),
                alto=int(h * escala_a_original),
                puntaje=puntaje,
                rasgos={k: round(float(v), 3) for k, v in rasgos.items()},
            )
        )
        if plazo:
            plazo.verificar()
    candidatos.sort(key=lambda c: c.puntaje, reverse=True)
    return ResultadoPagina(candidatos, calidad)
