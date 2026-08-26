"""Fuentes externas: se consultan en vivo y se sirven ya normalizadas.

El navegador solo conoce claves del catalogo (fuentes.py). Este modulo resuelve
la direccion real, descarga, recorta los atributos a la lista blanca, convierte
a GeoJSON y guarda el resultado unos minutos en memoria.

Por que pasar por el servidor y no llamar a cada API desde el navegador:

  1. La mitad de estos servicios no manda CORS (IGAC, GDACS, Predioz, INVIAS).
     Desde la pagina simplemente fallarian.
  2. La cache es compartida: si cinco personas del equipo encienden la misma
     capa, la fuente recibe una sola peticion, no cinco. En emergencia esos
     servidores estan cargados y conviene no ser parte del problema.
  3. Aqui es donde se recortan los datos personales antes de que salgan.
  4. El equipo en campo tiene una conexion; el servidor tiene otra. Que la
     descarga pesada la haga el servidor es lo que hace usable el visor en un
     celular con senal mala.
"""
import asyncio
import io
import json
import math
import os
import time
import zipfile

import asyncpg
import httpx
from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, Field

from .. import config, db, fuentes, importar_catastro, modelos3d, visitados
from ..fechas import legible as fecha_legible
from .. import pila as pila_logica
from ..auth import requiere_sesion
from .pila import materializar
from .rasters import Importacion, _correr, importar as importar_raster
from .uploads import insertar_geojson

router = APIRouter(prefix="/api/externas", dependencies=[Depends(requiere_sesion)])

# Timeout generoso: son servidores publicos bajo carga durante la emergencia.
# connect corto para no quedarse colgado cuando uno esta caido del todo.
_cliente = httpx.AsyncClient(
    timeout=httpx.Timeout(60.0, connect=8.0),
    headers={"User-Agent": "Geovisor SIATA (emergencia sismica)"},
    follow_redirects=True,
)

# Tope de entidades por fuente. Ninguna del catalogo se acerca (la mayor son
# 2.936 sedes del REPS); esta para que una fuente que crezca sin control no se
# lleve por delante la RAM de la VPS.
MAX_ENTIDADES = 8000

# ---------------------------------------------------------------------------
# Cache en memoria
# ---------------------------------------------------------------------------
# {clave: (momento, bytes_geojson, n_entidades)}. Se guarda ya serializado:
# lo que se pide una y otra vez es el mismo cuerpo, y volver a codificarlo en
# cada peticion no aporta nada.
_cache: dict[str, tuple[float, bytes, int]] = {}
_candados: dict[str, asyncio.Lock] = {}

# Techo total de la cache. Con todo el catalogo encendido no llega ni a 10 MB;
# el limite existe para que un dia raro no acabe en OOM.
MAX_CACHE_BYTES = 48 * 1024 * 1024


def _hacer_sitio(entrantes: int) -> None:
    """Deja hueco tirando primero lo mas viejo."""
    total = sum(len(b) for _, b, _ in _cache.values()) + entrantes
    if total <= MAX_CACHE_BYTES:
        return
    for clave in sorted(_cache, key=lambda c: _cache[c][0]):
        total -= len(_cache[clave][1])
        del _cache[clave]
        if total <= MAX_CACHE_BYTES:
            return


def _fresco(fuente: fuentes.Fuente) -> tuple[bytes, int] | None:
    guardado = _cache.get(fuente.clave)
    if guardado is None:
        return None
    momento, cuerpo, cuantas = guardado
    if time.time() - momento > fuente.minutos * 60:
        return None
    return cuerpo, cuantas


# ---------------------------------------------------------------------------
# Utilidades
# ---------------------------------------------------------------------------
def _hondo(objeto, ruta: str):
    """Lee 'coordenadas.latitud' dentro de un dict anidado."""
    for parte in ruta.split("."):
        if not isinstance(objeto, dict):
            return None
        objeto = objeto.get(parte)
    return objeto


def _recortar(propiedades: dict, fuente: fuentes.Fuente) -> dict:
    """Deja solo la lista blanca, hace legibles las fechas y absolutiza enlaces."""
    if fuente.campos:
        propiedades = {k: v for k, v in propiedades.items() if k in fuente.campos}
    for campo in fuente.fechas:
        # Solo se sustituye si la conversion sale: asi un registro con basura
        # en ese campo conserva lo que traia en vez de quedarse vacio, y una
        # fuente que ya mande la fecha hecha no se pisa.
        convertida = fecha_legible(propiedades.get(campo))
        if convertida:
            propiedades[campo] = convertida
    for campo, base in fuente.enlaces.items():
        valor = propiedades.get(campo)
        if isinstance(valor, str) and valor:
            propiedades[campo] = base + valor.lstrip("./")
    return propiedades


# Registros que la fuente trae pero que no se pueden dibujar por no tener
# posicion. Hay que decirlo: en el registro agregado son dos de cada tres, y
# creer que el mapa los muestra todos es leer mal el alcance del dato.
_sin_ubicacion: dict[str, int] = {}


def _coleccion(features: list[dict], fuente: fuentes.Fuente) -> dict:
    limpias = []
    fuera = 0
    for elemento in features:
        if not elemento.get("geometry"):
            fuera += 1
            continue
        limpias.append({
            "type": "Feature",
            "geometry": elemento["geometry"],
            "properties": _recortar(elemento.get("properties") or {}, fuente),
        })
        if len(limpias) >= MAX_ENTIDADES:
            break
    _sin_ubicacion[fuente.clave] = fuera
    # 'sin_ubicacion' es un miembro extra, permitido por GeoJSON: MapLibre lo
    # ignora y el visor lo usa para avisar en el acto de cuantos registros de
    # la fuente se quedaron fuera del mapa.
    return {"type": "FeatureCollection", "sin_ubicacion": fuera, "features": limpias}


async def _json(url: str, parametros: dict | None = None, timeout: float = 60.0) -> dict:
    respuesta = await _cliente.get(url, params=parametros, timeout=timeout)
    respuesta.raise_for_status()
    return respuesta.json()


# ---------------------------------------------------------------------------
# Descarga segun el tipo de fuente
# ---------------------------------------------------------------------------
_meta_arcgis: dict[str, dict] = {}


