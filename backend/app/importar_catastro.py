"""Descarga las capas catastrales del servicio de origen a la copia local.

La logica sin dependencias -la lista blanca, los parametros de paginacion, el
SQL- vive en catastro.py, para poder probarla sin red ni base. Aqui queda solo
lo que habla con el mundo: httpx contra el servicio de Cali y asyncpg contra
PostGIS.

Se usa desde la linea de ordenes, dentro del contenedor de la API:

    docker exec -it geo_api python -m app.importar_catastro
    docker exec -it geo_api python -m app.importar_catastro catastro-cali-urbano-terreno
"""
import asyncio

import asyncpg
import httpx

from . import catastro, db, fuentes

_cliente = httpx.AsyncClient(
    timeout=httpx.Timeout(180.0, connect=15.0),
    headers={"User-Agent": "Geovisor SIATA (emergencia sismica)"},
    follow_redirects=True,
)


async def _pagina(url: str, campos: str, desde: int) -> list[dict]:
    """Un lote de entidades con OBJECTID mayor que `desde`."""
    respuesta = await _cliente.get(
        url + "/query", params=catastro.consulta_pagina(campos, desde))
    respuesta.raise_for_status()
    cuerpo = respuesta.json()
    # ArcGIS devuelve 200 con un cuerpo de error. Sin esto, un servicio caido
    # se veria como una capa que simplemente se acabo.
    if "error" in cuerpo:
        raise RuntimeError(f"El servicio respondio con error: {cuerpo['error']}")
    return cuerpo.get("features") or []


async def _guardar(conexion, clave: str, lote: list[dict], campos: tuple[str, ...]) -> tuple[int, int]:
    """Inserta un lote. Devuelve (insertadas, omitidas)."""
    props, geoms, omitidas = catastro.preparar(lote, campos)

    if not props:
        return 0, omitidas

    try:
        await conexion.execute(catastro.SQL_INSERTAR, clave, props, geoms)
        return len(props), omitidas
    except Exception:
        # En PostgreSQL un error aborta la transaccion entera, asi que una
        # sola geometria corrupta tumbaria el lote de 2.000. Se reintenta fila
        # a fila con savepoint para quedarse con las 1.999 buenas.
        pass

    insertadas = 0
    for p, g in zip(props, geoms):
        try:
            async with conexion.transaction():
                await conexion.execute(catastro.SQL_INSERTAR, clave, [p], [g])
            insertadas += 1
        except Exception:
            omitidas += 1
    return insertadas, omitidas


async def _limpiar(conexion, clave: str) -> None:
    """Borra la carga anterior de una capa, a trozos.

    De golpe son hasta 406.000 filas en una sola sentencia, por encima del
    command_timeout del pool. A trozos tarda lo mismo y no deja la base
    bloqueada mientras tanto, que en emergencia importa mas.
    """
    while True:
        hecho = await conexion.execute(
            "DELETE FROM catastro WHERE id = ANY(ARRAY("
            "  SELECT id FROM catastro WHERE fuente = $1 LIMIT 50000))",
            clave)
        if hecho.endswith(" 0"):
            return


