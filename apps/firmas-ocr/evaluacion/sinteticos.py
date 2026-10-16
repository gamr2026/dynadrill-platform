"""Generadores de documentos sintéticos para evaluar el detector (deterministas por semilla).

La "firma" sintética es una curva suave con bucles y trazo de grosor variable. Es una
aproximación burda de la escritura real: sirve para probar el detector, no para
demostrar que funciona con firmas de verdad (para eso están los escaneos reales).
"""

import cv2
import numpy as np

ALTO, ANCHO = 2339, 1654  # A4 a 200 dpi


def _catmull_rom(puntos: np.ndarray, por_tramo: int = 14) -> np.ndarray:
    p = np.vstack([puntos[0], puntos, puntos[-1]])
    salida = []
    for i in range(1, len(p) - 2):
        p0, p1, p2, p3 = p[i - 1], p[i], p[i + 1], p[i + 2]
        for t in np.linspace(0, 1, por_tramo, endpoint=False):
            salida.append(
                0.5
                * (
                    2 * p1
                    + (-p0 + p2) * t
                    + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t**2
                    + (-p0 + 3 * p1 - 3 * p2 + p3) * t**3
                )
            )
    salida.append(p[-2])
    return np.array(salida)


def dibujar_firma(img: np.ndarray, caja: tuple[int, int, int, int], rng: np.random.Generator) -> None:
    """Dibuja una firma sintética dentro de caja=(x, y, ancho, alto)."""
    x, y, w, h = caja
    k = int(rng.integers(7, 13))
    xs = np.sort(rng.uniform(0, 1, k)) * w
    ys = rng.uniform(0.05, 0.95, k) * h
    puntos = np.column_stack([xs, ys])
    # bucles: se insertan pequeñas vueltas en algunos puntos
    extra = []
    for px, py in puntos[rng.random(k) < 0.4]:
        r = rng.uniform(0.05, 0.18) * h
        ang = np.linspace(0, 2 * np.pi, 7)
        extra.append(np.column_stack([px + r * np.cos(ang) * 1.4, py + r * np.sin(ang)]))
    if extra:
        puntos = np.vstack([puntos] + extra)
        puntos = puntos[np.argsort(puntos[:, 0] + rng.normal(0, w * 0.03, len(puntos)))]
    curva = _catmull_rom(puntos)
    # rúbrica: un trazo largo que vuelve por debajo
    if rng.random() < 0.7:
        inicio = curva[-1]
        fin = np.array([x * 0 + rng.uniform(0.0, 0.4) * w, min(h, inicio[1] + rng.uniform(0.2, 0.5) * h)])
        medio = (inicio + fin) / 2 + [0, rng.uniform(0.1, 0.3) * h]
        curva = np.vstack([curva, _catmull_rom(np.array([inicio, medio, fin]))])
    tinta = (
        (int(rng.integers(120, 200)), int(rng.integers(30, 80)), int(rng.integers(10, 50)))
        if rng.random() < 0.5
        else (35, 35, 35)
    )
    base = int(rng.integers(2, 4))
    for a, b in zip(curva[:-1], curva[1:]):
        grosor = base + int(rng.random() < 0.3)
        cv2.line(
            img,
            (int(x + a[0]), int(y + a[1])),
            (int(x + b[0]), int(y + b[1])),
            tinta,
            grosor,
            cv2.LINE_AA,
        )