async def _metadatos(url: str) -> dict:
    """Ficha del servicio. No cambia durante la emergencia: se guarda entera."""
    if url not in _meta_arcgis:
        _meta_arcgis[url] = await _json(url, {"f": "json"})
    return _meta_arcgis[url]


async def _de_arcgis(fuente: fuentes.Fuente) -> dict:
    """FeatureServer -> GeoJSON, paginando.

    ArcGIS corta en maxRecordCount (2.000 en estos servicios) y no avisa de
    forma fiable, asi que se pide por paginas hasta que devuelve menos de lo
    pedido. El orden por el campo de identificador es lo que hace que las
    paginas no se solapen ni dejen huecos.
    """
    meta = await _metadatos(fuente.url)
    tamano = min(int(meta.get("maxRecordCount") or 1000), 2000)
    oid = meta.get("objectIdField") or "OBJECTID"

    features: list[dict] = []
    desplazamiento = 0
    while len(features) < MAX_ENTIDADES:
        consulta = {
            "where": "1=1",
            "outFields": ",".join(fuente.campos) if fuente.campos else "*",
            "returnGeometry": "true",
            "outSR": 4326,
            # Seis decimales son once centimetros. Lo que traen por defecto son
            # quince digitos de precision inventada que solo engordan el envio.
            "geometryPrecision": 6,
            "orderByFields": oid,
            "resultOffset": desplazamiento,
            "resultRecordCount": tamano,
            "f": "geojson",
        }
        if fuente.tolerancia:
            consulta["maxAllowableOffset"] = fuente.tolerancia
        pagina = await _json(fuente.url + "/query", consulta)
        if pagina.get("error"):
            raise RuntimeError(str(pagina["error"])[:200])
        trozo = pagina.get("features") or []
        features.extend(trozo)
        if len(trozo) < tamano:
            break
        desplazamiento += tamano

    return _coleccion(features, fuente)


async def _de_geojson(fuente: fuentes.Fuente) -> dict:
    crudo = await _json(fuente.url)
    return _coleccion(crudo.get("features") or [], fuente)


async def _de_lista(fuente: fuentes.Fuente) -> dict:
    """JSON con un arreglo de objetos que llevan latitud y longitud sueltas."""
    crudo = await _json(fuente.url, timeout=120.0)
    filas = _hondo(crudo, fuente.lista) if fuente.lista else crudo
    if not isinstance(filas, list):
        raise RuntimeError(f"No se encontro el arreglo {fuente.lista!r}")

    # Los que no traen posicion se dejan pasar sin geometria a proposito:
    # _coleccion los descarta y de paso los cuenta, que es lo que permite
    # decirle al equipo cuantos registros de la fuente no estan en el mapa.
    features = []
    for fila in filas:
        lat, lon = _hondo(fila, fuente.lat), _hondo(fila, fuente.lon)
        ubicado = isinstance(lat, (int, float)) and isinstance(lon, (int, float))
        features.append({
            "geometry": {"type": "Point", "coordinates": [lon, lat]} if ubicado else None,
            "properties": fila,
        })
    return _coleccion(features, fuente)


async def _de_gdacs(fuente: fuentes.Fuente) -> dict:
    """GDACS devuelve un Feature suelto, no una coleccion."""
    crudo = await _json(fuente.url)
    propiedades = crudo.get("properties") or {}
    return {
        "type": "FeatureCollection",
        "features": [{
            "type": "Feature",
            "geometry": crudo.get("geometry"),
            "properties": {
                "name": propiedades.get("name"),
                "magnitud": propiedades.get("severitydata", {}).get("severity"),
                "descripcion": propiedades.get("htmldescription"),
                "fecha": propiedades.get("fromdate"),
                "pais": propiedades.get("country"),
                "alerta": propiedades.get("alertlevel"),
            },
        }] if crudo.get("geometry") else [],
    }


async def _de_visitados(fuente: fuentes.Fuente) -> dict:
    """API autenticada de la Alcaldia de Cali.

    Es la unica fuente con credenciales y con parametros obligatorios: sin la
    ventana de fechas responde 400. Se pide siempre desde el principio de la
    emergencia, que hoy cabe de sobra en una llamada.
    """
    if not (config.VISITADOS_USUARIO and config.VISITADOS_CLAVE):
        raise HTTPException(
            status_code=503,
            detail="Falta configurar VISITADOS_USUARIO y VISITADOS_CLAVE "
                   "en el .env del servidor.")

    ventana = {
        "desde_utc": fuentes.VISITADOS_DESDE_UTC,
        "hasta_utc": int(time.time() * 1000),
    }
    try:
        respuesta = await _cliente.get(
            fuente.url, params=ventana, timeout=120.0,
            auth=(config.VISITADOS_USUARIO, config.VISITADOS_CLAVE))
        respuesta.raise_for_status()
    except httpx.HTTPStatusError as excepcion:
        # Un 401 o un 403 aqui no es "el servidor no responde": es un problema
        # de configuracion nuestro, y decirlo ahorra ir a mirar los registros.
        codigo = excepcion.response.status_code
        if codigo == 401:
            raise HTTPException(
                status_code=502,
                detail="La Alcaldía de Cali rechazó las credenciales de Visitados "
                       "críticos. Revisar VISITADOS_USUARIO y VISITADOS_CLAVE "
                       "en el .env del servidor.") from excepcion
        if codigo == 403:
            raise HTTPException(
                status_code=502,
                detail="El correo está habilitado pero todavía no tiene contraseña "
                       "creada en el portal de operarios de la Alcaldía de Cali."
            ) from excepcion
        raise

    return _coleccion(visitados.aplanar(respuesta.json()), fuente)


_LECTORES = {
    "arcgis": _de_arcgis,
    "geojson": _de_geojson,
    "lista": _de_lista,
    "gdacs": _de_gdacs,
    "visitados": _de_visitados,
}


