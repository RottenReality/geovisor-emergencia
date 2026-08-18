"""Pila de capas: orden compartido y grupos.

La pila es la unica fuente de verdad de que va encima de que. capas.orden y
rasters.orden quedan solo como semilla del primer arranque.

Se autorrepara en cada lectura en vez de exigir un script de migracion: toda
capa o raster sin sitio recibe uno, y toda fila que apunte a algo que ya no
existe se va. Asi el despliegue no tiene un paso manual que se pueda olvidar.
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from .. import db, fuentes, pila
from ..auth import requiere_sesion

router = APIRouter(prefix="/api/pila", dependencies=[Depends(requiere_sesion)])


class Movimiento(BaseModel):
    clave: str
    direccion: str


class Agrupacion(BaseModel):
    clave: str
    grupo_id: int | None = None


async def _filas(conexion) -> list[dict]:
    return [dict(f) for f in await conexion.fetch(
        "SELECT clave, grupo_id, orden FROM pila")]


async def materializar() -> list[dict]:
    """Deja la pila coherente con lo que existe y la devuelve.

    Idempotente: si no falta ni sobra nada, no escribe.
    """
    async with db.pool().acquire() as conexion:
        async with conexion.transaction():
            existentes = {f["clave"] for f in await _filas(conexion)}

            claves_capas = [f"capa-{f['id']}" for f in await conexion.fetch(
                "SELECT id FROM capas ORDER BY orden NULLS LAST, id")]
            claves_rasters = [f"raster-{f['id']}" for f in await conexion.fetch(
                "SELECT id FROM rasters ORDER BY orden NULLS LAST, id")]
            vivas = set(claves_capas) | set(claves_rasters)

            # Sobrantes: capas y rasters borrados, y fuentes externas que el
            # catalogo ya no ofrece. Los grupos no caducan solos.
            sobran = [
                c for c in existentes
                if not c.startswith("grupo-")
                and (c[len("ext-"):] not in fuentes.POR_CLAVE if c.startswith("ext-")
                     else c not in vivas)
            ]
            if sobran:
                await conexion.execute(
                    "DELETE FROM pila WHERE clave = ANY($1::text[])", sobran)
                existentes -= set(sobran)

            faltan_rasters = [c for c in claves_rasters if c not in existentes]
            faltan_capas = [c for c in claves_capas if c not in existentes]

            if faltan_rasters or faltan_capas:
                if existentes:
                    # Ya hay pila: lo nuevo se coloca sin tocar lo demas. La
                    # imagen entra por abajo -es fondo- y el dibujo por arriba,
                    # que es donde se acaba de crear para dibujar en el.
                    limites = await conexion.fetchrow(
                        "SELECT MIN(orden) AS suelo, MAX(orden) AS techo "
                        "FROM pila WHERE grupo_id IS NULL")
                    suelo = limites["suelo"] or 0
                    techo = limites["techo"] or 0
                    nuevas = [
                        *[{"clave": c, "grupo_id": None,
                           "orden": suelo - (i + 1) * pila.PASO}
                          for i, c in enumerate(faltan_rasters)],
                        *[{"clave": c, "grupo_id": None,
                           "orden": techo + (i + 1) * pila.PASO}
                          for i, c in enumerate(faltan_capas)],
                    ]
                else:
                    # Primer arranque: se siembra reproduciendo la disposicion
                    # fija que tenia el visor, imagenes debajo del dibujo.
                    nuevas = pila.sembrar(faltan_rasters, faltan_capas)

                await conexion.executemany(
                    "INSERT INTO pila (clave, grupo_id, orden) VALUES ($1, $2, $3) "
                    "ON CONFLICT (clave) DO NOTHING",
                    [(f["clave"], f["grupo_id"], f["orden"]) for f in nuevas])

            return await _filas(conexion)


@router.get("")
async def leer():
    entradas = await materializar()
    grupos = await db.pool().fetch("SELECT id, nombre, color FROM grupos ORDER BY id")
    return {"grupos": [dict(g) for g in grupos], "entradas": entradas}


@router.post("/mover")
async def mover(datos: Movimiento):
    """Intercambia el sitio con el hermano vecino.

    Solo entre hermanos: mover nunca saca una capa de su grupo. En el borde
    de su contenedor no hace nada y el panel ya deshabilita el boton.
    """
    if datos.direccion not in ("subir", "bajar"):
        raise HTTPException(status_code=400, detail="direccion debe ser subir o bajar")

    entradas = await materializar()
    otra = pila.vecino(entradas, datos.clave, datos.direccion)
    if otra is None:
        return {"ok": True, "movido": False}

    por_clave = {f["clave"]: f for f in entradas}
    async with db.pool().acquire() as conexion:
        async with conexion.transaction():
            await conexion.execute("UPDATE pila SET orden=$2 WHERE clave=$1",
                                   datos.clave, por_clave[otra]["orden"])
            await conexion.execute("UPDATE pila SET orden=$2 WHERE clave=$1",
                                   otra, por_clave[datos.clave]["orden"])
    return {"ok": True, "movido": True}


@router.post("/agrupar")
async def agrupar(datos: Agrupacion):
    """Mete una capa en un grupo, o la saca si grupo_id es null.

    Entra al frente de su nuevo contenedor: se acaba de mover ahi a proposito
    y esconderla al fondo obligaria a buscarla.
    """
    if pila.es_grupo(datos.clave):
        raise HTTPException(status_code=400, detail="Un grupo no puede entrar en otro")

    entradas = await materializar()
    if not any(f["clave"] == datos.clave for f in entradas):
        raise HTTPException(status_code=404, detail="Esa capa no esta en la pila")

    if datos.grupo_id is not None:
        existe = await db.pool().fetchval(
            "SELECT 1 FROM grupos WHERE id=$1", datos.grupo_id)
        if not existe:
            raise HTTPException(status_code=404, detail="No existe ese grupo")

    hermanos = [f["orden"] for f in entradas
                if f["grupo_id"] == datos.grupo_id and f["clave"] != datos.clave]
    await db.pool().execute(
        "UPDATE pila SET grupo_id=$2, orden=$3 WHERE clave=$1",
        datos.clave, datos.grupo_id, (max(hermanos) if hermanos else 0) + pila.PASO)
    return {"ok": True}


# ---------------------------------------------------------------------------
# Grupos
# ---------------------------------------------------------------------------
# Router aparte por el prefijo, pero vive en este archivo: un grupo no es nada
# sin la pila -es una entrada mas de ella- y separarlos obligaria a leer dos
# archivos para entender uno.
grupos_router = APIRouter(prefix="/api/grupos", dependencies=[Depends(requiere_sesion)])


class GrupoEntrada(BaseModel):
    nombre: str
    color: str = "#8d99ae"


class GrupoParche(BaseModel):
    nombre: str | None = None
    color: str | None = None


@grupos_router.post("", status_code=201)
async def crear_grupo(datos: GrupoEntrada):
    """El grupo nuevo entra al frente del nivel superior, para verlo sin buscarlo."""
    entradas = await materializar()
    techo = max([f["orden"] for f in entradas if f["grupo_id"] is None], default=0)

    async with db.pool().acquire() as conexion:
        async with conexion.transaction():
            fila = await conexion.fetchrow(
                "INSERT INTO grupos (nombre, color) VALUES ($1, $2) "
                "RETURNING id, nombre, color",
                datos.nombre.strip() or "Grupo sin nombre", datos.color)
            await conexion.execute(
                "INSERT INTO pila (clave, grupo_id, orden) VALUES ($1, NULL, $2)",
                f"grupo-{fila['id']}", techo + pila.PASO)
    return dict(fila)


@grupos_router.patch("/{id_grupo}")
async def editar_grupo(id_grupo: int, parche: GrupoParche):
    fila = await db.pool().fetchrow(
        "UPDATE grupos SET nombre=COALESCE($2, nombre), color=COALESCE($3, color) "
        "WHERE id=$1 RETURNING id, nombre, color",
        id_grupo, parche.nombre.strip() if parche.nombre else None, parche.color)
    if fila is None:
        raise HTTPException(status_code=404, detail="No existe ese grupo")
    return dict(fila)


@grupos_router.delete("/{id_grupo}")
async def disolver_grupo(id_grupo: int):
    """Disuelve el grupo. Sus capas NO se borran.

    Quedan sueltas en el sitio donde estaba el grupo y conservando su orden
    relativo: quien disuelve espera recuperar sus capas donde estaban, no
    repartidas por todo el monton.
    """
    clave_grupo = f"grupo-{id_grupo}"
    async with db.pool().acquire() as conexion:
        async with conexion.transaction():
            sitio = await conexion.fetchval(
                "SELECT orden FROM pila WHERE clave=$1", clave_grupo)
            if sitio is None:
                raise HTTPException(status_code=404, detail="No existe ese grupo")

            hijos = await conexion.fetch(
                "SELECT clave FROM pila WHERE grupo_id=$1 ORDER BY orden, clave",
                id_grupo)
            # Se reparten en el hueco que deja el grupo, por debajo del
            # siguiente vecino, para no alterar el orden de lo que hay alrededor.
            siguiente = await conexion.fetchval(
                "SELECT MIN(orden) FROM pila WHERE grupo_id IS NULL AND orden > $1",
                sitio)
            techo = (siguiente if siguiente is not None
                     else sitio + pila.PASO * (len(hijos) + 1))
            hueco = (techo - sitio) / (len(hijos) + 1) if hijos else 0

            for i, hijo in enumerate(hijos):
                await conexion.execute(
                    "UPDATE pila SET grupo_id=NULL, orden=$2 WHERE clave=$1",
                    hijo["clave"], int(sitio + hueco * (i + 1)))

            await conexion.execute("DELETE FROM pila WHERE clave=$1", clave_grupo)
            await conexion.execute("DELETE FROM grupos WHERE id=$1", id_grupo)
    return {"ok": True, "sueltas": len(hijos)}
