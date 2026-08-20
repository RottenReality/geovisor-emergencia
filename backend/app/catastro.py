"""Copia local de las capas catastrales, para servirlas como teselas propias.

Por que no se consultan en vivo como el resto del catalogo
----------------------------------------------------------
El mecanismo de fuentes externas descarga la capa entera, la recorta y la
guarda en memoria unos minutos. Funciona porque ninguna de esas fuentes pasa
de unos pocos miles de elementos.

El catastro de Cali son 1.504.335 poligonos entre seis capas. Medido sobre el
servicio, una pantalla de 1920x1080 sobre el centro de Cali contiene:

    zoom 15 (ciudad)        577.754 poligonos de las tres capas urbanas
    zoom 16 (barrio)        180.350
    zoom 17 (unas manzanas)  55.750
    zoom 18 (UNA manzana)    17.256

Ni siquiera mirando una sola manzana entra en el tope de 8.000 entidades. No
es cuestion de subir el tope: traer geometria cruda por pantalla no escala a
datos catastrales, y por eso el catastro se sirve en teselas en todas partes.

Que se hace en su lugar
-----------------------
Se copia una vez a PostGIS (tabla `catastro`) y se sirve con ST_AsMVT, igual
que las capas que dibuja el equipo. Eso da tres cosas: el navegador solo baja
lo que se ve, el peso por tesela es acotado, y el visor deja de depender de
que el servicio de Cali este en pie durante la emergencia.

La copia no se desactualiza porque el origen es una foto fija: las seis capas
comparten el mismo EditDate maximo -15 de agosto de 2026, con 21 segundos de
diferencia entre ellas-, que es la firma de una carga masiva unica, no de una
capa que se este editando. Si algun dia vuelven a cargarla, se reimporta.
"""
import json

# Tope del servicio. Pedir mas no trae mas: ArcGIS recorta en silencio, que es
# justo la forma de perder datos sin enterarse.
POR_PAGINA = 2000

# 7 decimales son ~1,1 cm. Sobra para dibujar, pero el uso previsto incluye
# soporte a reclamaciones de seguros, y ahi recortar la geometria del lindero
# es exactamente lo que no conviene. A 6 decimales la descarga baja un 30%;
# no vale la pena a cambio de degradar el dato de origen.
PRECISION = 7


def consulta_pagina(campos: str, desde: int) -> dict:
    """Parametros de una peticion de pagina al servicio.

    Se pagina por OBJECTID y NO por resultOffset. Con offset, ArcGIS tiene que
    recorrer y descartar todo lo anterior en cada peticion, asi que la pagina
    750 tarda muchisimo mas que la primera; y si el servicio reordena entre dos
    peticiones -pasa cuando hay ediciones- se saltan o se repiten filas sin que
    nada lo delate. Con un OBJECTID creciente cada peticion es independiente,
    cuesta lo mismo, y una importacion cortada se reanuda donde iba.
    """
    return {
        "where": f"OBJECTID>{desde}",
        "outFields": campos,
        "orderByFields": "OBJECTID",
        "resultRecordCount": POR_PAGINA,
        "returnExceededLimitFeatures": "true",
        "outSR": 4326,
        "geometryPrecision": PRECISION,
        "f": "geojson",
    }


def campos_a_pedir(campos: tuple[str, ...]) -> str:
    """OBJECTID por delante: no se guarda -no esta en la lista blanca- pero
    es lo que ordena y pagina la descarga."""
    return ",".join(("OBJECTID", *campos))


SQL_INSERTAR = """
INSERT INTO catastro (fuente, props, geom)
SELECT $1, p::jsonb,
       -- ST_MakeValid solo sobre lo que hace falta: el catastro trae
       -- poligonos que se auto-intersectan, y ST_AsMVTGeom los descarta
       -- devolviendo NULL. Repararlos al importar cuesta una vez; hacerlo
       -- en la consulta de tesela lo costaria en cada peticion.
       CASE WHEN ST_IsValid(g.geom) THEN g.geom ELSE ST_MakeValid(g.geom) END
FROM unnest($2::text[], $3::text[]) AS t(p, j),
     LATERAL (SELECT ST_Force2D(ST_SetSRID(ST_GeomFromGeoJSON(j), 4326)) AS geom) g
"""

def preparar(lote: list[dict], campos: tuple[str, ...]) -> tuple[list[str], list[str], int]:
    """Separa un lote en (props, geometrias, omitidas), ya como texto JSON.

    Aparte de _guardar para poder probarla sin base ni red: es donde se aplica
    la lista blanca, y equivocarse ahi significa publicar campos que no deben
    salir o perder los que si.
    """
    props, geoms = [], []
    omitidas = 0
    for entidad in lote:
        geometria = entidad.get("geometry")
        if not geometria:
            # Un predio sin geometria no se puede dibujar ni ubicar. Se cuenta
            # para que el informe de la carga no cuadre por casualidad.
            omitidas += 1
            continue
        crudas = entidad.get("properties") or {}
        # Lista blanca, con el mismo criterio que las fuentes en vivo: vacia
        # quiere decir "todos los campos". Fuera quedan los GUID internos, los
        # nombres de usuario de quien edito y Shape__Area, que no aportan nada
        # al visor y engordan cada tesela.
        limpias = {k: v for k, v in crudas.items() if k in campos} if campos else dict(crudas)
        props.append(json.dumps(limpias, ensure_ascii=False))
        geoms.append(json.dumps(geometria))
    return props, geoms, omitidas