async def _obtener(fuente: fuentes.Fuente) -> tuple[bytes, int]:
    """Cuerpo GeoJSON de una fuente, de la cache o de la red."""
    guardado = _fresco(fuente)
    if guardado:
        return guardado

    # Un candado por fuente: si tres personas encienden la misma capa a la vez,
    # se descarga una sola vez y las otras dos esperan a esa.
    candado = _candados.setdefault(fuente.clave, asyncio.Lock())
    async with candado:
        guardado = _fresco(fuente)
        if guardado:
            return guardado

        lector = _LECTORES.get(fuente.tipo)
        if lector is None:
            raise HTTPException(status_code=400,
                                detail=f"La fuente «{fuente.nombre}» no es vectorial")
        try:
            coleccion = await lector(fuente)
        except httpx.HTTPError as excepcion:
            raise HTTPException(
                status_code=502,
                detail=f"{fuente.organizacion} no responde: {excepcion}") from excepcion
        except (RuntimeError, ValueError, KeyError) as excepcion:
            raise HTTPException(
                status_code=502,
                detail=f"Respuesta inesperada de {fuente.organizacion}: {excepcion}"
            ) from excepcion

        cuerpo = json.dumps(coleccion, ensure_ascii=False).encode()
        cuantas = len(coleccion["features"])
        _hacer_sitio(len(cuerpo))
        _cache[fuente.clave] = (time.time(), cuerpo, cuantas)
        return cuerpo, cuantas


# ---------------------------------------------------------------------------
# Ortoimagenes (ImageServer)
# ---------------------------------------------------------------------------
_extension_imagen: dict[str, list[float] | None] = {}


async def _extension(fuente: fuentes.Fuente) -> list[float] | None:
    """Extension de la ortoimagen en grados, para acotar el mapa.

    El IGAC publica su extension en EPSG:9377, que es justo la proyeccion que
    PostGIS ya tiene cargada para el resto del visor. Se reproyecta ahi en vez
    de meter pyproj solo para esto.
    """
    if fuente.clave in _extension_imagen:
        return _extension_imagen[fuente.clave]

    limites = None
    try:
        meta = await _metadatos(fuente.url)
        caja = meta.get("fullExtent") or meta.get("extent") or {}
        referencia = caja.get("spatialReference") or {}
        codigo = referencia.get("latestWkid") or referencia.get("wkid")
        if codigo and all(k in caja for k in ("xmin", "ymin", "xmax", "ymax")):
            fila = await db.pool().fetchrow(
                "SELECT ST_XMin(g) x1, ST_YMin(g) y1, ST_XMax(g) x2, ST_YMax(g) y2 "
                "FROM (SELECT ST_Transform("
                "        ST_MakeEnvelope($1,$2,$3,$4,$5), 4326) g) t",
                caja["xmin"], caja["ymin"], caja["xmax"], caja["ymax"], int(codigo))
            limites = [fila["x1"], fila["y1"], fila["x2"], fila["y2"]]
    except Exception:
        # Sin extension el mapa pide teselas de mas, pero funciona igual.
        limites = None

    _extension_imagen[fuente.clave] = limites
    return limites


_RADIO = 20037508.342789244    # medio ancho del mundo en Web Mercator


def _caja_tesela(z: int, x: int, y: int) -> tuple[float, float, float, float]:
    lado = 2 * _RADIO / (2 ** z)
    return (x * lado - _RADIO, _RADIO - (y + 1) * lado,
            (x + 1) * lado - _RADIO, _RADIO - y * lado)


def _grados(x_metros: float, y_metros: float) -> tuple[float, float]:
    lon = x_metros / _RADIO * 180
    lat = math.degrees(2 * math.atan(math.exp(y_metros / _RADIO * math.pi)) - math.pi / 2)
    return lon, lat


# ---------------------------------------------------------------------------
# Catalogo
# ---------------------------------------------------------------------------
def _ficha(fuente: fuentes.Fuente) -> dict:
    guardado = _cache.get(fuente.clave)
    return {
        "clave": fuente.clave,
        "nombre": fuente.nombre,
        "organizacion": fuente.organizacion,
        "tema": fuente.tema,
        "tipo": fuente.tipo,
        "url": fuente.url,
        "color": fuente.color,
        "titulo": fuente.titulo,
        "campos": list(fuente.campos),
        "nota": fuente.nota,
        "naturaleza": fuente.naturaleza,
        "motivo": fuente.motivo,
        "formulario": fuente.formulario,
        "simbologia": fuente.simbologia,
        "minutos": fuente.minutos,
        "zoom_min": fuente.zoom_min,
        "zoom_max": fuente.zoom_max,
        "filtros": [dict(f) for f in fuente.filtros],
        # Lo ya descargado, para que el catalogo pueda decir cuantas hay y de
        # cuando son sin volver a pedirlas.
        "total": guardado[2] if guardado else None,
        "descargado": round(time.time() - guardado[0]) if guardado else None,
        "sin_ubicacion": _sin_ubicacion.get(fuente.clave) or None,
        # Un modelo 3D no se descarga ni se cuenta: lo que el navegador
        # necesita saber es donde apoyarlo y a donde volar. Sale de
        # modelos3d.py y no de la Fuente para que la geometria del modelo
        # tenga un solo sitio donde vivir.
        **_datos_del_modelo(fuente),
    }


def _datos_del_modelo(fuente: fuentes.Fuente) -> dict:
    if fuente.tipo != "modelo3d":
        return {}
    modelo = modelos3d.POR_CLAVE.get(fuente.clave)
    if modelo is None:
        # Fuente declarada sin modelo detras. Se avisa en vez de romper el
        # catalogo entero: el resto de capas no tienen la culpa.
        return {"modelo": None}
    return {
        "modelo": {
            "tileset": f"/api/modelos/{modelo.clave}/tileset.json",
            "altura_base": modelo.altura_base,
            "centro": list(modelo.centro),
            "resolucion_cm": modelo.resolucion_cm,
        },
        "bounds": list(modelo.caja),
    }


