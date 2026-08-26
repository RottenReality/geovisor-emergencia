"""Elementos vectoriales: alta, consulta, edicion, borrado y teselas."""
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
    # Solo lo manda quien dibuja sobre un modelo 3D. Es la MISMA marca que
    # `geometria` pero con la altura de cada vertice, tomada de la superficie
    # de la malla. Ver el comentario de geom_3d en db/init.sql.
    geometria_3d: dict[str, Any] | None = None


class ElementoParche(BaseModel):
    nombre: str | None = None
    capa_id: int | None = None
    propiedades: dict[str, Any] | None = None
    geometria: dict[str, Any] | None = None
    geometria_3d: dict[str, Any] | None = None


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


@router.get("/features/anotaciones-3d")
async def anotaciones_3d(limite: int = 2000):
    """Las marcas que se dibujaron sobre un modelo 3D, con su altura.

    Van por su propio endpoint y no dentro de /features porque el 99% de los
    elementos no tienen 3D y mandar la columna vacia en cada respuesta seria
    engordar la lista general para nada. Aqui se piden una vez al encender el
    modelo y se vuelven a pedir al guardar una marca nueva.

    Se devuelve la longitud ya calculada: el navegador no puede sacarla bien
    solo, porque sumar distancias en grados no da metros.
    """
    filas = await db.pool().fetch(
        """
        SELECT e.id, e.nombre, e.capa_id, e.autor, e.propiedades,
               c.color AS color,
               ST_AsGeoJSON(e.geom_3d) AS geom,
               ST_3DLength(ST_Transform(e.geom_3d, 9377)) AS longitud_3d
        FROM elementos e
        LEFT JOIN capas c ON c.id = e.capa_id
        WHERE e.geom_3d IS NOT NULL
        ORDER BY e.id DESC
        LIMIT $1
        """,
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
                    "color": f["color"],
                    "longitud_3d_m": round(float(f["longitud_3d"] or 0), 2),
                    **json.loads(f["propiedades"]),
                },
            }
            for f in filas
        ],
    }


@router.get("/features/{id_elemento}")
async def detalle_feature(id_elemento: int):
    """Ficha completa de un elemento, con las medidas oficiales en 9377.

    Los atributos NO viajan dentro de las teselas: hacerlo las engordaria y en
    campo el ancho de banda es el recurso escaso. Se piden solo al seleccionar.
    """
    fila = await db.pool().fetchrow(
        """
        SELECT v.id, v.nombre, v.capa, v.capa_id, v.autor, v.propiedades,
               v.creado_en, v.tipo_geometria,
               v.longitud_m, v.area_m2, v.perimetro_m,
               ST_AsGeoJSON(ST_Transform(v.geom_9377, 4326)) AS geom,
               ARRAY[ST_XMin(v.geom_9377), ST_YMin(v.geom_9377),
                     ST_XMax(v.geom_9377), ST_YMax(v.geom_9377)] AS caja_9377,
               -- La longitud en planta de una grieta vertical es casi cero.
               -- Cuando hay marca 3D, esta es la que vale.
               (SELECT ST_3DLength(ST_Transform(e.geom_3d, 9377))
                FROM elementos e WHERE e.id = v.id) AS longitud_3d
        FROM v_elementos_oficial_co v
        WHERE v.id = $1
        """,
        id_elemento,
    )
    if fila is None:
        raise HTTPException(status_code=404, detail="Elemento no encontrado")

    return {
        "id": fila["id"],
        "nombre": fila["nombre"],
        "capa": fila["capa"],
        "capa_id": fila["capa_id"],
        "autor": fila["autor"],
        "creado_en": fila["creado_en"].isoformat(),
        "tipo_geometria": fila["tipo_geometria"],
        "medidas": {
            "longitud_m": float(fila["longitud_m"] or 0),
            "area_m2": float(fila["area_m2"] or 0),
            "perimetro_m": float(fila["perimetro_m"] or 0),
            # None cuando el elemento no se dibujo sobre un modelo 3D, que es
            # lo normal. La ficha solo la ensena si viene.
            "longitud_3d_m": (float(fila["longitud_3d"])
                              if fila["longitud_3d"] is not None else None),
        },
        "propiedades": json.loads(fila["propiedades"]),
        "geometria": json.loads(fila["geom"]),
    }


@router.post("/features", status_code=201)
async def crear_feature(elemento: ElementoEntrada, sesion: dict = Depends(requiere_sesion)):
    # ST_Force2D: el GPS de los celulares agrega altitud (Z) y la columna esta
    # declarada como GEOMETRY(Geometry,4326), que rechaza geometrias 3D.
    fila = await db.pool().fetchrow(
        """
        INSERT INTO elementos (nombre, capa_id, propiedades, geom, geom_3d, autor)
        VALUES ($1, $2, $3::jsonb,
                ST_Force2D(ST_SetSRID(ST_GeomFromGeoJSON($4), 4326)),
                -- ST_Force3D y no a pelo: si a un vertice le faltase la Z, la
                -- columna GeometryZ rechazaria la fila entera y se perderia
                -- la anotacion. Mejor un cero que un 500 en campo.
                CASE WHEN $5::text IS NULL THEN NULL
                     ELSE ST_Force3D(ST_SetSRID(ST_GeomFromGeoJSON($5), 4326)) END,
                $6)
        RETURNING id, nombre, capa_id, autor, creado_en
        """,
        elemento.nombre,
        elemento.capa_id,
        json.dumps(elemento.propiedades),
        json.dumps(elemento.geometria),
        json.dumps(elemento.geometria_3d) if elemento.geometria_3d is not None else None,
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
                          geom),
          geom_3d     = COALESCE(
                          ST_Force3D(ST_SetSRID(ST_GeomFromGeoJSON($6), 4326)),
                          geom_3d)
        WHERE id = $1
        RETURNING id, nombre, capa_id, actualizado_en
        """,
        id_elemento,
        parche.nombre,
        parche.capa_id,
        json.dumps(parche.propiedades) if parche.propiedades is not None else None,
        json.dumps(parche.geometria) if parche.geometria is not None else None,
        json.dumps(parche.geometria_3d) if parche.geometria_3d is not None else None,
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


@router.get("/tiles/{z}/{x}/{y}.pbf")
async def tesela(z: int, x: int, y: int):
    """Teselas MVT generadas en PostGIS.

    Llevan lo minimo para dibujar y seleccionar: id, capa y, si la capa tiene
    simbologia tematica, el valor del unico atributo por el que se clasifica.
    El resto de atributos se consulta aparte, al abrir la ficha.

    El color NO viaja aqui. Se aplica en el navegador a partir de la capa, que
    ya se conoce: si viniera cocido en la tesela, recolorear una capa obligaria
    a volver a descargarlas todas y hasta entonces el mapa seguiria mostrando
    el color viejo.
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
                 NULLIF(e.propiedades ->> (c.estilo ->> 'campo'), '') AS valor,
                 ST_AsMVTGeom(ST_Transform(e.geom, 3857), b.env, 4096, 64, true) AS geom
          FROM elementos e
          CROSS JOIN b
          LEFT JOIN capas c ON c.id = e.capa_id
          WHERE e.geom && ST_Transform(b.env, 4326)
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
