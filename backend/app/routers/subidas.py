"""Subida de archivos grandes por trozos, reanudable.

El equipo esta repartido entre ciudades y sube escenas satelitales de mas de
un gigabyte por conexiones que no siempre aguantan. Un POST unico no sirve:
un microcorte obliga a repetirlo entero, y mientras dura deja ocupado uno de
los dos workers de la API, con lo que la web deja de responder para todos.

Aqui el navegador parte el archivo y envia trozos de unos megabytes. Cada
peticion dura segundos, los trozos se escriben en su desplazamiento exacto
(asi el orden no importa) y el servidor recuerda cuales llegaron, de modo que
reanudar es simplemente preguntar que falta.
"""
import json
import os
import shutil
import uuid

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from .. import config, db
from ..auth import requiere_sesion

router = APIRouter(prefix="/api/subidas", dependencies=[Depends(requiere_sesion)])

MIN_TROZO = 1 * 1024 * 1024
MAX_TROZO = 32 * 1024 * 1024
MAX_TAMANO = 8 * 1024 * 1024 * 1024        # 8 GB por archivo
MARGEN_DISCO = 6 * 1024 * 1024 * 1024      # nunca dejar el disco por debajo de esto

EXTENSIONES = {
    "raster": (".tif", ".tiff", ".cog"),
    "vector": (".geojson", ".json"),
}


class NuevaSubida(BaseModel):
    archivo: str
    nombre: str
    tamano: int = Field(gt=0, le=MAX_TAMANO)
    tam_trozo: int = Field(default=8 * 1024 * 1024, ge=MIN_TROZO, le=MAX_TROZO)
    tipo: str = "raster"


def _ruta_parcial(id_subida: str) -> str:
    return os.path.join(config.DIR_PARCIALES, f"{id_subida}.part")


def _estado(fila) -> dict:
    recibidos = list(fila["trozos_recibidos"] or [])
    return {
        "id": fila["id"],
        "tipo": fila["tipo"],
        "nombre": fila["nombre"],
        "archivo": fila["archivo"],
        "tamano": fila["tamano"],
        "tam_trozo": fila["tam_trozo"],
        "total_trozos": fila["total_trozos"],
        "trozos_recibidos": sorted(recibidos),
        "completa": len(recibidos) == fila["total_trozos"],
    }


@router.get("")
async def listar():
    """Subidas a medio camino, para poder retomarlas desde cualquier equipo."""
    filas = await db.pool().fetch(
        "SELECT * FROM subidas ORDER BY creado_en DESC LIMIT 50")
    return [_estado(f) for f in filas]


