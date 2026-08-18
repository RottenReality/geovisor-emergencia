"""Gestion de capas vectoriales: crear, renombrar, recolorear, reordenar, borrar.

Incluye ademas la exploracion de atributos (que campos trae la capa y que
valores toma cada uno) que alimenta la simbologia y el filtro tematicos.
"""
import json

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .. import db
from ..auth import requiere_sesion

router = APIRouter(prefix="/api/capas", dependencies=[Depends(requiere_sesion)])

# Un texto cuenta como numero si es entero, decimal o notacion cientifica.
# Se aplica en SQL para no traer millones de valores al proceso solo para
# averiguar si el campo se puede clasificar por rangos.
ES_NUMERO = r"^-?[0-9]+([.][0-9]+)?([eE][-+]?[0-9]+)?$"

# Los atributos se leen con jsonb_each_text, que revienta si el JSONB no es un
# objeto. Un GeoJSON mal formado puede dejar ahi una lista o un null, asi que
# se normaliza en la propia consulta en vez de confiar en el dato.
PROPS = "CASE WHEN jsonb_typeof(e.propiedades) = 'object' THEN e.propiedades ELSE '{}'::jsonb END"


class CapaEntrada(BaseModel):
    nombre: str
    color: str = "#e63946"


# Sin `orden`: el orden lo manda la tabla `pila`, no esta. Dejarlo aqui
# aceptando escrituras dejaria dos fuentes de verdad sobre lo mismo.
class CapaParche(BaseModel):
    nombre: str | None = None
    color: str | None = None
    visible: bool | None = None
    opacidad: float | None = Field(default=None, ge=0, le=1)


class EstiloEntrada(BaseModel):
    """`estilo = None` borra la simbologia y devuelve la capa a un solo color.

    Va en su propio endpoint y no en el PATCH general precisamente por eso: con
    COALESCE no hay forma de distinguir "no toques el estilo" de "quitalo".
    """

    estilo: dict | None = None


def _sin_json(fila) -> dict:
    """Convierte la fila a dict deshaciendo el JSONB, que asyncpg trae como texto."""
    datos = dict(fila)
    if datos.get("estilo") is not None:
        datos["estilo"] = json.loads(datos["estilo"])
    return datos


