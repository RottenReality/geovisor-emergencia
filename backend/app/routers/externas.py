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

import httpx
from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel

from .. import config, db, fuentes
from ..auth import requiere_sesion
from .rasters import Importacion, importar as importar_raster
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
    """Deja solo la lista blanca y absolutiza los enlaces relativos."""
    if fuente.campos:
        propiedades = {k: v for k, v in propiedades.items() if k in fuente.campos}
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


_LECTORES = {
    "arcgis": _de_arcgis,
    "geojson": _de_geojson,
    "lista": _de_lista,
    "gdacs": _de_gdacs,
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
        "simbologia": fuente.simbologia,
        "minutos": fuente.minutos,
        # Lo ya descargado, para que el catalogo pueda decir cuantas hay y de
        # cuando son sin volver a pedirlas.
        "total": guardado[2] if guardado else None,
        "descargado": round(time.time() - guardado[0]) if guardado else None,
        "sin_ubicacion": _sin_ubicacion.get(fuente.clave) or None,
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

    return {
        "temas": [{"clave": c, "titulo": t, "descripcion": d} for c, t, d in fuentes.TEMAS],
        "fuentes": fichas,
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
    cuerpo, _ = await _obtener(fuente)
    return Response(
        content=cuerpo,
        media_type="application/geo+json",
        # Corta y privada: son datos que cambian, y el servidor ya guarda su
        # propia copia. Aqui solo se evita repetir la misma peticion al mover
        # el mapa.
        headers={"Cache-Control": "private, max-age=60"},
    )


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


@router.post("/productos/{clave}/importar")
async def importar_producto(clave: str, sesion: dict = Depends(requiere_sesion)):
    producto = fuentes.PRODUCTO_POR_CLAVE.get(clave)
    if producto is None:
        raise HTTPException(status_code=404, detail="Ese producto no existe en el catálogo")
    if producto.tipo == "enlace":
        raise HTTPException(status_code=400, detail=producto.motivo)

    try:
        respuesta = await _cliente.get(producto.url, timeout=300.0)
        respuesta.raise_for_status()
    except httpx.HTTPError as excepcion:
        raise HTTPException(status_code=502,
                            detail=f"No se pudo descargar: {excepcion}") from excepcion

    if producto.tipo == "raster":
        return await _importar_raster(producto, respuesta.content, sesion)
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


async def _importar_raster(producto, contenido: bytes, sesion: dict) -> dict:
    """Deja el COG en la carpeta de entrada y lo encola como cualquier escena."""
    os.makedirs(config.DIR_ENTRADA, exist_ok=True)
    archivo = f"{producto.clave}.tif"
    with open(os.path.join(config.DIR_ENTRADA, archivo), "wb") as destino:
        destino.write(contenido)
    return {"raster": await importar_raster(
        Importacion(archivo=archivo, nombre=producto.nombre[:120]), sesion)}
