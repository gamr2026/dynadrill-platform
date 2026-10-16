"""Errores de dominio; cada uno lleva el código HTTP con el que se responde."""

import time


class ErrorApi(Exception):
    estado = 500
    codigo = 'error_interno'

    def __init__(self, mensaje: str):
        super().__init__(mensaje)
        self.mensaje = mensaje


class SolicitudInvalida(ErrorApi):
    estado = 400
    codigo = 'solicitud_invalida'


class NoAutorizado(ErrorApi):
    estado = 401
    codigo = 'no_autorizado'


class ArchivoDemasiadoGrande(ErrorApi):
    estado = 413
    codigo = 'archivo_demasiado_grande'


class TipoNoSoportado(ErrorApi):
    estado = 415
    codigo = 'tipo_no_soportado'


class DocumentoNoProcesable(ErrorApi):
    estado = 422
    codigo = 'documento_no_procesable'


class TiempoAgotado(ErrorApi):
    estado = 504
    codigo = 'tiempo_agotado'


class Plazo:
    """Reloj de pared compartido por todas las etapas de un análisis."""

    def __init__(self, segundos: float):
        self._limite = time.monotonic() + segundos

    def restante(self) -> float:
        return self._limite - time.monotonic()

    def verificar(self) -> None:
        if self.restante() <= 0:
            raise TiempoAgotado('El análisis superó el tiempo máximo permitido.')
