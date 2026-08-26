"""Sirve los modelos 3D que viven en /datos/modelos.

Por que pasan por la API y no por Caddy directamente
----------------------------------------------------
Caddy sirve /web sin preguntar nada, y ahi solo hay codigo. Un vuelo de dron
sobre una estructura danada es dato, y el dato del visor esta detras de la
clave compartida. Colgarlo de una ruta publica seria dejar 628 MB de
fotogrametria de un monumento a la vista de cualquiera que adivine la ruta.
Los rasters ya siguen este mismo camino, asi que no se inventa nada.

El coste es bajo: una sesion pide del orden de cien teselas de ~250 KB, y
FastAPI las manda con sendfile sin leerlas en memoria.
"""
import json
import os

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse, JSONResponse

from .. import config, modelos3d
from ..auth import requiere_sesion

router = APIRouter(prefix="/api/modelos", dependencies=[Depends(requiere_sesion)])

DIR_MODELOS = os.path.join(config.DIR_DATOS, "modelos")

# Las teselas de un vuelo no cambian nunca: una vez procesado, el modelo es un
# archivo muerto. Una semana de cache le ahorra al equipo volver a bajar
# decenas de MB cada vez que abre el visor. `private` y no `public` porque van
# detras de la sesion y no deben quedarse en una cache compartida.
CACHE = "private, max-age=604800, immutable"

# Solo lo que compone un tileset. Es una lista blanca y no una negra a
# proposito: si algun dia alguien deja un .env o un respaldo dentro de la
# carpeta del modelo, esto no lo sirve.
EXTENSIONES = (".b3dm", ".json", ".cmpt", ".pnts", ".glb", ".gltf")


def _modelo(clave: str) -> modelos3d.Modelo:
    modelo = modelos3d.POR_CLAVE.get(clave)
    if modelo is None:
        raise HTTPException(status_code=404, detail="No existe ese modelo")
    return modelo


def _carpeta(modelo: modelos3d.Modelo) -> str:
    return os.path.realpath(os.path.join(DIR_MODELOS, modelo.carpeta))


def _archivo(modelo: modelos3d.Modelo, ruta: str) -> str:
    """Ruta absoluta de un archivo del modelo, o 404/403.

    El nombre viene de una URI dentro del tileset, que a su vez viene del
    disco, pero se valida igual: la peticion la construye el navegador y
    cualquiera puede pedir lo que quiera.
    """
    base = _carpeta(modelo)
    destino = os.path.realpath(os.path.join(base, ruta))
    # realpath ya resolvio los .. y los enlaces; comparar despues es lo que
    # convierte esto en una comprobacion y no en un adorno.
    if destino != base and not destino.startswith(base + os.sep):
        raise HTTPException(status_code=403, detail="Ruta fuera del modelo")
    if not destino.lower().endswith(EXTENSIONES):
        raise HTTPException(status_code=403, detail="Ese tipo de archivo no se sirve")
    if not os.path.isfile(destino):
        raise HTTPException(status_code=404, detail="No esta ese archivo del modelo")
    return destino


@router.get("/{clave}/tileset.json")
async def tileset(clave: str):
    """Raiz del tileset, con el modelo ya apoyado en el plano del mapa.

    Se genera en cada peticion en vez de guardarse arreglado en disco para que
    recalibrar `altura_base` sea cambiar un numero y recargar, sin volver a
    tocar 628 MB de archivos. Es un JSON de medio kilobyte: no hay nada que
    optimizar aqui.
    """
    modelo = _modelo(clave)
    origen = _archivo(modelo, modelo.raiz)
    try:
        with open(origen, encoding="utf8") as f:
            crudo = json.load(f)
        apoyado = modelos3d.raiz_apoyada(crudo, modelo.altura_base)
    except (OSError, ValueError, json.JSONDecodeError) as error:
        raise HTTPException(
            status_code=500,
            detail=f"El tileset del modelo no se pudo leer: {error}",
        ) from error
    # Sin cache: es lo unico del modelo que puede cambiar entre despliegues.
    return JSONResponse(apoyado, headers={"Cache-Control": "no-cache"})


@router.get("/{clave}/{ruta:path}")
async def archivo(clave: str, ruta: str):
    """Una tesela o un tileset hijo, tal cual esta en disco."""
    modelo = _modelo(clave)
    destino = _archivo(modelo, ruta)
    tipo = ("application/json" if destino.lower().endswith(".json")
            else "application/octet-stream")
    return FileResponse(destino, media_type=tipo, headers={"Cache-Control": CACHE})