@router.get("")
async def catalogo():
    fichas = [_ficha(f) for f in fuentes.CATALOGO]
    # Las extensiones de las ortos se resuelven a la vez: son cuatro peticiones
    # al IGAC la primera vez y ninguna despues.
    imagenes = [f for f in fuentes.CATALOGO if f.tipo == "imagen"]
    limites = await asyncio.gather(*(_extension(f) for f in imagenes),
                                   return_exceptions=True)
    acotadas = {f.clave: (l if isinstance(l, list) else None)
                for f, l in zip(imagenes, limites)}
    for ficha in fichas:
        if ficha["clave"] in acotadas:
            ficha["bounds"] = acotadas[ficha["clave"]]

    # Las catastrales no se descargan al vuelo, asi que su total no sale de la
    # cache sino de lo que hay importado. `completa` distingue una capa lista
    # de una que se quedo a medias, que de otro modo solo se notaria echando
    # en falta predios sobre el mapa.
    cargas = await importar_catastro.cuantas()
    for ficha in fichas:
        carga = cargas.get(ficha["clave"])
        if carga:
            ficha["total"] = carga["entidades"]
            ficha["cargando"] = not carga["completa"]
            if carga["bbox"]:
                # Sirve para dos cosas: encuadrar el mapa sobre la capa de un
                # clic, y decirle a MapLibre que fuera de Cali no pida teselas.
                ficha["bounds"] = [float(v) for v in carga["bbox"]]

    publicadas = await db.pool().fetch(
        "SELECT clave, visible, opacidad, radio FROM externas")

    return {
        "temas": [{"clave": c, "titulo": t, "descripcion": d} for c, t, d in fuentes.TEMAS],
        "fuentes": fichas,
        "publicadas": [dict(p) for p in publicadas],
        "productos": [{
            "clave": p.clave, "nombre": p.nombre, "organizacion": p.organizacion,
            "tipo": p.tipo, "mb": p.mb, "nota": p.nota, "motivo": p.motivo, "url": p.url,
        } for p in fuentes.PRODUCTOS],
    }


@router.get("/evento")
async def evento():
    """Ficha del sismo: que dice GDACS y en que va la activacion de Copernicus.

    Va aparte del catalogo porque son dos servidores externos mas y no vale la
    pena retrasar la lista de capas por ellos.
    """
    async def gdacs():
        crudo = await _json(fuentes.URL_GDACS, timeout=25.0)
        p = crudo.get("properties") or {}
        severidad = p.get("severitydata") or {}
        return {
            "nombre": p.get("name"),
            "descripcion": p.get("htmldescription"),
            "magnitud": severidad.get("severity"),
            "fecha": p.get("fromdate"),
            "alerta": p.get("alertlevel"),
            "coordenadas": (crudo.get("geometry") or {}).get("coordinates"),
        }

    async def ems():
        crudo = await _json(fuentes.URL_EMS, timeout=25.0)
        activacion = (crudo.get("results") or [{}])[0]
        aois = activacion.get("aois") or []
        return {
            "codigo": activacion.get("code"),
            "nombre": activacion.get("name"),
            "motivo": activacion.get("reason"),
            "cerrada": activacion.get("closed"),
            "activada": activacion.get("activationTime"),
            "aois": [{"numero": a.get("number"), "nombre": a.get("name"),
                      "productos": len(a.get("products") or [])} for a in aois],
        }

    resultados = await asyncio.gather(gdacs(), ems(), return_exceptions=True)
    return {
        "gdacs": resultados[0] if isinstance(resultados[0], dict) else None,
        "ems": resultados[1] if isinstance(resultados[1], dict) else None,
    }


@router.get("/novedades")
async def novedades():
    """Capas del programa DRP que aun no estan en el catalogo.

    Esri Colombia publica capas nuevas mientras dura la emergencia. Sin esto,
    enterarse dependeria de que alguien avise; con esto el equipo ve el nombre
    y la fecha, y puede pedir que se integren.
    """
    try:
        crudo = await _json(fuentes.URL_PORTAL, timeout=25.0)
    except httpx.HTTPError as excepcion:
        raise HTTPException(status_code=502, detail=f"ArcGIS no responde: {excepcion}") from excepcion

    conocidas = {f.url.rsplit("/FeatureServer", 1)[0].lower() for f in fuentes.CATALOGO}
    nuevas = []
    for item in crudo.get("results") or []:
        url = (item.get("url") or "")
        if item.get("type") != "Feature Service" or not url:
            continue
        if url.rsplit("/FeatureServer", 1)[0].lower() in conocidas:
            continue
        nuevas.append({
            "titulo": item.get("title"),
            "url": url,
            "modificado": item.get("modified"),
            "descripcion": (item.get("snippet") or "")[:200],
        })
    return {"total": crudo.get("total"), "nuevas": nuevas[:40]}


# ---------------------------------------------------------------------------
# Datos de una fuente
# ---------------------------------------------------------------------------
def _buscar(clave: str) -> fuentes.Fuente:
    fuente = fuentes.POR_CLAVE.get(clave)
    if fuente is None:
        raise HTTPException(status_code=404, detail="Esa fuente no existe en el catálogo")
    if fuente.tipo == "enlace":
        raise HTTPException(status_code=400, detail=fuente.motivo)
    return fuente


@router.get("/{clave}.geojson")
async def datos(clave: str):
    fuente = _buscar(clave)
    if fuente.tipo == "modelo3d":
        # No hay geometria vectorial que servir: es una malla. Sin esto se
        # intentaria descargar de una url vacia y el error no diria nada.
        raise HTTPException(
            status_code=400,
            detail=f"Es un modelo 3D: /api/modelos/{clave}/tileset.json")
    if fuente.tipo == "catastro":
        # Serviria medio millon de poligonos en una sola respuesta y tumbaria
        # el proceso. Se dice donde estan en vez de devolver un 500 opaco.
        raise HTTPException(
            status_code=400,
            detail="Esa capa se sirve en teselas: /api/externas/"
                   f"{clave}/teselas/{{z}}/{{x}}/{{y}}.pbf")
    cuerpo, _ = await _obtener(fuente)
    return Response(
        content=cuerpo,
        media_type="application/geo+json",
        # Corta y privada: son datos que cambian, y el servidor ya guarda su
        # propia copia. Aqui solo se evita repetir la misma peticion al mover
        # el mapa.
        headers={"Cache-Control": "private, max-age=60"},
    )


class ExternaParche(BaseModel):
    visible: bool | None = None
    opacidad: float | None = Field(default=None, ge=0, le=1)
    radio: float | None = Field(default=None, ge=0.3, le=4)


@router.post("/{clave}/encender", status_code=201)
async def encender(clave: str):
    """Publica la fuente en el mapa del EQUIPO, no solo para quien pulsa.

    Entra al frente del nivel superior: se acaba de anadir y esconderla al
    fondo obligaria a buscarla.
    """
    _buscar(clave)   # 404 si no esta en el catalogo
    entradas = await materializar()
    techo = max([f["orden"] for f in entradas if f["grupo_id"] is None], default=0)

    async with db.pool().acquire() as conexion:
        async with conexion.transaction():
            await conexion.execute(
                "INSERT INTO externas (clave) VALUES ($1) ON CONFLICT DO NOTHING", clave)
            await conexion.execute(
                "INSERT INTO pila (clave, grupo_id, orden) VALUES ($1, NULL, $2) "
                "ON CONFLICT (clave) DO NOTHING",
                f"ext-{clave}", techo + pila_logica.PASO)
    return {"ok": True}


