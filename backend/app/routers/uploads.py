"""Carga de capas existentes."""
import json

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile

from .. import db
from ..auth import requiere_sesion

router = APIRouter(prefix="/api", dependencies=[Depends(requiere_sesion)])

MAX_BYTES = 60 * 1024 * 1024


def _extraer_features(crudo: dict) -> list[dict]:
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
            detail="Fase 1 acepta solo .geojson o .json. Desde QGIS: "
                   "clic derecho en la capa > Exportar > Guardar como > GeoJSON (EPSG:4326).",
        )

    contenido = await archivo.read()
    if len(contenido) > MAX_BYTES:
        raise HTTPException(status_code=413, detail="Archivo mayor a 60 MB")

    try:
        crudo = json.loads(contenido)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail=f"JSON invalido: {exc}") from exc

    features = _extraer_features(crudo)
    if not features:
        raise HTTPException(status_code=400, detail="El archivo no contiene entidades")

    async with db.pool().acquire() as conexion:
        async with conexion.transaction():
            capa_id = await conexion.fetchval(
                "INSERT INTO capas (nombre, color) VALUES ($1, $2) RETURNING id",
                nombre_capa,
                color,
            )

            insertados = 0
            omitidos = 0
            for feature in features:
                geometria = feature.get("geometry")
                if not geometria:
                    omitidos += 1
                    continue
                propiedades = feature.get("properties") or {}
                # Un nombre legible ayuda al equipo a identificar el elemento;
                # se busca en las claves habituales antes de rendirse.
                etiqueta = next(
                    (str(propiedades[k]) for k in
                     ("nombre", "name", "NOMBRE", "Nombre", "titulo", "id")
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
                            etiqueta,
                            capa_id,
                            json.dumps(propiedades),
                            json.dumps(geometria),
                            sesion.get("autor"),
                        )
                    insertados += 1
                except Exception:
                    omitidos += 1

    if insertados == 0:
        raise HTTPException(
            status_code=400,
            detail="Ninguna entidad pudo cargarse. Verificar que el archivo este en EPSG:4326.",
        )

    return {"capa_id": capa_id, "insertados": insertados, "omitidos": omitidos}
