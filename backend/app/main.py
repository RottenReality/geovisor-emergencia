"""Geovisor de emergencia sismica -- API."""
import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, Response
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from . import auth, config, db
from .routers import (capas, export, externas, features, pila, rasters, subidas,
                      uploads)


@asynccontextmanager
async def ciclo_vida(app: FastAPI):
    for carpeta in (config.DIR_RASTERS, config.DIR_ENTRADA, config.DIR_PARCIALES):
        os.makedirs(carpeta, exist_ok=True)
    await db.iniciar()
    yield
    await db.cerrar()


app = FastAPI(
    title="Geovisor de Emergencia",
    description="Visor colaborativo para respuesta a desastres. Colombia, EPSG:9377.",
    version="1.0.0",
    lifespan=ciclo_vida,
)


# El de uvicorn y no uno propio: es el unico que ya trae handler y formato,
# asi la linea sale junto a las demas en `docker logs geo_api`.
registro = logging.getLogger("uvicorn.error")


@app.exception_handler(RequestValidationError)
async def cuerpo_invalido(peticion: Request, error: RequestValidationError):
    """Igual que el de serie, pero dejando dicho en el log que campo fallo.

    Un 422 es el unico error que no se explica solo: el navegador recibe una
    lista de objetos y el log, un numero. Sin esta linea, averiguar por que se
    cayo una subida exige reproducirla a ciegas.
    """
    detalles = "; ".join(
        f"{'.'.join(str(p) for p in fallo.get('loc', []))}={fallo.get('input')!r:.120} "
        f"({fallo.get('msg')})"
        for fallo in error.errors()
    )
    registro.warning("422 en %s %s -- %s", peticion.method, peticion.url.path, detalles)
    return JSONResponse(status_code=422, content={"detail": jsonable_encoder(error.errors())})


@app.get("/health")
async def salud():
    """Sin autenticacion: lo usan el healthcheck de Docker y el despliegue."""
    try:
        await db.pool().fetchval("SELECT 1")
        return {"status": "ok", "db": "ok"}
    except Exception as exc:
        return Response(
            content=f'{{"status":"degradado","db":"{exc.__class__.__name__}"}}',
            status_code=503,
            media_type="application/json",
        )


class Credenciales(BaseModel):
    clave: str
    autor: str | None = None


@app.post("/api/login")
async def login(datos: Credenciales, request: Request, response: Response):
    auth.verificar_limite(request)
    if not auth.clave_valida(datos.clave):
        auth.registrar_intento_fallido(request)
        return Response(
            content='{"detail":"Clave incorrecta"}',
            status_code=401,
            media_type="application/json",
        )
    auth.limpiar_intentos(request)
    autor = (datos.autor or "").strip()[:80] or "sin identificar"
    auth.crear_sesion(response, autor)
    return {"ok": True, "autor": autor}


@app.post("/api/logout")
async def logout(response: Response):
    auth.borrar_sesion(response)
    return {"ok": True}


@app.get("/api/session")
async def sesion(request: Request):
    """El visor consulta esto al cargar para saber si redirige al login."""
    datos = auth.leer_sesion(request)
    if datos is None:
        return Response(
            content='{"autenticado":false}',
            status_code=401,
            media_type="application/json",
        )
    return {"autenticado": True, "autor": datos.get("autor")}


app.include_router(capas.router)
app.include_router(features.router)
app.include_router(rasters.router)
app.include_router(subidas.router)
app.include_router(uploads.router)
app.include_router(export.router)
app.include_router(externas.router)
app.include_router(pila.router)
app.include_router(pila.grupos_router)