async def importar(fuente: fuentes.Fuente, avisar=print, reanudar: bool = True) -> dict:
    """Descarga una capa entera y la deja en `catastro`. Repetible.

    Confirma por lotes, NO en una sola transaccion. Bajar una capa son hasta
    veinte minutos de red publica contra un servidor ajeno: una transaccion
    abierta todo ese rato bloquea el vacuum de una base que en ese momento
    esta sosteniendo la emergencia, y un corte en el minuto diecinueve tiraria
    el trabajo entero. Confirmando por lotes, un corte se reanuda por el
    OBJECTID donde se quedo.

    El precio es que, mientras carga, la capa se ve incompleta. Se asume: son
    capas que se encienden a mano y `catastro_cargas.completa` dice si lo esta.
    """
    if fuente.tipo != "catastro":
        raise ValueError(f"{fuente.clave} no es una fuente de tipo catastro")

    campos = fuente.campos
    pedidos = catastro.campos_a_pedir(campos)

    async with db.pool().acquire() as conexion:
        previa = await conexion.fetchrow(
            "SELECT entidades, omitidas, completa, ultimo_oid "
            "FROM catastro_cargas WHERE fuente = $1", fuente.clave)

        if reanudar and previa and not previa["completa"] and previa["ultimo_oid"]:
            desde = previa["ultimo_oid"]
            insertadas, omitidas = previa["entidades"], previa["omitidas"]
            avisar(f"    reanudando desde OBJECTID {desde:,} ({insertadas:,} ya cargadas)")
        else:
            avisar("    limpiando la carga anterior…")
            await _limpiar(conexion, fuente.clave)
            desde = insertadas = omitidas = 0

        await conexion.execute(
            """
            INSERT INTO catastro_cargas (fuente, entidades, omitidas, origen, completa, ultimo_oid)
            VALUES ($1, $2, $3, $4, false, $5)
            ON CONFLICT (fuente) DO UPDATE SET
              entidades = EXCLUDED.entidades, omitidas = EXCLUDED.omitidas,
              origen = EXCLUDED.origen, completa = false, ultimo_oid = EXCLUDED.ultimo_oid
            """,
            fuente.clave, insertadas, omitidas, fuente.url, desde)

        while True:
            lote = await _pagina(fuente.url, pedidos, desde)
            if not lote:
                break
            # El OBJECTID viene fuera de properties cuando se pide geojson.
            ultimos = [e.get("id") for e in lote if e.get("id") is not None]
            if not ultimos:
                raise RuntimeError(
                    "El servicio no devolvio OBJECTID; sin el no hay forma "
                    "de paginar sin saltarse filas.")

            # El lote y el avance se confirman juntos. Si se separaran, un
            # corte entre los dos dejaria filas cargadas que la reanudacion
            # volveria a pedir, y la capa acabaria con duplicados.
            async with conexion.transaction():
                puestas, fuera = await _guardar(conexion, fuente.clave, lote, campos)
                insertadas += puestas
                omitidas += fuera
                desde = max(ultimos)
                await conexion.execute(
                    "UPDATE catastro_cargas SET entidades=$2, omitidas=$3, ultimo_oid=$4 "
                    "WHERE fuente=$1",
                    fuente.clave, insertadas, omitidas, desde)

            if insertadas % (catastro.POR_PAGINA * 10) < catastro.POR_PAGINA:
                avisar(f"    {insertadas:,} cargadas…")

        # La envolvente se mide ahora, con la capa ya entera, y se guarda.
        # Es la unica pasada completa sobre la tabla en todo el proceso.
        avisar("    midiendo la envolvente…")
        await conexion.execute(
            """
            UPDATE catastro_cargas SET completa = true, cargado_en = now(),
                   bbox = (SELECT ARRAY[ST_XMin(c), ST_YMin(c), ST_XMax(c), ST_YMax(c)]
                           FROM (SELECT ST_Extent(geom) AS c FROM catastro
                                 WHERE fuente = $1) e)
            WHERE fuente = $1
            """,
            fuente.clave)

    return {"fuente": fuente.clave, "entidades": insertadas, "omitidas": omitidas}


async def cuantas() -> dict[str, dict]:
    """Que hay cargado de cada capa, para que el catalogo lo pueda decir.

    Devuelve vacio si la tabla todavia no existe, en vez de dejar que el error
    suba. deploy.sh levanta el codigo nuevo ANTES de aplicar el esquema, asi
    que hay unos segundos en cada despliegue en los que esta consulta falla; y
    quien la paga seria el catalogo de fuentes externas entero, que dejaria de
    abrirse por una tabla que solo usan seis capas.
    """
    try:
        filas = await db.pool().fetch(
            "SELECT fuente, entidades, omitidas, completa, cargado_en, bbox "
            "FROM catastro_cargas")
    except asyncpg.exceptions.UndefinedTableError:
        return {}
    return {f["fuente"]: dict(f) for f in filas}


# ---------------------------------------------------------------------------
# Uso desde la linea de ordenes
# ---------------------------------------------------------------------------
async def _principal(claves: list[str]) -> None:
    await db.iniciar()
    pendientes = [f for f in fuentes.CATALOGO
                  if f.tipo == "catastro" and (not claves or f.clave in claves)]
    if not pendientes:
        print("Ninguna capa coincide. Disponibles:")
        for f in fuentes.CATALOGO:
            if f.tipo == "catastro":
                print("   ", f.clave)
        return

    for fuente in pendientes:
        print(f"==> {fuente.nombre}")
        resultado = await importar(fuente)
        print(f"    {resultado['entidades']:,} entidades"
              + (f", {resultado['omitidas']:,} omitidas" if resultado["omitidas"] else ""))
    await db.cerrar()


if __name__ == "__main__":
    import sys
    asyncio.run(_principal(sys.argv[1:]))
