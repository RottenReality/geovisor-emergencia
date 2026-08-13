"""Exportacion de datos.

Dos salidas distintas y ambas necesarias:

- EPSG:4326  -> GeoJSON estandar, para intercambio y herramientas web.
- EPSG:9377  -> MAGNA-SIRGAS / Origen-Nacional, la proyeccion oficial de
                Colombia (Resolucion 471 de 2020 del IGAC). Coordenadas en
                metros y area/longitud calculadas en PostGIS sobre esa
                proyeccion, que es lo exigible en un informe oficial.
"""
import json
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Response

from .. import db
from ..auth import requiere_sesion
from ..config import SRID_OFICIAL_CO

router = APIRouter(prefix="/api/export", dependencies=[Depends(requiere_sesion)])


@router.get("/geojson")
async def exportar_geojson(srid: int = 4326, capa_id: int | None = None):
    if srid not in (4326, SRID_OFICIAL_CO):
        raise HTTPException(
            status_code=400,
            detail=f"srid debe ser 4326 o {SRID_OFICIAL_CO}",
        )

    filas = await db.pool().fetch(
        """
        SELECT v.id, v.nombre, v.capa, v.capa_id, v.autor, v.propiedades,
               v.creado_en, v.tipo_geometria,
               v.longitud_m, v.area_m2, v.perimetro_m,
               ST_AsGeoJSON(
                 CASE WHEN $1::int = 4326
                      THEN ST_Transform(v.geom_9377, 4326)
                      ELSE v.geom_9377 END,
                 9) AS geom
        FROM v_elementos_oficial_co v
        WHERE ($2::int IS NULL OR v.capa_id = $2)
        ORDER BY v.capa_id, v.id
        """,
        srid,
        capa_id,
    )

    features = []
    for f in filas:
        propiedades = {
            "id": f["id"],
            "nombre": f["nombre"],
            "capa": f["capa"],
            "autor": f["autor"],
            "creado_en": f["creado_en"].isoformat(),
            "tipo_geometria": f["tipo_geometria"],
            **json.loads(f["propiedades"]),
        }
        # Las medidas metricas solo tienen sentido en la salida oficial.
        if srid == SRID_OFICIAL_CO:
            propiedades["longitud_m"] = float(f["longitud_m"] or 0)
            propiedades["area_m2"] = float(f["area_m2"] or 0)
            propiedades["perimetro_m"] = float(f["perimetro_m"] or 0)
        features.append(
            {
                "type": "Feature",
                "id": f["id"],
                "geometry": json.loads(f["geom"]),
                "properties": propiedades,
            }
        )

    coleccion: dict = {"type": "FeatureCollection", "features": features}

    if srid == SRID_OFICIAL_CO:
        # RFC 7946 fija 4326 y elimino el miembro "crs", pero para entrega
        # oficial se necesitan las coordenadas proyectadas. Se declara el CRS
        # con la convencion anterior, que QGIS y ArcGIS siguen leyendo.
        coleccion["crs"] = {
            "type": "name",
            "properties": {"name": f"urn:ogc:def:crs:EPSG::{SRID_OFICIAL_CO}"},
        }
        nombre_archivo = f"geovisor-oficial-co-9377-{datetime.now():%Y%m%d-%H%M}.geojson"
    else:
        nombre_archivo = f"geovisor-wgs84-{datetime.now():%Y%m%d-%H%M}.geojson"

    return Response(
        content=json.dumps(coleccion, ensure_ascii=False),
        media_type="application/geo+json",
        headers={"Content-Disposition": f'attachment; filename="{nombre_archivo}"'},
    )
