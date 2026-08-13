"""Elementos vectoriales: alta, edicion, borrado y teselas vectoriales."""
import json
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, Field

from .. import db
from ..auth import requiere_sesion

router = APIRouter(prefix="/api", dependencies=[Depends(requiere_sesion)])


class ElementoEntrada(BaseModel):
    nombre: str | None = None
    capa_id: int | None = None
    propiedades: dict[str, Any] = Field(default_factory=dict)
    geometria: dict[str, Any]


class ElementoParche(BaseModel):
    nombre: str | None = None
    capa_id: int | None = None
    propiedades: dict[str, Any] | None = None
    geometria: dict[str, Any] | None = None


class CapaEntrada(BaseModel):
    nombre: str
    color: str = "#e63946"


# ---------------------------------------------------------------------------
# Capas
# ---------------------------------------------------------------------------
@router.get("/capas")
async def listar_capas():
    filas = await db.pool().fetch(
        """
        SELECT c.id, c.nombre, c.tipo, c.color, c.visible,
               COUNT(e.id) AS total
        FROM capas c
        LEFT JOIN elementos e ON e.capa_id = c.id
        GROUP BY c.id
        ORDER BY c.id
        """
    )
    return [dict(f) for f in filas]


@router.post("/capas", status_code=201)
async def crear_capa(capa: CapaEntrada):
    fila = await db.pool().fetchrow(
        "INSERT INTO capas (nombre, color) VALUES ($1, $2) RETURNING id, nombre, color, visible",
        capa.nombre,
        capa.color,
    )
    return dict(fila)


# ---------------------------------------------------------------------------
# Elementos
# ---------------------------------------------------------------------------
@router.get("/features")
async def listar_features(capa_id: int | None = None, limite: int = 5000):
    """FeatureCollection en 4326. Para dibujar en pantalla se usan las teselas;
    esto sirve para inspeccion, depuracion y descargas pequenas."""
    filas = await db.pool().fetch(
        """
        SELECT e.id, e.nombre, e.capa_id, e.autor, e.propiedades,
               e.creado_en, ST_AsGeoJSON(e.geom) AS geom
        FROM elementos e
        WHERE ($1::int IS NULL OR e.capa_id = $1)
        ORDER BY e.id DESC
        LIMIT $2
        """,
        capa_id,
        limite,
    )
    return {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "id": f["id"],
                "geometry": json.loads(f["geom"]),
                "properties": {
                    "id": f["id"],
                    "nombre": f["nombre"],
                    "capa_id": f["capa_id"],
                    "autor": f["autor"],
                    "creado_en": f["creado_en"].isoformat(),
                    **json.loads(f["propiedades"]),
                },
            }
            for f in filas
        ],
    }


@router.post("/features", status_code=201)
async def crear_feature(elemento: ElementoEntrada, sesion: dict = Depends(requiere_sesion)):
    # ST_Force2D: el GPS de los celulares agrega altitud (Z) y la columna esta
    # declarada como GEOMETRY(Geometry,4326), que rechaza geometrias 3D.
    fila = await db.pool().fetchrow(
        """
        INSERT INTO elementos (nombre, capa_id, propiedades, geom, autor)
        VALUES ($1, $2, $3::jsonb,
                ST_Force2D(ST_SetSRID(ST_GeomFromGeoJSON($4), 4326)), $5)
        RETURNING id, nombre, capa_id, autor, creado_en
        """,
        elemento.nombre,
        elemento.capa_id,
        json.dumps(elemento.propiedades),
        json.dumps(elemento.geometria),
        sesion.get("autor"),
    )
    return dict(fila)


@router.patch("/features/{id_elemento}")
async def editar_feature(id_elemento: int, parche: ElementoParche):
    fila = await db.pool().fetchrow(
        """
        UPDATE elementos SET
          nombre      = COALESCE($2, nombre),
          capa_id     = COALESCE($3, capa_id),
          propiedades = COALESCE($4::jsonb, propiedades),
          geom        = COALESCE(
                          ST_Force2D(ST_SetSRID(ST_GeomFromGeoJSON($5), 4326)),
                          geom)
        WHERE id = $1
        RETURNING id, nombre, capa_id, actualizado_en
        """,
        id_elemento,
        parche.nombre,
        parche.capa_id,
        json.dumps(parche.propiedades) if parche.propiedades is not None else None,
        json.dumps(parche.geometria) if parche.geometria is not None else None,
    )
    if fila is None:
        raise HTTPException(status_code=404, detail="Elemento no encontrado")
    return dict(fila)


@router.delete("/features/{id_elemento}", status_code=204)
async def borrar_feature(id_elemento: int):
    resultado = await db.pool().execute("DELETE FROM elementos WHERE id = $1", id_elemento)
    if resultado.endswith(" 0"):
        raise HTTPException(status_code=404, detail="Elemento no encontrado")
    return Response(status_code=204)


# ---------------------------------------------------------------------------
# Teselas vectoriales
# ---------------------------------------------------------------------------
@router.get("/tiles/{z}/{x}/{y}.pbf")
async def tesela(z: int, x: int, y: int):
    """Teselas MVT generadas en PostGIS.

    Es lo que permite que el visor aguante decenas de miles de elementos en un
    celular: el navegador solo recibe lo que cabe en pantalla, ya simplificado.
    """
    if not 0 <= z <= 22:
        raise HTTPException(status_code=400, detail="Zoom fuera de rango")

    dato = await db.pool().fetchval(
        """
        WITH b AS (
          SELECT ST_TileEnvelope($1, $2, $3) AS env
        ),
        f AS (
          SELECT e.id,
                 e.capa_id,
                 e.nombre,
                 COALESCE(c.color, '#e63946') AS color,
                 GeometryType(e.geom) AS tipo,
                 ST_AsMVTGeom(ST_Transform(e.geom, 3857), b.env, 4096, 64, true) AS geom
          FROM elementos e
          CROSS JOIN b
          LEFT JOIN capas c ON c.id = e.capa_id
          WHERE c.visible IS NOT FALSE
            AND e.geom && ST_Transform(b.env, 4326)
        )
        SELECT ST_AsMVT(f, 'elementos', 4096, 'geom')
        FROM f WHERE geom IS NOT NULL
        """,
        z,
        x,
        y,
    )
    return Response(
        content=bytes(dato or b""),
        media_type="application/vnd.mapbox-vector-tile",
        # Sin cache: en emergencia un dato de hace 5 minutos ya es viejo.
        headers={"Cache-Control": "no-store"},
    )