@router.delete("/{clave}")
async def apagar(clave: str):
    """La quita del mapa del equipo. Sin confirmacion: el panel es de todos."""
    async with db.pool().acquire() as conexion:
        async with conexion.transaction():
            await conexion.execute("DELETE FROM pila WHERE clave=$1", f"ext-{clave}")
            await conexion.execute("DELETE FROM externas WHERE clave=$1", clave)
    return {"ok": True}


@router.patch("/{clave}")
async def editar(clave: str, parche: ExternaParche):
    fila = await db.pool().fetchrow(
        "UPDATE externas SET visible=COALESCE($2, visible), "
        "opacidad=COALESCE($3, opacidad), radio=COALESCE($4, radio) WHERE clave=$1 "
        "RETURNING clave, visible, opacidad, radio",
        clave, parche.visible, parche.opacidad, parche.radio)
    if fila is None:
        raise HTTPException(status_code=404, detail="Esa fuente no esta publicada")
    return dict(fila)


@router.get("/{clave}/tiles/{z}/{x}/{y}.png")
async def tesela(clave: str, z: int, x: int, y: int):
    fuente = _buscar(clave)
    if fuente.tipo != "imagen":
        raise HTTPException(status_code=400, detail="Esa fuente no es una imagen")

    x1, y1, x2, y2 = _caja_tesela(z, x, y)

    # Fuera de la zona del vuelo no se pide nada: el IGAC devolveria un cuadro
    # vacio y habriamos gastado una peticion suya y una nuestra por tesela.
    # 404 es lo que MapLibre entiende como "aqui no hay tesela" y es lo mismo
    # que ya devuelve el proxy de los rasters propios en sus bordes.
    limites = await _extension(fuente)
    if limites:
        lon1, lat1 = _grados(x1, y1)
        lon2, lat2 = _grados(x2, y2)
        if lon2 < limites[0] or lon1 > limites[2] or lat2 < limites[1] or lat1 > limites[3]:
            raise HTTPException(status_code=404, detail="Fuera del vuelo")

    try:
        respuesta = await _cliente.get(fuente.url + "/exportImage", params={
            "bbox": f"{x1},{y1},{x2},{y2}",
            "bboxSR": 3857,
            "imageSR": 3857,
            "size": "256,256",
            "format": "png",
            "transparent": "true",
            "f": "image",
        }, timeout=40.0)
    except httpx.HTTPError as excepcion:
        raise HTTPException(status_code=502,
                            detail=f"{fuente.organizacion} no responde: {excepcion}") from excepcion

    if respuesta.status_code != 200 or "image" not in respuesta.headers.get("content-type", ""):
        raise HTTPException(status_code=502, detail="El servidor de imágenes devolvió un error")

    return Response(
        content=respuesta.content,
        media_type=respuesta.headers.get("content-type", "image/png"),
        # El vuelo es de una fecha fija y no va a cambiar: se cachea largo, que
        # es lo que hace que moverse por Cali no sea una peticion al IGAC por
        # cada tesela ya vista.
        headers={"Cache-Control": "public, max-age=604800"},
    )


# Consulta de tesela para las capas catastrales.
#
# Lleva los atributos DENTRO de la tesela, al contrario que /api/tiles de las
# capas propias, que solo lleva el id y consulta el resto al abrir la ficha.
# La diferencia es deliberada: alli los atributos se editan y el color se
# recalcula, asi que cocerlos en la tesela obligaria a reconstruirlas en cada
# cambio. El catastro es una copia de solo lectura de una foto fija, asi que
# no hay nada que invalidar, y a cambio el globo del predio abre sin esperar
# una segunda peticion. La lista blanca ya se aplico al importar.
_TESELA_CATASTRO = """
WITH b AS (
  SELECT ST_TileEnvelope($2, $3, $4) AS env
),
f AS (
  SELECT c.props,
         ST_AsMVTGeom(ST_Transform(c.geom, 3857), b.env, $5, $6, true) AS geom
  FROM catastro c
  CROSS JOIN b
  WHERE c.fuente = $1
    AND c.geom && ST_Transform(b.env, 4326)
)
SELECT ST_AsMVT(f, 'catastro', $5, 'geom') FROM f WHERE geom IS NOT NULL
"""

# Precision de coordenada dentro de la tesela, en unidades por lado.
#
# 4096 es lo habitual y es lo que se usa donde se inspecciona. Pero en la
# tesela de mas lejos esa precision no se ve y si se paga: medido sobre la
# capa de construcciones, una tesela z15 del centro de Cali tarda 997 ms a
# 4096 y 245 ms a 1024. A ese zoom un pixel son ~4,8 m en el suelo y una
# unidad de tesela a 1024 son 1,2 m, asi que no hay nada que perder.
EXTENT_DETALLE = 4096
EXTENT_LEJOS = 1024


@router.get("/{clave}/teselas/{z}/{x}/{y}.pbf")
async def tesela_vector(clave: str, z: int, x: int, y: int):
    """Teselas MVT de una capa catastral, servidas desde la copia local."""
    fuente = _buscar(clave)
    if fuente.tipo != "catastro":
        raise HTTPException(status_code=400, detail="Esa fuente no se sirve en teselas")
    if not 0 <= z <= 22:
        raise HTTPException(status_code=400, detail="Zoom fuera de rango")
    # El navegador ya respeta el zoom_min de la fuente, pero el endpoint es
    # publico dentro de la sesion: sin este tope, una peticion suelta a z8
    # pondria a PostGIS a codificar medio millon de poligonos en una tesela.
    if z < fuente.zoom_min:
        raise HTTPException(
            status_code=404,
            detail=f"El catastro no se dibuja por debajo del zoom {fuente.zoom_min}")

    # A partir del zoom en que se generan las teselas de detalle, precision
    # completa; por debajo, la que se ve. El buffer acompana a la escala: es
    # el margen que evita que un poligono a caballo entre dos teselas se corte
    # justo en el borde.
    detalle = z >= fuente.zoom_max
    extent = EXTENT_DETALLE if detalle else EXTENT_LEJOS
    try:
        dato = await db.pool().fetchval(_TESELA_CATASTRO, clave, z, x, y,
                                        extent, 64 if detalle else 16)
    except asyncpg.exceptions.UndefinedTableError as excepcion:
        # La capa esta en el catalogo pero la copia local no se ha creado. Un
        # 500 por tesela llenaria la consola de errores rojos sin decir que
        # hacer; esto sale una vez y dice exactamente que falta.
        raise HTTPException(
            status_code=503,
            detail="El catastro todavía no está importado en este servidor.") from excepcion
    return Response(
        content=bytes(dato or b""),
        media_type="application/vnd.mapbox-vector-tile",
        # Copia local de una foto fija: no cambia hasta que alguien reimporte,
        # asi que moverse por la ciudad no tiene por que repetir consultas.
        headers={"Cache-Control": "private, max-age=86400"},
    )


