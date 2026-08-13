"""Carga de capas vectoriales.

Los GeoJSON pequenos entran por aqui de un solo envio. Los grandes llegan
trozeados por /api/subidas y terminan llamando a insertar_geojson().
"""
import json

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile

from .. import db
from ..auth import requiere_sesion

router = APIRouter(prefix="/api", dependencies=[Depends(requiere_sesion)])

MAX_BYTES = 60 * 1024 * 1024

# Claves habituales donde suele venir un nombre legible en capas oficiales.
CLAVES_NOMBRE = ("nombre", "name", "NOMBRE", "Nombre", "titulo", "TITULO", "id")


def extraer_features(crudo: dict) -> list[dict]:
    tipo = crudo.get("type")
    if tipo == "FeatureCollection":
        return crudo.get("features") or []
    if tipo == "Feature":
        return [crudo]
    # Geometria suelta (GeoJSON valido pero sin envoltorio).
    if tipo in {"Point", "LineString", "Polygon", "MultiPoint",
                "MultiLineString", "MultiPolygon", "GeometryCollection"}:
        return [{"type": "Feature", "geometry": crudo, "properties": {}}]
    raise HTTPException(status_code=400, detail=f"GeoJSON no reconocido: {tipo!r}")


async def insertar_geojson(crudo: dict, nombre_capa: str, color: str,
                           autor: str | None) -> tuple[int, int, int]:
    """Crea la capa e inserta sus entidades. Devuelve (capa_id, insertados, omitidos)."""
    features = extraer_features(crudo)
    if not features:
        raise HTTPException(status_code=400, detail="El archivo no contiene entidades")

    async with db.pool().acquire() as conexion:
        async with conexion.transaction():
            capa_id = await conexion.fetchval(
                "INSERT INTO capas (nombre, color, orden) "
                "VALUES ($1, $2, COALESCE((SELECT MAX(orden) + 1 FROM capas), 1)) "
                "RETURNING id",
                nombre_capa, color,
            )

            insertados = omitidos = 0
            for feature in features:
                geometria = feature.get("geometry")
                if not geometria:
                    omitidos += 1
                    continue
                propiedades = feature.get("properties") or {}
                etiqueta = next(
                    (str(propiedades[k]) for k in CLAVES_NOMBRE
                     if propiedades.get(k) not in (None, "")),
                    None,
                )
                try:
                    # Savepoint por entidad: en PostgreSQL un error aborta la
                    # transaccion completa, asi que sin esto una sola geometria
                    # corrupta invalidaria todas las insercciones siguientes.
                    async with conexion.transaction():
                        await conexion.execute(
                            """
                            INSERT INTO elementos (nombre, capa_id, propiedades, geom, autor)
                            VALUES ($1, $2, $3::jsonb,
                                    ST_Force2D(ST_SetSRID(ST_GeomFromGeoJSON($4), 4326)), $5)
                            """,
                            etiqueta, capa_id, json.dumps(propiedades),
                            json.dumps(geometria), autor,
                        )
                    insertados += 1
                except Exception:
                    omitidos += 1

    if insertados == 0:
        raise HTTPException(
            status_code=400,
            detail="Ninguna entidad pudo cargarse. Verificar que el archivo este en EPSG:4326.")

    return capa_id, insertados, omitidos


@router.post("/upload/vector", status_code=201)
async def subir_vector(
    archivo: UploadFile = File(...),
    nombre_capa: str = Form(...),
    color: str = Form("#e63946"),
    sesion: dict = Depends(requiere_sesion),
):
    nombre = (archivo.filename or "").lower()
    if not nombre.endswith((".geojson", ".json")):
        raise HTTPException(
            status_code=400,
            detail="Se admite .geojson o .json. Desde QGIS: clic derecho en la capa > "
                   "Exportar > Guardar como > GeoJSON (EPSG:4326).")

    contenido = await archivo.read()
    if len(contenido) > MAX_BYTES:
        raise HTTPException(
            status_code=413,
            detail="Archivo mayor a 60 MB. Usa la carga por trozos, que reanuda si se corta.")

    try:
        crudo = json.loads(contenido)
    except json.JSONDecodeError as excepcion:
        raise HTTPException(status_code=400, detail=f"JSON invalido: {excepcion}") from excepcion

    capa_id, insertados, omitidos = await insertar_geojson(
        crudo, nombre_capa, color, sesion.get("autor"))
    return {"capa_id": capa_id, "insertados": insertados, "omitidos": omitidos}