def pagina_formulario(rng: np.random.Generator, firmantes: int = 2) -> tuple[np.ndarray, list[tuple[int, int, int, int]]]:
    """Formulario impreso con tabla y bloques de firma. Devuelve imagen y cajas libres de firma."""
    img = np.full((ALTO, ANCHO, 3), 255, np.uint8)
    cv2.putText(img, 'ORDEN DE TRABAJO', (480, 160), cv2.FONT_HERSHEY_SIMPLEX, 1.6, (20, 20, 20), 3, cv2.LINE_AA)
    cv2.rectangle(img, (100, 80), (ANCHO - 100, 260), (20, 20, 20), 2)
    top = 400
    for fila in range(int(rng.integers(8, 20))):
        yy = top + fila * 60
        cv2.line(img, (100, yy), (ANCHO - 100, yy), (60, 60, 60), 2)
        for col, texto in enumerate(('CT%d' % rng.integers(1000, 9999), 'Servicio de bombeo', 'unidad', '%.2f' % rng.uniform(1, 999))):
            cv2.putText(img, texto, (120 + col * 380, yy + 40), cv2.FONT_HERSHEY_SIMPLEX, 0.9, (30, 30, 30), 2, cv2.LINE_AA)
    cajas = []
    base_y = int(rng.integers(1700, 1950))
    ancho_col = (ANCHO - 200) // max(1, firmantes)
    nombres = ['Ing. Marco Alban', 'Ing. Andres Cisneros', 'Paul Aguirre']
    for i in range(firmantes):
        x0 = 100 + i * ancho_col + 60
        cv2.line(img, (x0, base_y), (x0 + ancho_col - 140, base_y), (30, 30, 30), 2)
        cv2.putText(img, 'Nombre: ' + nombres[i % 3], (x0, base_y + 45), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (30, 30, 30), 2, cv2.LINE_AA)
        cv2.putText(img, 'Cargo: Representante', (x0, base_y + 85), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (30, 30, 30), 2, cv2.LINE_AA)
        ancho = int(rng.integers(260, 480))
        alto = int(rng.integers(110, 230))
        cajas.append((x0 + int(rng.integers(0, 40)), base_y - alto - 5, min(ancho, ancho_col - 160), alto))
    return img, cajas


def escanear(img: np.ndarray, rng: np.random.Generator, intensidad: float = 1.0) -> np.ndarray:
    """Efecto de escáner: ligera rotación, fondo grisáceo, ruido, desenfoque y JPEG."""
    h, w = img.shape[:2]
    ang = rng.uniform(-1.2, 1.2) * intensidad
    m = cv2.getRotationMatrix2D((w / 2, h / 2), ang, 1.0)
    out = cv2.warpAffine(img, m, (w, h), borderValue=(255, 255, 255))
    gris = 255 - int(rng.integers(0, 18) * intensidad)
    out = (out.astype(np.float32) * (gris / 255.0)).astype(np.uint8)
    ruido = rng.normal(0, 5 * intensidad, out.shape)
    out = np.clip(out.astype(np.float32) + ruido, 0, 255).astype(np.uint8)
    if rng.random() < 0.6:
        out = cv2.GaussianBlur(out, (3, 3), 0.7)
    calidad = int(rng.integers(60, 88))
    ok, buf = cv2.imencode('.jpg', out, [cv2.IMWRITE_JPEG_QUALITY, calidad])
    return cv2.imdecode(buf, cv2.IMREAD_COLOR)


def con_firmas(base: np.ndarray, cajas: list[tuple[int, int, int, int]], rng: np.random.Generator, cuantas: int | None = None) -> np.ndarray:
    img = base.copy()
    n = cuantas if cuantas is not None else int(rng.integers(1, len(cajas) + 1))
    for caja in cajas[:n]:
        dibujar_firma(img, caja, rng)
    return img


# --- negativos -----------------------------------------------------------------------


def negativo_tipeado(rng: np.random.Generator) -> np.ndarray:
    img, cajas = pagina_formulario(rng)
    return img


def negativo_nombre_cursivo(rng: np.random.Generator) -> np.ndarray:
    """Nombre escrito con fuente cursiva de ordenador sobre la línea de firma (negativo difícil)."""
    img, cajas = pagina_formulario(rng)
    for x, y, w, h in cajas:
        cv2.putText(img, 'Marco Alban', (x, y + h - 20), cv2.FONT_HERSHEY_SCRIPT_COMPLEX, 2.2, (35, 35, 35), 2, cv2.LINE_AA)
    return img


