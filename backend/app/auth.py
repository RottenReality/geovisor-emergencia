"""Autenticacion por clave compartida.

Una sola clave para todo el equipo: es lo que se pidio y lo que se puede
repartir por radio o WhatsApp en una emergencia. A cambio no hay trazabilidad
individual, asi que cada elemento guarda un campo `autor` que la persona
escribe al entrar (opcional pero recomendado para informes).
"""
import hmac
import time
from collections import defaultdict

from fastapi import Depends, HTTPException, Request, Response
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer

from . import config

_serializador = URLSafeTimedSerializer(config.SECRET_KEY, salt="sesion-geovisor")

# Limitador de fuerza bruta en memoria. La clave compartida esta expuesta a
# Internet: sin esto, un atacante la adivina por diccionario en horas.
_INTENTOS: dict[str, list[float]] = defaultdict(list)
_MAX_INTENTOS = 8
_VENTANA_SEG = 300


def _ip(request: Request) -> str:
    reenviado = request.headers.get("x-forwarded-for")
    if reenviado:
        return reenviado.split(",")[0].strip()
    return request.client.host if request.client else "desconocido"


def registrar_intento_fallido(request: Request) -> None:
    ahora = time.time()
    ip = _ip(request)
    _INTENTOS[ip] = [t for t in _INTENTOS[ip] if ahora - t < _VENTANA_SEG]
    _INTENTOS[ip].append(ahora)


def limpiar_intentos(request: Request) -> None:
    _INTENTOS.pop(_ip(request), None)


def verificar_limite(request: Request) -> None:
    ahora = time.time()
    ip = _ip(request)
    recientes = [t for t in _INTENTOS[ip] if ahora - t < _VENTANA_SEG]
    _INTENTOS[ip] = recientes
    if len(recientes) >= _MAX_INTENTOS:
        raise HTTPException(
            status_code=429,
            detail="Demasiados intentos fallidos. Esperar 5 minutos.",
        )


def clave_valida(enviada: str) -> bool:
    # compare_digest evita filtrar la clave por diferencias de tiempo.
    return hmac.compare_digest(enviada.encode(), config.CLAVE_ACCESO.encode())


def crear_sesion(response: Response, autor: str) -> None:
    token = _serializador.dumps({"autor": autor})
    response.set_cookie(
        config.COOKIE_NOMBRE,
        token,
        max_age=config.SESION_SEGUNDOS,
        httponly=True,
        secure=True,
        samesite="lax",
        path="/",
    )


def borrar_sesion(response: Response) -> None:
    response.delete_cookie(config.COOKIE_NOMBRE, path="/")


def leer_sesion(request: Request) -> dict | None:
    token = request.cookies.get(config.COOKIE_NOMBRE)
    if not token:
        return None
    try:
        return _serializador.loads(token, max_age=config.SESION_SEGUNDOS)
    except (BadSignature, SignatureExpired):
        return None


def requiere_sesion(request: Request) -> dict:
    """Dependencia para proteger routers completos."""
    sesion = leer_sesion(request)
    if sesion is None:
        raise HTTPException(status_code=401, detail="No autenticado")
    return sesion


SesionActiva = Depends(requiere_sesion)
