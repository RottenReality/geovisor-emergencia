"""Geovisor de emergencia sismica -- API."""
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, Response
from pydantic import BaseModel

from . import auth, config, db
from .routers import capas, export, features, rasters, subidas, uploads


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