# Tope de filas por peticion, igual que en la tabla de las capas propias.
MAX_FILAS_CATASTRO = 200

# Hasta donde se cuenta al buscar. Contar exacto obliga a recorrer las 406.000
# filas de la capa comparando texto, y son varios segundos con la tabla en
# blanco. Quien busca un predio quiere la fila, no el censo: se cuenta hasta
# aqui y por encima la tabla dice "mas de 10.000", que es la respuesta util.
TOPE_CUENTA_CATASTRO = 10000


@router.get("/{clave}/tabla")
async def tabla_catastro(clave: str, pagina: int = 0, limite: int = 100,
                         buscar: str = "", orden: str = "", descendente: bool = False):
    """Atributos de una capa catastral, paginados en el servidor.

    Las demas fuentes externas paginan en el navegador, porque su GeoJSON ya
    esta descargado y tiene tope de 8.000 entidades. Aqui son cientos de miles
    de filas que nunca llegan enteras al navegador, asi que la paginacion, la
    busqueda y el orden los hace PostGIS, igual que en las capas propias.
    """
    fuente = _buscar(clave)
    if fuente.tipo != "catastro":
        raise HTTPException(status_code=400, detail="Esa fuente no tiene tabla en el servidor")

    limite = max(1, min(MAX_FILAS_CATASTRO, limite))
    pagina = max(0, pagina)
    # Las columnas se saben de antemano: son la lista blanca del catalogo. No
    # hace falta muestrear el JSONB como en las capas propias, donde el
    # esquema lo trae cada archivo que alguien sube.
    columnas = list(fuente.campos)

    patron = f"%{buscar.strip()}%" if buscar.strip() else None
    # Con alias, porque las dos consultas de abajo llevan la tabla aliada.
    filtro = "c.fuente = $1 AND ($2::text IS NULL OR c.props::text ILIKE $2)"

    if patron is None:
        # Sin busqueda el total ya esta contado desde la importacion.
        total = await db.pool().fetchval(
            "SELECT entidades FROM catastro_cargas WHERE fuente = $1", clave) or 0
        aproximado = False
    else:
        total = await db.pool().fetchval(
            f"SELECT COUNT(*) FROM (SELECT 1 FROM catastro c WHERE {filtro} "
            f"LIMIT {TOPE_CUENTA_CATASTRO + 1}) t", clave, patron)
        aproximado = total > TOPE_CUENTA_CATASTRO
        total = min(total, TOPE_CUENTA_CATASTRO)

    sentido = "DESC" if descendente else "ASC"
    caja = ("ARRAY[ST_XMin(c.geom), ST_YMin(c.geom), "
            "ST_XMax(c.geom), ST_YMax(c.geom)] AS caja")

    if patron is None and orden not in columnas:
        # Camino rapido: hojear la capa de principio a fin, que es lo que se
        # hace el 90% de las veces.
        #
        # La subconsulta existe para que PostgreSQL use idx_catastro_fuente_id.
        # Preguntando directo con WHERE fuente=$1 ORDER BY id elige la clave
        # primaria y filtra por fuente sobre la marcha; como cada capa se
        # importa entera y seguida, sus ids caen todos juntos, y para la
        # ultima importada eso significa descartar 762.000 filas antes de dar
        # con la primera suya: 1,7 s por pagina. Asi la pagina sale del indice
        # sin tocar la tabla y son 6 ms.
        filas = await db.pool().fetch(
            f"""
            SELECT c.id, c.props, {caja}
            FROM catastro c
            WHERE c.id IN (SELECT id FROM catastro WHERE fuente = $1
                           ORDER BY id {sentido} LIMIT $2 OFFSET $3)
            ORDER BY c.id {sentido}
            """,
            clave, limite, pagina * limite,
        )
    else:
        # Buscar u ordenar por un atributo obliga a mirar el JSONB de cada
        # fila de la capa: no hay indice que sirva y no se finge que lo haya.
        #
        # El criterio de orden NO se interpola: o es una columna conocida y va
        # como parametro dentro de props ->> $n, o se cae al id.
        if orden in columnas:
            expresion, argumentos = "props ->> $5", [orden]
        else:
            expresion, argumentos = "id", []
        filas = await db.pool().fetch(
            f"""
            SELECT c.id, c.props, {caja}
            FROM catastro c
            WHERE {filtro}
            ORDER BY c.{expresion} {sentido} NULLS LAST, c.id
            LIMIT $3 OFFSET $4
            """,
            clave, patron, limite, pagina * limite, *argumentos,
        )

    return {
        "columnas": columnas,
        "total": total,
        "aproximado": aproximado,
        "pagina": pagina,
        "limite": limite,
        "filas": [{
            "id": f["id"],
            "nombre": None,
            "caja": [float(v) for v in f["caja"]] if f["caja"] else None,
            "propiedades": json.loads(f["props"]),
        } for f in filas],
    }


# Valores distintos de un campo, con su frecuencia. Se cachean sin caducidad:
# el catastro es una copia de una foto fija y no cambia hasta que alguien
# reimporte, mientras que la consulta recorre las 650.975 filas de la capa.
_valores_catastro: dict[tuple[str, str], dict] = {}

# Tope de valores distintos que se devuelven. Un campo con mas que esto es un
# identificador -el numero predial- y no sirve para filtrar por lista.
MAX_VALORES = 300


