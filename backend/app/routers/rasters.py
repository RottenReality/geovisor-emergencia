"""Rasters: ortofotos de dron y satelital.

Flujo: se recibe el archivo en streaming, se comprueba si ya cumple COG y, si
no, se convierte con GDAL en segundo plano. La respuesta es inmediata para que
quien sube no quede esperando frente a un archivo de 800 MB.

TiTiler queda SOLO en la red interna. El navegador nunca le habla directamente
ni le pasa rutas: pide /api/rasters/{id}/tiles/... y este modulo resuelve el
archivo del lado del servidor. Sin eso, cualquiera podria hacer que TiTiler
leyera rutas o URLs arbitrarias del servidor.
"""
import asyncio
import json
import os
import re
import shutil
import uuid

import httpx
from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, HTTPException, Response, UploadFile
from pydantic import BaseModel, Field

from .. import config, db
from ..auth import requiere_sesion

router = APIRouter(prefix="/api/rasters", dependencies=[Depends(requiere_sesion)])

TROZO = 4 * 1024 * 1024          # 4 MB por lectura al recibir el archivo
EXTENSIONES = (".tif", ".tiff", ".cog")

# TiTiler cambio la forma de sus rutas entre versiones. Se prueba la actual y
# se recuerda cual respondio, en vez de fijar una y fallar en el peor momento.
_ruta_titiler: str | None = None
_RUTAS_POSIBLES = (
    "/cog/tiles/WebMercatorQuad/{z}/{x}/{y}.png",
    "/cog/tiles/{z}/{x}/{y}.png",
)

_cliente = httpx.AsyncClient(timeout=30.0)


class RasterParche(BaseModel):
    nombre: str | None = None
    visible: bool | None = None
    opacidad: float | None = Field(default=None, ge=0, le=1)
    orden: int | None = None


def _nombre_seguro(original: str) -> str:
    base = re.sub(r"[^A-Za-z0-9._-]", "_", os.path.basename(original or "raster.tif"))
    return f"{uuid.uuid4().hex[:12]}_{base[:60]}"


async def _correr(*orden: str) -> tuple[int, bytes, bytes]:
    proceso = await asyncio.create_subprocess_exec(
        *orden,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        # Limita la cache de GDAL: sin esto, convertir una ortofoto grande se
        # come la RAM del contenedor y el kernel lo mata.
        env={**os.environ, "GDAL_CACHEMAX": "256"},
    )
    salida, error = await proceso.communicate()
    return proceso.returncode, salida, error


async def _inspeccionar(ruta: str) -> dict:
    codigo, salida, error = await _correr("gdalinfo", "-json", ruta)
    if codigo != 0:
        raise RuntimeError(error.decode(errors="replace")[:300] or "gdalinfo fallo")
    return json.loads(salida)


def _es_cog(info: dict) -> bool:
    estructura = info.get("metadata", {}).get("IMAGE_STRUCTURE", {})
    return estructura.get("LAYOUT", "").upper() == "COG"


def _bounds(info: dict) -> list[float] | None:
    extension = info.get("wgs84Extent")
    if not extension:
        return None
    puntos: list[list[float]] = []

    def recolectar(nodo):
        if isinstance(nodo, list) and nodo and isinstance(nodo[0], (int, float)):
            puntos.append(nodo)
        elif isinstance(nodo, list):
            for hijo in nodo:
                recolectar(hijo)

    recolectar(extension.get("coordinates", []))
    if not puntos:
        return None
    return [
        min(p[0] for p in puntos), min(p[1] for p in puntos),
        max(p[0] for p in puntos), max(p[1] for p in puntos),
    ]


async def _procesar(id_raster: int, origen: str, destino: str) -> None:
    """Corre en segundo plano: valida, convierte a COG si hace falta y publica."""
    try:
        await db.pool().execute(
            "UPDATE rasters SET estado='procesando' WHERE id=$1", id_raster)

        info = await _inspeccionar(origen)
        if not info.get("coordinateSystem", {}).get("wkt"):
            raise RuntimeError(
                "El archivo no trae sistema de referencia. Asignalo en QGIS "
                "(Capa > Establecer SRC) y vuelve a subirlo.")

        if _es_cog(info):
            shutil.move(origen, destino)
        else:
            codigo, _, error = await _correr(
                "gdal_translate", "-of", "COG",
                "-co", "COMPRESS=DEFLATE",
                "-co", "BLOCKSIZE=512",
                "-co", "OVERVIEWS=AUTO",
                "-co", "NUM_THREADS=2",
                origen, destino,
            )
            if codigo != 0:
                raise RuntimeError(error.decode(errors="replace")[-300:] or "gdal_translate fallo")
            os.remove(origen)

        bounds = _bounds(await _inspeccionar(destino))
        await db.pool().execute(
            "UPDATE rasters SET estado='listo', archivo=$2, bounds=$3, mensaje=NULL WHERE id=$1",
            id_raster, os.path.basename(destino), bounds,
        )
    except Exception as excepcion:
        await db.pool().execute(
            "UPDATE rasters SET estado='error', mensaje=$2 WHERE id=$1",
            id_raster, str(excepcion)[:500],
        )
        for sobrante in (origen, destino):
            if os.path.exists(sobrante):
                try:
                    os.remove(sobrante)
                except OSError:
                    pass


