"""API HTTP: GET /salud y POST /v1/verificar."""

import asyncio
import hmac
from contextlib import asynccontextmanager

from fastapi import FastAPI, File, Form, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool
from starlette.exceptions import HTTPException as HttpStarlette

from . import __version__, analisis, ocr
from .documentos import detectar_tipo
from .firma_electronica import validar_pdf
from .raices import cargar_certificados
from .config import Configuracion
from .errores import (
    ArchivoDemasiadoGrande,
    DocumentoNoProcesable,
    ErrorApi,
    NoAutorizado,
    Plazo,
    SolicitudInvalida,
    TiempoAgotado,
    TipoNoSoportado,
)
from .esquemas import RespuestaFirmaElectronica, RespuestaSalud, RespuestaVerificacion

MAX_TEXTO_ESPERADO = 200
SOBRECARGA_MULTIPART = 64 * 1024  # bytes de cabeceras/campos además del archivo


def _error(estado: int, codigo: str, mensaje: str) -> JSONResponse:
    return JSONResponse(status_code=estado, content={'error': {'codigo': codigo, 'mensaje': mensaje}})


def crear_app(cfg: Configuracion | None = None) -> FastAPI:
    config = cfg or Configuracion.desde_entorno()
    if not config.api_key:
        raise RuntimeError('Falta FIRMAS_OCR_API_KEY: el servicio no arranca sin llave interna.')

    @asynccontextmanager
    async def ciclo(app: FastAPI):
        app.state.cupo = asyncio.Semaphore(config.max_concurrentes)
        yield

    app = FastAPI(
        title='Dynadrill · Firmas OCR',
        version=__version__,
        description='Ayuda a la revisión de firmas manuscritas. No certifica autenticidad.',
        lifespan=ciclo,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    app.state.config = config
    raices, intermedias = cargar_certificados(config.raices_dir)

    @app.middleware('http')
    async def proteger(request: Request, siguiente):
        # Llave y tamaño se validan antes de leer el cuerpo, para no recibir archivos de más.
        if request.url.path.startswith('/v1/'):
            enviada = request.headers.get('x-api-key', '')
            if not hmac.compare_digest(enviada.encode(), config.api_key.encode()):
                return _error(401, NoAutorizado.codigo, 'Llave interna ausente o inválida.')
            declarado = request.headers.get('content-length')
            if declarado and declarado.isdigit() and int(declarado) > config.max_bytes + SOBRECARGA_MULTIPART:
                return _error(
                    413,
                    ArchivoDemasiadoGrande.codigo,
                    f'El archivo supera el máximo de {config.max_bytes // (1024 * 1024)} MB.',
                )
        return await siguiente(request)

    @app.exception_handler(ErrorApi)
    async def manejar_error_api(_: Request, exc: ErrorApi) -> JSONResponse:
        return _error(exc.estado, exc.codigo, exc.mensaje)

    @app.exception_handler(RequestValidationError)
    async def manejar_validacion(_: Request, exc: RequestValidationError) -> JSONResponse:
        return _error(422, 'parametros_invalidos', 'La solicitud no cumple el formato esperado.')

    @app.exception_handler(HttpStarlette)
    async def manejar_http(_: Request, exc: HttpStarlette) -> JSONResponse:
        return _error(exc.status_code, 'error_http', str(exc.detail))

    @app.get('/salud', response_model=RespuestaSalud)
    async def salud() -> RespuestaSalud:
        disponible = ocr.tesseract_disponible()
        return RespuestaSalud(
            estado='ok' if disponible else 'degradado',
            version=__version__,
            ocr_disponible=disponible,
            raices_cargadas=len(raices),
        )

    async def _leer_archivo(archivo: UploadFile) -> bytes:
        acumulado = bytearray()
        while bloque := await archivo.read(1024 * 1024):
            acumulado.extend(bloque)
            if len(acumulado) > config.max_bytes:
                raise ArchivoDemasiadoGrande(
                    f'El archivo supera el máximo de {config.max_bytes // (1024 * 1024)} MB.'
                )
        return bytes(acumulado)

    def _validar_texto(valor: str | None, campo: str) -> str | None:
        if valor is not None and len(valor) > MAX_TEXTO_ESPERADO:
            raise DocumentoNoProcesable(f'{campo} excede {MAX_TEXTO_ESPERADO} caracteres.')
        return valor

    @app.post('/v1/verificar', response_model=RespuestaVerificacion)
    async def verificar(
        request: Request,
        archivo: UploadFile | None = File(default=None),
        nombre_esperado: str | None = Form(default=None),
        cargo_esperado: str | None = Form(default=None),
    ) -> RespuestaVerificacion:
        plazo = Plazo(config.timeout_s)
        if archivo is None:
            raise SolicitudInvalida('Falta el campo "archivo" (multipart/form-data).')
        nombre = _validar_texto(nombre_esperado, 'nombre_esperado')
        cargo = _validar_texto(cargo_esperado, 'cargo_esperado')
        datos = await _leer_archivo(archivo)
        if not datos:
            raise SolicitudInvalida('El archivo está vacío.')

        async def trabajo() -> RespuestaVerificacion:
            async with request.app.state.cupo:
                plazo.verificar()
                return await run_in_threadpool(
                    analisis.verificar, datos, config, plazo, nombre, cargo
                )

        try:
            return await asyncio.wait_for(trabajo(), timeout=plazo.restante())
        except asyncio.TimeoutError as exc:
            raise TiempoAgotado('El análisis superó el tiempo máximo permitido.') from exc

    @app.post('/v1/firma-electronica', response_model=RespuestaFirmaElectronica)
    async def firma_electronica(
        request: Request, archivo: UploadFile | None = File(default=None)
    ) -> RespuestaFirmaElectronica:
        plazo = Plazo(config.timeout_s)
        if archivo is None:
            raise SolicitudInvalida('Falta el campo "archivo" (multipart/form-data).')
        datos = await _leer_archivo(archivo)
        if not datos:
            raise SolicitudInvalida('El archivo está vacío.')
        if detectar_tipo(datos) != 'pdf':
            raise TipoNoSoportado('Las firmas digitales solo se validan en archivos PDF.')

        async def trabajo() -> RespuestaFirmaElectronica:
            async with request.app.state.cupo:
                plazo.verificar()
                return await run_in_threadpool(validar_pdf, datos, raices, plazo, intermedias)

        try:
            return await asyncio.wait_for(trabajo(), timeout=plazo.restante())
        except asyncio.TimeoutError as exc:
            raise TiempoAgotado('El análisis superó el tiempo máximo permitido.') from exc

    return app