@router.get("/{clave}/valores")
async def valores_catastro(clave: str, campo: str):
    """Que valores toma un campo del catastro, para poblar el filtro.

    El filtro se aplica en el navegador sobre los atributos que ya viajan
    dentro de la tesela, asi que esto no filtra nada: solo dice que opciones
    ofrecer, y cuantas hay de cada una. Sin los conteos, un desplegable de
    plantas no distingue la planta 2 -100.839 unidades- de la planta 27, que
    tiene once.
    """
    fuente = _buscar(clave)
    if fuente.tipo != "catastro":
        raise HTTPException(status_code=400, detail="Esa fuente no tiene valores que listar")
    # Solo campos declarados como filtrables. El campo entra en la consulta
    # como parametro, no interpolado, pero aun asi no hay razon para dejar
    # preguntar por cualquier cosa.
    if campo not in {f["campo"] for f in fuente.filtros}:
        raise HTTPException(status_code=400, detail=f"«{campo}» no es filtrable en esta capa")

    guardado = _valores_catastro.get((clave, campo))
    if guardado is not None:
        return guardado

    filas = await db.pool().fetch(
        """
        SELECT NULLIF(btrim(props ->> $2), '') AS valor, COUNT(*) AS total
        FROM catastro
        WHERE fuente = $1
        GROUP BY 1
        ORDER BY COUNT(*) DESC, 1
        LIMIT $3
        """,
        clave, campo, MAX_VALORES + 1,
    )
    cortado = len(filas) > MAX_VALORES
    filas = filas[:MAX_VALORES]

    # Numerico si TODO lo que trae dato lo es. Decide el control: un rango con
    # dos extremos, o una lista de casillas.
    def numero(texto):
        try:
            return float(texto)
        except (TypeError, ValueError):
            return None

    con_dato = [f for f in filas if f["valor"] is not None]
    numeros = [numero(f["valor"]) for f in con_dato]
    es_numerico = bool(con_dato) and all(n is not None for n in numeros)

    respuesta = {
        "campo": campo,
        "numerico": es_numerico,
        "truncado": cortado,
        "sin_dato": sum(f["total"] for f in filas if f["valor"] is None),
        "minimo": min(numeros) if es_numerico else None,
        "maximo": max(numeros) if es_numerico else None,
        "valores": [{"valor": f["valor"], "total": f["total"]} for f in con_dato],
    }
    if not cortado:
        _valores_catastro[(clave, campo)] = respuesta
    return respuesta


class Copia(BaseModel):
    nombre: str | None = None


@router.post("/{clave}/copiar", status_code=201)
async def copiar(clave: str, datos_entrada: Copia, sesion: dict = Depends(requiere_sesion)):
    """Congela lo que la fuente tiene AHORA como una capa propia del equipo.

    Las capas externas se ven en vivo y por eso cambian bajo los pies: lo que
    hoy son 2.919 reportes manana son 3.400, y una cifra de un informe deja de
    poder reproducirse. Al copiarla queda una foto fechada, editable, que se
    puede simbolizar, filtrar, medir en 9377 y exportar como cualquier otra.
    """
    fuente = _buscar(clave)
    if fuente.tipo == "modelo3d":
        raise HTTPException(
            status_code=400,
            detail="Un modelo 3D ya es un archivo fijo en el servidor: no cambia bajo "
                   "los pies y no hay nada que congelar.")
    if fuente.tipo == "catastro":
        # Copiar sirve para congelar una fuente que cambia bajo los pies. El
        # catastro no cambia -es una foto fija ya copiada aqui- y volcarlo a
        # `elementos` meteria medio millon de poligonos en la tabla de dibujo
        # del equipo, con lo que eso hace a cada tesela propia.
        raise HTTPException(
            status_code=400,
            detail="El catastro ya es una copia local y no cambia: no hay nada que congelar.")
    cuerpo, _ = await _obtener(fuente)
    coleccion = json.loads(cuerpo)
    if not coleccion.get("features"):
        raise HTTPException(status_code=400, detail="La fuente no devolvió entidades")

    momento = time.strftime("%d-%b %H:%M").lower()
    nombre = (datos_entrada.nombre or "").strip() or f"{fuente.nombre} · {momento}"
    capa_id, insertados, omitidos = await insertar_geojson(
        coleccion, nombre[:120], fuente.color, sesion.get("autor"))
    return {"capa_id": capa_id, "insertados": insertados, "omitidos": omitidos,
            "nombre": nombre}


# ---------------------------------------------------------------------------
# Productos descargables
# ---------------------------------------------------------------------------
# Nombres legibles de las capas que trae un producto de grading de Copernicus.
CAPAS_EMS = {
    "builtUpP": ("Edificaciones (puntos)", "#e63946"),
    "builtUpA": ("Edificaciones (polígonos)", "#e63946"),
    "transportationL": ("Vías", "#f77f00"),
    "transportationP": ("Puntos de transporte", "#f77f00"),
    "hydrographyA": ("Hidrografía", "#3a86ff"),
    "hydrographyL": ("Cauces", "#3a86ff"),
    "physiographyL": ("Fisiografía", "#8d99ae"),
    "populatedPlacesP": ("Poblados", "#9d4edd"),
    "facilitiesP": ("Equipamientos", "#2a9d8f"),
    "naturalLandUseA": ("Cobertura natural", "#7cb518"),
    "areaOfInterestA": ("Área de interés", "#8d99ae"),
    "imageFootprintA": ("Huella de la imagen", "#457b9d"),
    "observedEventA": ("Evento observado", "#c1121f"),
    "observedEventP": ("Evento observado (puntos)", "#c1121f"),
}


def _nombre_capa_ems(miembro: str) -> tuple[str, str]:
    """'EMSR916_AOI03_GRA_PRODUCT_builtUpP_v1.json' -> ('Edificaciones…', color)."""
    trozo = os.path.basename(miembro).removesuffix(".json")
    partes = trozo.split("_")
    token = partes[-2] if len(partes) >= 2 and partes[-1].startswith("v") else partes[-1]
    return CAPAS_EMS.get(token, (token, "#3a86ff"))