@router.get("")
async def listar():
    """Incluye la extension de cada capa para poder encuadrar el mapa sobre
    ella de un clic, que es lo primero que se quiere hacer al cargar un
    shapefile de un municipio que no se sabe donde cae."""
    filas = await db.pool().fetch(
        """
        SELECT c.id, c.nombre, c.color, c.visible, c.opacidad, c.orden, c.estilo,
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
    return [_sin_json(f) for f in filas]


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


# ---------------------------------------------------------------------------
# Simbologia tematica
# ---------------------------------------------------------------------------
@router.put("/{id_capa}/estilo")
async def guardar_estilo(id_capa: int, entrada: EstiloEntrada):
    """Guarda (o borra, con estilo=null) como se pinta la capa por atributo."""
    fila = await db.pool().fetchrow(
        "UPDATE capas SET estilo = $2::jsonb WHERE id = $1 RETURNING id, estilo",
        id_capa,
        json.dumps(entrada.estilo) if entrada.estilo else None,
    )
    if fila is None:
        raise HTTPException(status_code=404, detail="Capa no encontrada")
    return _sin_json(fila)


@router.get("/{id_capa}/campos")
async def campos(id_capa: int):
    """Atributos presentes en la capa, con cuantos valores distintos toma cada uno.

    Es lo primero que hace falta para clasificar: un shapefile de manzanas trae
    treinta columnas y solo dos o tres sirven para pintar un mapa tematico. El
    conteo de distintos es lo que permite descartar de un vistazo las que son
    identificadores unicos.
    """
    filas = await db.pool().fetch(
        f"""
        SELECT p.clave AS campo,
               COUNT(*) FILTER (WHERE NULLIF(p.valor, '') IS NOT NULL)  AS con_dato,
               COUNT(DISTINCT NULLIF(p.valor, ''))                      AS distintos,
               COUNT(*) FILTER (
                 WHERE NULLIF(p.valor, '') IS NOT NULL
                   AND btrim(p.valor) !~ '{ES_NUMERO}'
               ) AS no_numericos
        FROM elementos e
        CROSS JOIN LATERAL jsonb_each_text({PROPS}) AS p(clave, valor)
        WHERE e.capa_id = $1
        GROUP BY p.clave
        ORDER BY p.clave
        """,
        id_capa,
    )
    return [
        {
            "campo": f["campo"],
            "con_dato": f["con_dato"],
            "distintos": f["distintos"],
            "numerico": f["con_dato"] > 0 and f["no_numericos"] == 0,
        }
        for f in filas
    ]


@router.get("/{id_capa}/valores")
async def valores(id_capa: int, campo: str, clases: int = 5):
    """Valores que toma un atributo, con su frecuencia, y cortes por cuantiles.

    Los cortes salen de percentile_cont y no de intervalos iguales: con datos
    de dano, que casi siempre estan sesgados hacia lo leve, los intervalos
    iguales dejan una clase con el 95% de las manzanas y cuatro casi vacias.
    Por cuantiles cada clase pesa parecido y el mapa distingue de verdad.
    """
    clases = max(2, min(9, clases))

    filas = await db.pool().fetch(
        """
        SELECT NULLIF(propiedades ->> $2, '') AS valor, COUNT(*) AS total
        FROM elementos
        WHERE capa_id = $1 AND NULLIF(propiedades ->> $2, '') IS NOT NULL
        GROUP BY 1
        ORDER BY COUNT(*) DESC, 1
        LIMIT 201
        """,
        id_capa,
        campo,
    )

    # Los totales NO se suman sobre la lista de arriba: viene recortada a 201
    # filas, y con un campo de muchos valores distintos el conteo saldria corto
    # y con el la deteccion de si el campo es numerico.
    fracciones = [i / clases for i in range(clases + 1)]
    est = await db.pool().fetchrow(
        f"""
        SELECT COUNT(t) AS con_dato,
               COUNT(*) FILTER (WHERE t IS NULL) AS sin_dato,
               COUNT(n) AS numericos,
               MIN(n) AS minimo, MAX(n) AS maximo,
               percentile_cont($3::double precision[]) WITHIN GROUP (ORDER BY n) AS cortes
        FROM (
          SELECT NULLIF(propiedades ->> $2, '') AS t,
                 CASE WHEN btrim(COALESCE(propiedades ->> $2, '')) ~ '{ES_NUMERO}'
                      THEN (btrim(propiedades ->> $2))::double precision END AS n
          FROM elementos
          WHERE capa_id = $1
        ) s
        """,
        id_capa,
        campo,
        fracciones,
    )

    # Numerico solo si TODOS los valores con dato lo son: media columna de
    # numeros y media de textos no se puede clasificar por rangos sin mentir.
    con_dato = est["con_dato"]
    numerico = con_dato > 0 and est["numericos"] == con_dato

    cortes: list[float] = []
    if numerico and est["cortes"]:
        # Los cuantiles se repiten cuando muchos elementos comparten valor
        # (media ciudad con cero danos). Clases duplicadas no aportan nada.
        for corte in est["cortes"]:
            if not cortes or corte > cortes[-1]:
                cortes.append(round(float(corte), 6))

    # Intervalos iguales como alternativa. Ninguno de los dos criterios sirve
    # siempre: con datos sesgados los cuantiles colapsan en dos clases, y con
    # datos con un valor extremo los intervalos iguales dejan cuatro vacias.
    # Se mandan los dos y que elija quien esta mirando el mapa.
    iguales: list[float] = []
    if numerico and est["minimo"] is not None and est["maximo"] > est["minimo"]:
        lo, hi = float(est["minimo"]), float(est["maximo"])
        paso = (hi - lo) / clases
        iguales = [round(lo + paso * i, 6) for i in range(clases + 1)]

    return {
        "campo": campo,
        "numerico": numerico,
        "con_dato": con_dato,
        "sin_dato": est["sin_dato"],
        "truncado": len(filas) > 200,
        "valores": [{"valor": f["valor"], "total": f["total"]} for f in filas[:200]],
        "minimo": float(est["minimo"]) if numerico and est["minimo"] is not None else None,
        "maximo": float(est["maximo"]) if numerico and est["maximo"] is not None else None,
        "cortes": cortes if len(cortes) >= 2 else [],
        "cortes_iguales": iguales,
    }


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
