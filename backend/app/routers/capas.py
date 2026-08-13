"""Gestion de capas vectoriales: crear, renombrar, recolorear, reordenar, borrar."""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .. import db
from ..auth import requiere_sesion

router = APIRouter(prefix="/api/capas", dependencies=[Depends(requiere_sesion)])


class CapaEntrada(BaseModel):
    nombre: str
    color: str = "#e63946"


class CapaParche(BaseModel):
    nombre: str | None = None
    color: str | None = None
    visible: bool | None = None
    opacidad: float | None = Field(default=None, ge=0, le=1)
    orden: int | None = None


@router.get("")
async def listar():
    """Incluye la extension de cada capa para poder encuadrar el mapa sobre
    ella de un clic, que es lo primero que se quiere hacer al cargar un
    shapefile de un municipio que no se sabe donde cae."""
    filas = await db.pool().fetch(
        """
        SELECT c.id, c.nombre, c.color, c.visible, c.opacidad, c.orden,
               COUNT(e.id) AS total,
               CASE WHEN COUNT(e.id) > 0 THEN ARRAY[
                 ST_XMin(ST_Extent(e.geom)), ST_YMin(ST_Extent(e.geom)),
                 ST_XMax(ST_Extent(e.geom)), ST_YMax(ST_Extent(e.geom))
               ] END AS extension
        FROM capas c
        LEFT JOIN elementos e ON e.capa_id = c.id
        GROUP BY c.id
        ORDER BY c.orden NULLS LAST, c.id
        """
    )
    return [dict(f) for f in filas]


@router.post("", status_code=201)
async def crear(capa: CapaEntrada):
    fila = await db.pool().fetchrow(
        """
        INSERT INTO capas (nombre, color, orden)
        VALUES ($1, $2, COALESCE((SELECT MAX(orden) + 1 FROM capas), 1))
        RETURNING id, nombre, color, visible, opacidad, orden
        """,
        capa.nombre.strip() or "Capa sin nombre",
        capa.color,
    )
    return dict(fila)


@router.patch("/{id_capa}")
async def editar(id_capa: int, parche: CapaParche):
    fila = await db.pool().fetchrow(
        """
        UPDATE capas SET
          nombre   = COALESCE($2, nombre),
          color    = COALESCE($3, color),
          visible  = COALESCE($4, visible),
          opacidad = COALESCE($5, opacidad),
          orden    = COALESCE($6, orden)
        WHERE id = $1
        RETURNING id, nombre, color, visible, opacidad, orden
        """,
        id_capa, parche.nombre, parche.color, parche.visible, parche.opacidad, parche.orden,
    )
    if fila is None:
        raise HTTPException(status_code=404, detail="Capa no encontrada")
    return dict(fila)


@router.delete("/{id_capa}", status_code=200)
async def borrar(id_capa: int):
    """Borra la capa y, en cascada, todos sus elementos."""
    fila = await db.pool().fetchrow(
        "SELECT nombre, (SELECT COUNT(*) FROM elementos WHERE capa_id = $1) AS total "
        "FROM capas WHERE id = $1",
        id_capa,
    )
    if fila is None:
        raise HTTPException(status_code=404, detail="Capa no encontrada")
    await db.pool().execute("DELETE FROM capas WHERE id = $1", id_capa)
    return {"ok": True, "nombre": fila["nombre"], "elementos_borrados": fila["total"]}