async def _descargar_a(url: str, ruta: str) -> None:
    """Descarga a disco por trozos.

    Los productos de huellas rondan los 75 MB. Cargarlos enteros en memoria
    para volver a escribirlos en disco cuesta el doble en un contenedor con
    512 MB, y el archivo va a acabar en disco de todas formas.
    """
    with open(ruta, "wb") as archivo:
        async with _cliente.stream("GET", url, timeout=300.0) as respuesta:
            respuesta.raise_for_status()
            async for trozo in respuesta.aiter_bytes(1 << 20):
                archivo.write(trozo)


@router.post("/productos/{clave}/importar")
async def importar_producto(clave: str, sesion: dict = Depends(requiere_sesion)):
    producto = fuentes.PRODUCTO_POR_CLAVE.get(clave)
    if producto is None:
        raise HTTPException(status_code=404, detail="Ese producto no existe en el catálogo")
    if producto.tipo == "enlace":
        raise HTTPException(status_code=400, detail=producto.motivo)

    try:
        if producto.tipo in ("huellas", "raster"):
            carpeta = (config.DIR_ENTRADA if producto.tipo == "raster"
                       else os.path.join(config.DIR_DATOS, "temporal"))
            os.makedirs(carpeta, exist_ok=True)
            extension = "tif" if producto.tipo == "raster" else "gpkg"
            ruta = os.path.join(carpeta, f"{producto.clave}.{extension}")
            await _descargar_a(producto.url, ruta)
            if producto.tipo == "raster":
                return {"raster": await importar_raster(
                    Importacion(archivo=os.path.basename(ruta),
                                nombre=producto.nombre[:120]), sesion)}
            return await _importar_huellas(producto, ruta, sesion)

        respuesta = await _cliente.get(producto.url, timeout=300.0)
        respuesta.raise_for_status()
    except httpx.HTTPError as excepcion:
        raise HTTPException(status_code=502,
                            detail=f"No se pudo descargar: {excepcion}") from excepcion

    if producto.tipo == "geojson":
        capa_id, insertados, _ = await insertar_geojson(
            respuesta.json(), producto.nombre[:120], "#457b9d", sesion.get("autor"))
        return {"capas": [{"capa_id": capa_id, "nombre": producto.nombre,
                           "insertados": insertados}], "vacias": []}
    return await _importar_zip_ems(producto, respuesta.content, sesion)


async def _importar_zip_ems(producto, contenido: bytes, sesion: dict) -> dict:
    """Los productos de Copernicus traen los .json ya en WGS84, listos.

    Se entra por los .json y no por los shapefiles a proposito: son el mismo
    dato, y evitan tener que sacar ogr2ogr y una carpeta temporal.
    """
    try:
        paquete = zipfile.ZipFile(io.BytesIO(contenido))
    except zipfile.BadZipFile as excepcion:
        raise HTTPException(status_code=502, detail="El archivo descargado no es un ZIP") from excepcion

    creadas, vacias = [], []
    for miembro in sorted(paquete.namelist()):
        if not miembro.endswith(".json"):
            continue
        try:
            crudo = json.loads(paquete.read(miembro))
        except (json.JSONDecodeError, KeyError):
            continue
        if crudo.get("type") != "FeatureCollection":
            continue

        etiqueta, color = _nombre_capa_ems(miembro)
        if not crudo.get("features"):
            vacias.append(etiqueta)
            continue

        codigo = os.path.basename(miembro).split("_GRA")[0].replace("_", " ")
        capa_id, insertados, _ = await insertar_geojson(
            crudo, f"{codigo} · {etiqueta}"[:120], color, sesion.get("autor"))
        creadas.append({"capa_id": capa_id, "nombre": etiqueta, "insertados": insertados})

    if not creadas:
        raise HTTPException(status_code=502,
                            detail="El producto no traía capas con entidades")
    return {"capas": creadas, "vacias": vacias}


async def _importar_huellas(producto, origen: str, sesion: dict) -> dict:
    """Trae de un GeoPackage grande solo las filas que dicen algo.

    Los dos productos de huellas de HDX son trescientas mil y cien mil
    edificaciones en UTM 18N. Meterlas enteras rompe el visor para todo el
    equipo: la tesela vectorial no filtra por zoom, asi que un solo mosaico
    sobre Cali intentaria dibujarlas todas. Con el filtro de la prediccion
    quedan unas mil, que es lo que de verdad hay que ir a mirar en la imagen.

    El filtro y la reproyeccion los hace GDAL, que ya esta en la imagen, en
    lugar de cargar el archivo entero en memoria.
    """
    destino = f"{os.path.splitext(origen)[0]}.geojson"

    try:
        codigo, _, error = await _correr(
            "ogr2ogr", "-f", "GeoJSON", destino, origen,
            "-t_srs", "EPSG:4326",
            "-where", producto.filtro,
            "-lco", "COORDINATE_PRECISION=6",
        )
        if codigo != 0 or not os.path.exists(destino):
            raise HTTPException(
                status_code=502,
                detail=f"No se pudo filtrar el archivo: {error.decode()[:200]}")

        with open(destino, encoding="utf-8") as archivo:
            coleccion = json.load(archivo)
    finally:
        # Son cien megabytes que no hacen falta una vez ingerido lo util.
        # SQLite deja ademas sus dos archivos de diario junto al GeoPackage.
        for ruta in (origen, destino, f"{origen}-shm", f"{origen}-wal"):
            if os.path.exists(ruta):
                try:
                    os.remove(ruta)
                except OSError:
                    pass

    if not coleccion.get("features"):
        raise HTTPException(status_code=502,
                            detail="El filtro no dejó ninguna edificación")

    capa_id, insertados, _ = await insertar_geojson(
        coleccion, producto.nombre[:120], "#c1121f", sesion.get("autor"))
    return {"capas": [{"capa_id": capa_id, "nombre": producto.nombre,
                       "insertados": insertados}], "vacias": []}


async def _importar_raster(producto, contenido: bytes, sesion: dict) -> dict:
    """Deja el COG en la carpeta de entrada y lo encola como cualquier escena."""
    os.makedirs(config.DIR_ENTRADA, exist_ok=True)
    archivo = f"{producto.clave}.tif"
    with open(os.path.join(config.DIR_ENTRADA, archivo), "wb") as destino:
        destino.write(contenido)
    return {"raster": await importar_raster(
        Importacion(archivo=archivo, nombre=producto.nombre[:120]), sesion)}