@router.get("")
async def listar():
    filas = await db.pool().fetch(
        "SELECT id, nombre, estado, mensaje, bounds, visible, opacidad, orden, autor, creado_en "
        "FROM rasters ORDER BY orden NULLS LAST, id"
    )
    return [dict(f) for f in filas]


@router.post("", status_code=202)
async def subir(
    tareas: BackgroundTasks,
    archivo: UploadFile = File(...),
    nombre: str = Form(...),
    sesion: dict = Depends(requiere_sesion),
):
    if not (archivo.filename or "").lower().endswith(EXTENSIONES):
        raise HTTPException(
            status_code=400,
            detail="Formato no admitido. Sube un GeoTIFF (.tif) o un COG.")

    os.makedirs(config.DIR_RASTERS, exist_ok=True)
    seguro = _nombre_seguro(archivo.filename)
    origen = os.path.join(config.DIR_RASTERS, f"entrada_{seguro}")
    destino = os.path.join(config.DIR_RASTERS, f"{os.path.splitext(seguro)[0]}.tif")

    # Se escribe por trozos: un .read() completo de una ortofoto de 800 MB
    # reventaria el limite de memoria del contenedor.
    bytes_escritos = 0
    try:
        with open(origen, "wb") as salida:
            while trozo := await archivo.read(TROZO):
                salida.write(trozo)
                bytes_escritos += len(trozo)
    except Exception as excepcion:
        if os.path.exists(origen):
            os.remove(origen)
        raise HTTPException(status_code=500, detail=f"No se pudo guardar: {excepcion}") from excepcion

    if bytes_escritos == 0:
        os.remove(origen)
        raise HTTPException(status_code=400, detail="El archivo llego vacio")

    fila = await db.pool().fetchrow(
        """
        INSERT INTO rasters (nombre, estado, autor, orden)
        VALUES ($1, 'pendiente', $2, COALESCE((SELECT MAX(orden) + 1 FROM rasters), 1))
        RETURNING id, nombre, estado, orden
        """,
        nombre.strip() or archivo.filename,
        sesion.get("autor"),
    )

    tareas.add_task(_procesar, fila["id"], origen, destino)
    return {**dict(fila), "bytes": bytes_escritos}


@router.patch("/{id_raster}")
async def editar(id_raster: int, parche: RasterParche):
    fila = await db.pool().fetchrow(
        """
        UPDATE rasters SET
          nombre   = COALESCE($2, nombre),
          visible  = COALESCE($3, visible),
          opacidad = COALESCE($4, opacidad),
          orden    = COALESCE($5, orden)
        WHERE id = $1
        RETURNING id, nombre, visible, opacidad, orden
        """,
        id_raster, parche.nombre, parche.visible, parche.opacidad, parche.orden,
    )
    if fila is None:
        raise HTTPException(status_code=404, detail="Raster no encontrado")
    return dict(fila)


@router.delete("/{id_raster}")
async def borrar(id_raster: int):
    fila = await db.pool().fetchrow(
        "DELETE FROM rasters WHERE id=$1 RETURNING nombre, archivo", id_raster)
    if fila is None:
        raise HTTPException(status_code=404, detail="Raster no encontrado")
    if fila["archivo"]:
        ruta = os.path.join(config.DIR_RASTERS, fila["archivo"])
        if os.path.exists(ruta):
            try:
                os.remove(ruta)
            except OSError:
                pass
    return {"ok": True, "nombre": fila["nombre"]}


@router.get("/{id_raster}/tiles/{z}/{x}/{y}.png")
async def tesela(id_raster: int, z: int, x: int, y: int):
    global _ruta_titiler

    archivo = await db.pool().fetchval(
        "SELECT archivo FROM rasters WHERE id=$1 AND estado='listo'", id_raster)
    if not archivo:
        raise HTTPException(status_code=404, detail="Raster no disponible")

    ruta_local = os.path.join(config.DIR_RASTERS, os.path.basename(archivo))
    candidatas = [_ruta_titiler] if _ruta_titiler else list(_RUTAS_POSIBLES)

    for plantilla in candidatas:
        destino = config.TITILER_URL + plantilla.format(z=z, x=x, y=y)
        try:
            respuesta = await _cliente.get(destino, params={"url": ruta_local})
        except httpx.HTTPError as excepcion:
            raise HTTPException(status_code=502, detail=f"TiTiler no responde: {excepcion}") from excepcion

        if respuesta.status_code == 404 and _ruta_titiler is None:
            continue   # ruta equivocada para esta version de TiTiler; probar la otra
        _ruta_titiler = plantilla
        return Response(
            content=respuesta.content,
            status_code=respuesta.status_code,
            media_type=respuesta.headers.get("content-type", "image/png"),
            # Los rasters no cambian una vez convertidos: si se pueden cachear.
            headers={"Cache-Control": "public, max-age=86400"},
        )

    raise HTTPException(status_code=502, detail="Ninguna ruta de TiTiler respondio")
