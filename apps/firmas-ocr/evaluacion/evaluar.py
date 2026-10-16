"""Evalúa el servicio contra documentos reales y sintéticos y resume aciertos y fallos.

Uso (dentro del contenedor de pruebas, con Tesseract):
    python evaluacion/evaluar.py --soportes "/soportes" --semilla 2
Uso rápido del detector visual (sin OCR, para iterar):
    python evaluacion/evaluar.py --soportes ... --rapido

Cada caso tiene una verdad ("firma_detectada" = hay firma manuscrita; "no_detectada" = no
la hay). El servicio puede acertar, equivocarse o abstenerse ("no_concluyente"); las tres
cosas se cuentan por separado porque abstenerse no es lo mismo que fallar.
"""

import argparse
import json
import sys
import time
from collections import defaultdict
from pathlib import Path

import cv2
import numpy as np
from pypdf import PdfReader

AQUI = Path(__file__).resolve().parent
sys.path.insert(0, str(AQUI))
sys.path.insert(0, str(AQUI.parent / 'src'))

import sinteticos as sint  # noqa: E402
from firmas_ocr import analisis, ocr  # noqa: E402
from firmas_ocr.config import Configuracion  # noqa: E402
from firmas_ocr.documentos import cargar_documento  # noqa: E402
from firmas_ocr.errores import ErrorApi, Plazo  # noqa: E402

POR_DEFECTO_SOPORTES = (
    AQUI.parents[3] / 'documentacion' / 'facturacion' / 'SOPORTES EJEMPLO'
    if len(AQUI.parents) > 3
    else Path('/soportes')
)


def _png(img: np.ndarray) -> bytes:
    return cv2.imencode('.png', img)[1].tobytes()


def _jpg(img: np.ndarray) -> bytes:
    return cv2.imencode('.jpg', img, [cv2.IMWRITE_JPEG_QUALITY, 85])[1].tobytes()


def casos_reales(soportes: Path) -> list[dict]:
    etiquetas = json.loads((AQUI / 'etiquetas.json').read_text(encoding='utf-8'))
    manuscritas = set(etiquetas['firma_manuscrita'])
    casos = []
    for pdf in sorted(soportes.rglob('*.pdf')):
        esperado = 'firma_detectada' if pdf.name in manuscritas else 'no_detectada'
        casos.append(
            {
                'id': f'{pdf.parent.name}/{pdf.name}',
                'categoria': 'real_manuscrita' if esperado == 'firma_detectada' else 'real_firma_electronica',
                'esperado': esperado,
                'datos': pdf.read_bytes(),
            }
        )
    return casos


def _bases_reales(soportes: Path) -> list[tuple[str, np.ndarray, list[tuple[int, int, int, int]]]]:
    """Páginas reales de un solo folio con campos de firma, para pegar firmas sintéticas encima."""
    bases = []
    for pdf in sorted(soportes.rglob('*.pdf')):
        try:
            lector = PdfReader(str(pdf))
            if len(lector.pages) != 1:
                continue
            pagina = lector.pages[0]
            alto_pt = float(pagina.mediabox.height)
            cajas = []
            for anotacion in pagina.get('/Annots') or []:
                a = anotacion.get_object()
                if a.get('/FT') == '/Sig':
                    x0, y0, x1, y1 = (float(v) for v in a['/Rect'])
                    esc = 200 / 72
                    cajas.append((int(min(x0, x1) * esc), int((alto_pt - max(y0, y1)) * esc) - 40, 340, 150))
            if not cajas:
                continue
            img = cargar_documento(
                pdf.read_bytes(), dpi=200, max_paginas=1, max_pixeles=40_000_000, plazo=Plazo(60)
            ).paginas[0]
            bases.append((pdf.name, img, cajas))
        except Exception:
            continue
    return bases