def negativo_sello_redondo(rng: np.random.Generator) -> np.ndarray:
    img, cajas = pagina_formulario(rng)
    for x, y, w, h in cajas[:1]:
        centro = (x + w // 2, y + h // 2)
        radio = int(rng.integers(70, 110))
        cv2.circle(img, centro, radio, (160, 60, 30), 3, cv2.LINE_AA)
        cv2.circle(img, centro, radio - 14, (160, 60, 30), 2, cv2.LINE_AA)
        cv2.putText(img, 'DYNADRILL', (centro[0] - 62, centro[1] + 8), cv2.FONT_HERSHEY_SIMPLEX, 0.9, (160, 60, 30), 2, cv2.LINE_AA)
    return img


def negativo_codigo_qr(rng: np.random.Generator) -> np.ndarray:
    """Rejilla binaria aleatoria parecida a un QR junto a la línea de firma."""
    img, cajas = pagina_formulario(rng)
    modulos = 29
    tam = 4
    cuadro = (rng.random((modulos, modulos)) < 0.5).astype(np.uint8)
    for f in (slice(0, 7), slice(modulos - 7, modulos)):
        for c in (slice(0, 7), slice(modulos - 7, modulos)):
            cuadro[f, c] = 1
            cuadro[f, c][1:-1, 1:-1] = 0
            cuadro[f, c][2:-2, 2:-2] = 1
    qr = cv2.resize((1 - cuadro) * 255, None, fx=tam, fy=tam, interpolation=cv2.INTER_NEAREST)
    qr = cv2.cvtColor(qr.astype(np.uint8), cv2.COLOR_GRAY2BGR)
    x, y, _, h = cajas[0]
    img[y : y + qr.shape[0], x : x + qr.shape[1]] = qr
    cv2.putText(img, 'Firmado electronicamente por:', (x + qr.shape[1] + 8, y + 30), cv2.FONT_HERSHEY_PLAIN, 1.0, (0, 0, 0), 1, cv2.LINE_AA)
    return img


def negativo_texto_denso(rng: np.random.Generator) -> np.ndarray:
    img = np.full((ALTO, ANCHO, 3), 255, np.uint8)
    for fila in range(60):
        cv2.putText(img, 'Servicio de bombeo de fluidos %d gls tanque %d' % (rng.integers(1, 99), rng.integers(1, 99)),
                    (100, 120 + fila * 34), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (25, 25, 25), 2, cv2.LINE_AA)
    return img


def negativo_grafico(rng: np.random.Generator) -> np.ndarray:
    """Página con ejes y varias curvas suaves (monitoreo): muchos trazos curvos legítimos."""
    img = np.full((ALTO, ANCHO, 3), 255, np.uint8)
    for fila in range(4):
        y0 = 150 + fila * 520
        cv2.rectangle(img, (150, y0), (ANCHO - 150, y0 + 450), (30, 30, 30), 2)
        for _ in range(3):
            xs = np.linspace(160, ANCHO - 160, 40)
            ys = y0 + 225 + np.cumsum(rng.normal(0, 14, 40))
            ys = np.clip(ys, y0 + 10, y0 + 440)
            cv2.polylines(img, [np.column_stack([xs, ys]).astype(np.int32)], False, tuple(int(v) for v in rng.integers(0, 200, 3)), 2, cv2.LINE_AA)
    return img


def negativo_foto(rng: np.random.Generator) -> np.ndarray:
    """Fotografía/mapa sintético: degradados con manchas y textura."""
    base = rng.normal(150, 50, (ALTO // 16, ANCHO // 16, 3)).clip(0, 255).astype(np.uint8)
    img = cv2.resize(base, (ANCHO, ALTO), interpolation=cv2.INTER_CUBIC)
    return cv2.GaussianBlur(img, (5, 5), 0)


def negativo_en_blanco(rng: np.random.Generator) -> np.ndarray:
    return np.full((ALTO, ANCHO, 3), 255, np.uint8)


NEGATIVOS = {
    'tipeado': negativo_tipeado,
    'nombre_cursivo': negativo_nombre_cursivo,
    'sello_redondo': negativo_sello_redondo,
    'codigo_qr': negativo_codigo_qr,
    'texto_denso': negativo_texto_denso,
    'grafico': negativo_grafico,
    'foto': negativo_foto,
    'en_blanco': negativo_en_blanco,
}
