# Microservicio de validación de firmas con OCR. Todo corre dentro del contenedor:
# no hay llamadas a internet en ejecución ni se guarda ningún documento.
FROM python:3.12-slim-bookworm AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PYTHONPATH=/app/src

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        tesseract-ocr tesseract-ocr-spa tesseract-ocr-eng libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt

# Imagen de pruebas: docker build --target pruebas -t dynadrill-firmas-ocr:pruebas .
FROM base AS pruebas
COPY requirements-dev.txt .
RUN pip install -r requirements-dev.txt
COPY . .
CMD ["pytest", "-q"]

FROM base AS runtime
RUN useradd --system --no-create-home --uid 10001 firmas
COPY src ./src
COPY raices ./raices
USER firmas
EXPOSE 8090
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=5 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8090/salud', timeout=3).status == 200 else 1)"
CMD ["uvicorn", "firmas_ocr.main:crear_app", "--factory", "--host", "0.0.0.0", "--port", "8090", "--no-server-header"]