def casos_sinteticos(soportes: Path, semilla: int, n: int) -> list[dict]:
    rng = np.random.default_rng(semilla)
    casos: list[dict] = []

    def agregar(id_, categoria, esperado, img, jpg=True):
        casos.append(
            {'id': id_, 'categoria': categoria, 'esperado': esperado, 'datos': _jpg(img) if jpg else _png(img)}
        )

    for i in range(n):
        base, cajas = sint.pagina_formulario(rng, firmantes=int(rng.integers(1, 3)))
        agregar(f'sint_formulario_{i}', 'sintetica_positiva_formulario', 'firma_detectada',
                sint.escanear(sint.con_firmas(base, cajas, rng, cuantas=1 + (i % len(cajas))), rng))
    bases = _bases_reales(soportes)
    for i in range(n):
        if not bases:
            break
        nombre, base, cajas = bases[i % len(bases)]
        agregar(f'sint_sobre_real_{i}_{nombre}', 'sintetica_positiva_sobre_pdf_real', 'firma_detectada',
                sint.escanear(sint.con_firmas(base, cajas, rng, cuantas=1), rng, 0.6))
    nombres = list(sint.NEGATIVOS)
    for i in range(n):
        nombre = nombres[i % len(nombres)]
        agregar(f'sint_neg_{nombre}_{i}', f'sintetica_negativa_{nombre}', 'no_detectada',
                sint.escanear(sint.NEGATIVOS[nombre](rng), rng))
    # degradadas: firma presente pero la imagen es mala (se espera acertar o abstenerse)
    for i in range(max(4, n // 3)):
        base, cajas = sint.pagina_formulario(rng)
        firmada = sint.con_firmas(base, cajas, rng, cuantas=1)
        if i % 2 == 0:
            mala = cv2.resize(firmada, None, fx=0.22, fy=0.22, interpolation=cv2.INTER_AREA)
            categoria = 'degradada_baja_resolucion'
        else:
            mala = cv2.GaussianBlur(firmada, (0, 0), 9)
            categoria = 'degradada_borrosa'
        agregar(f'sint_{categoria}_{i}', categoria, 'firma_detectada', mala)
    return casos


def ejecutar(caso: dict, cfg: Configuracion) -> dict:
    inicio = time.monotonic()
    try:
        r = analisis.verificar(caso['datos'], cfg, Plazo(180))
        resultado, confianza, obs = r.resultado, r.confianza, r.observaciones
    except ErrorApi as exc:
        resultado, confianza, obs = f'error_{exc.estado}', 0.0, [exc.mensaje]
    return {
        'id': caso['id'],
        'categoria': caso['categoria'],
        'esperado': caso['esperado'],
        'resultado': resultado,
        'confianza': confianza,
        'segundos': round(time.monotonic() - inicio, 2),
        'observaciones': obs,
    }


def veredicto(fila: dict) -> str:
    if fila['resultado'] == 'no_concluyente':
        return 'abstencion'
    if fila['resultado'] == fila['esperado']:
        return 'acierto'
    return 'falso_negativo' if fila['esperado'] == 'firma_detectada' else 'falso_positivo'


def resumir(filas: list[dict]) -> str:
    grupos: dict[str, list[dict]] = defaultdict(list)
    for fila in filas:
        grupos[fila['categoria']].append(fila)
        grupos['TOTAL'].append(fila)
    lineas = ['| Categoría | Casos | Aciertos | Abstenciones | Falsos negativos | Falsos positivos |',
              '|---|---:|---:|---:|---:|---:|']
    for categoria in sorted(grupos, key=lambda c: (c == 'TOTAL', c)):
        cuenta = defaultdict(int)
        for fila in grupos[categoria]:
            cuenta[veredicto(fila)] += 1
        lineas.append(
            f"| {categoria} | {len(grupos[categoria])} | {cuenta['acierto']} | {cuenta['abstencion']} | "
            f"{cuenta['falso_negativo']} | {cuenta['falso_positivo']} |"
        )
    return '\n'.join(lineas)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--soportes', type=Path, default=POR_DEFECTO_SOPORTES)
    ap.add_argument('--semilla', type=int, default=2)
    ap.add_argument('--n', type=int, default=24, help='casos por grupo sintético')
    ap.add_argument('--rapido', action='store_true', help='sin OCR (solo detector visual)')
    ap.add_argument('--guardar-fallos', type=Path, help='carpeta donde guardar los casos no acertados')
    ap.add_argument('--salida', type=Path, default=AQUI / 'salida')
    args = ap.parse_args()

    if args.rapido:
        ocr.reconocer = lambda imagen, idiomas, plazo: []  # type: ignore[assignment]
    elif not ocr.tesseract_disponible():
        print('Tesseract no está instalado; use --rapido o ejecute dentro del contenedor.', file=sys.stderr)
        return 2

    cfg = Configuracion(api_key='evaluacion')
    casos = casos_reales(args.soportes) + casos_sinteticos(args.soportes, args.semilla, args.n)
    filas = []
    for i, caso in enumerate(casos, 1):
        fila = ejecutar(caso, cfg)
        filas.append(fila)
        if args.guardar_fallos and veredicto(fila) != 'acierto' and caso['categoria'].startswith('sint'):
            args.guardar_fallos.mkdir(parents=True, exist_ok=True)
            (args.guardar_fallos / f"{caso['id'][:80]}.jpg").write_bytes(caso['datos'])
        print(f"[{i}/{len(casos)}] {veredicto(fila):15} {fila['categoria']:42} {fila['id'][:60]}", flush=True)

    args.salida.mkdir(exist_ok=True)
    (args.salida / 'resultados.json').write_text(json.dumps(filas, ensure_ascii=False, indent=1), encoding='utf-8')
    tabla = resumir(filas)
    (args.salida / 'tablas.md').write_text(tabla + '\n', encoding='utf-8')
    print('\n' + tabla)
    print('\nCasos no acertados:')
    for fila in filas:
        if veredicto(fila) != 'acierto':
            print(f"  {veredicto(fila):15} esperado={fila['esperado']:15} obtenido={fila['resultado']:15} "
                  f"conf={fila['confianza']:.2f}  {fila['id']}  {fila['observaciones'][:1]}")
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