@router.post("", status_code=201)
async def crear(datos: NuevaSubida, sesion: dict = Depends(requiere_sesion)):
    if datos.tipo not in EXTENSIONES:
        raise HTTPException(status_code=400, detail="tipo debe ser 'raster' o 'vector'")
    if not datos.archivo.lower().endswith(EXTENSIONES[datos.tipo]):
        permitidas = ", ".join(EXTENSIONES[datos.tipo])
        raise HTTPException(status_code=400, detail=f"Para {datos.tipo} se admite: {permitidas}")

    os.makedirs(config.DIR_PARCIALES, exist_ok=True)

    # Convertir a COG necesita el original y el resultado a la vez, asi que se
    # reserva el doble antes de aceptar. Es preferible rechazar ahora que
    # quedarse sin disco a mitad de la conversion.
    libre = shutil.disk_usage(config.DIR_DATOS).free
    if libre - (datos.tamano * 2) < MARGEN_DISCO:
        raise HTTPException(
            status_code=507,
            detail=f"No hay espacio suficiente. Libres {libre // 1024**3} GB y "
                   f"este archivo necesita unos {(datos.tamano * 2) // 1024**3 + 1} GB.")

    id_subida = uuid.uuid4().hex
    total = -(-datos.tamano // datos.tam_trozo)   # division hacia arriba

    # Se crea el archivo del tamano final (disperso): asi cada trozo se escribe
    # directamente en su sitio y no hace falta ensamblar nada al terminar.
    with open(_ruta_parcial(id_subida), "wb") as parcial:
        parcial.truncate(datos.tamano)

    fila = await db.pool().fetchrow(
        """
        INSERT INTO subidas (id, tipo, nombre, archivo, tamano, tam_trozo, total_trozos, autor)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING *
        """,
        id_subida, datos.tipo, datos.nombre.strip() or datos.archivo,
        os.path.basename(datos.archivo), datos.tamano, datos.tam_trozo, total,
        sesion.get("autor"),
    )
    return _estado(fila)


@router.get("/{id_subida}")
async def consultar(id_subida: str):
    fila = await db.pool().fetchrow("SELECT * FROM subidas WHERE id=$1", id_subida)
    if fila is None:
        raise HTTPException(status_code=404, detail="Esa subida ya no existe")
    return _estado(fila)


@router.put("/{id_subida}/{indice}")
async def recibir_trozo(id_subida: str, indice: int, peticion: Request):
    fila = await db.pool().fetchrow("SELECT * FROM subidas WHERE id=$1", id_subida)
    if fila is None:
        raise HTTPException(status_code=404, detail="Esa subida ya no existe")
    if not 0 <= indice < fila["total_trozos"]:
        raise HTTPException(status_code=400, detail="Trozo fuera de rango")

    cuerpo = await peticion.body()
    if not cuerpo:
        raise HTTPException(status_code=400, detail="Trozo vacio")

    desplazamiento = indice * fila["tam_trozo"]
    esperado = min(fila["tam_trozo"], fila["tamano"] - desplazamiento)
    if len(cuerpo) != esperado:
        raise HTTPException(
            status_code=400,
            detail=f"El trozo {indice} deberia medir {esperado} bytes y llegaron {len(cuerpo)}")

    ruta = _ruta_parcial(id_subida)
    if not os.path.exists(ruta):
        raise HTTPException(status_code=410, detail="El archivo parcial se perdio; reinicia la subida")

    with open(ruta, "r+b") as parcial:
        parcial.seek(desplazamiento)
        parcial.write(cuerpo)

    # array_append solo si falta, para que reenviar un trozo sea inofensivo.
    actualizada = await db.pool().fetchrow(
        """
        UPDATE subidas
           SET trozos_recibidos = CASE WHEN $2 = ANY(trozos_recibidos)
                                       THEN trozos_recibidos
                                       ELSE array_append(trozos_recibidos, $2) END,
               actualizado_en = now()
        WHERE id = $1
        RETURNING *
        """,
        id_subida, indice,
    )
    return _estado(actualizada)


@router.post("/{id_subida}/finalizar")
async def finalizar(id_subida: str, sesion: dict = Depends(requiere_sesion)):
    fila = await db.pool().fetchrow("SELECT * FROM subidas WHERE id=$1", id_subida)
    if fila is None:
        raise HTTPException(status_code=404, detail="Esa subida ya no existe")

    faltan = sorted(set(range(fila["total_trozos"])) - set(fila["trozos_recibidos"] or []))
    if faltan:
        raise HTTPException(
            status_code=409,
            detail=f"Faltan {len(faltan)} trozos (el primero es el {faltan[0]})")

    ruta = _ruta_parcial(id_subida)
    if not os.path.exists(ruta) or os.path.getsize(ruta) != fila["tamano"]:
        raise HTTPException(status_code=410, detail="El archivo parcial no cuadra; reinicia la subida")

    if fila["tipo"] == "raster":
        resultado = await _encolar_raster(fila, ruta, sesion)
    else:
        resultado = await _ingerir_vector(fila, ruta, sesion)

    await db.pool().execute("DELETE FROM subidas WHERE id=$1", id_subida)
    return resultado


@router.delete("/{id_subida}")
async def cancelar(id_subida: str):
    await db.pool().execute("DELETE FROM subidas WHERE id=$1", id_subida)
    ruta = _ruta_parcial(id_subida)
    if os.path.exists(ruta):
        try:
            os.remove(ruta)
        except OSError:
            pass
    return {"ok": True}


# ---------------------------------------------------------------------------
# Destinos
# ---------------------------------------------------------------------------
async def _encolar_raster(fila, ruta: str, sesion: dict) -> dict:
    """Deja el archivo listo y lo pone en la cola. Convierte el worker, no la API."""
    from .rasters import nombre_seguro          # import local: evita ciclo

    os.makedirs(config.DIR_RASTERS, exist_ok=True)
    seguro = nombre_seguro(fila["archivo"])
    origen = os.path.join(config.DIR_RASTERS, f"entrada_{seguro}")
    destino = os.path.join(config.DIR_RASTERS, f"{os.path.splitext(seguro)[0]}.tif")
    shutil.move(ruta, origen)

    creada = await db.pool().fetchrow(
        """
        INSERT INTO rasters (nombre, estado, autor, origen, destino, orden)
        VALUES ($1, 'pendiente', $2, $3, $4,
                COALESCE((SELECT MAX(orden) + 1 FROM rasters), 1))
        RETURNING id, nombre, estado
        """,
        fila["nombre"], sesion.get("autor"), origen, destino,
    )
    return {"tipo": "raster", **dict(creada)}


async def _ingerir_vector(fila, ruta: str, sesion: dict) -> dict:
    from .uploads import insertar_geojson       # import local: evita ciclo

    with open(ruta, "rb") as archivo:
        crudo = json.load(archivo)
    os.remove(ruta)

    capa_id, insertados, omitidos = await insertar_geojson(
        crudo, fila["nombre"], "#457b9d", sesion.get("autor"))
    return {"tipo": "vector", "capa_id": capa_id,
            "insertados": insertados, "omitidos": omitidos}
