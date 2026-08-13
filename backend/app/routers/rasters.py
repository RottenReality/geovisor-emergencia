"""Rasters: ortofotos de dron e imagen satelital.

Flujo: se recibe el archivo (por subida o desde la carpeta de entrada del
servidor), se comprueba si ya cumple COG y, si no, se convierte con GDAL en
segundo plano. Ademas se miden las bandas para saber como pintarlo: la imagen
satelital cruda no es una imagen visible.

TiTiler queda SOLO en la red interna. El navegador nunca le habla directamente
ni le pasa rutas: pide /api/rasters/{id}/tiles/... y este modulo resuelve el
archivo del lado del servidor. Sin eso, cualquiera podria hacer que TiTiler
leyera rutas o URLs arbitrarias del servidor.
"""
import asyncio
import json
import os
import re
import shutil
import uuid

import httpx
from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, Field

from .. import config, db
from ..auth import requiere_sesion

router = APIRouter(prefix="/api/rasters", dependencies=[Depends(requiere_sesion)])

EXTENSIONES = (".tif", ".tiff", ".cog")
COMBINACIONES = ("natural", "infrarrojo", "gris")

# TiTiler cambio la forma de sus rutas entre versiones, asi que se le pregunta
# cual expone en vez de fijarla a ciegas.
#
# Antes esto se resolvia probando rutas y descartando las que daban 404. Era
# incorrecto: TiTiler tambien responde 404 cuando la tesela cae FUERA del
# raster, cosa habitual en los bordes. Una peticion de borde justo despues de
# reiniciar hacia creer que ninguna ruta servia, y ya no se recuperaba.
_ruta_titiler: str | None = None
_candado_ruta = asyncio.Lock()
_RUTAS_CONOCIDAS = (
    "/cog/tiles/{tileMatrixSetId}/{z}/{x}/{y}.{format}",
    "/cog/tiles/{tileMatrixSetId}/{z}/{x}/{y}",
    "/cog/tiles/{z}/{x}/{y}.{format}",
    "/cog/tiles/{z}/{x}/{y}",
)


async def _resolver_ruta_teselas() -> str:
    """Descubre la plantilla de teselas leyendo el esquema OpenAPI de TiTiler."""
    global _ruta_titiler
    async with _candado_ruta:
        if _ruta_titiler:
            return _ruta_titiler

        respuesta = await _cliente.get(f"{config.TITILER_URL}/api", timeout=20.0)
        respuesta.raise_for_status()
        rutas = set(respuesta.json().get("paths", {}))

        for plantilla in _RUTAS_CONOCIDAS:
            if plantilla in rutas:
                _ruta_titiler = (plantilla
                                 .replace("{tileMatrixSetId}", "WebMercatorQuad")
                                 .replace("{format}", "png"))
                return _ruta_titiler

        raise RuntimeError(f"TiTiler no expone ninguna ruta de teselas conocida: {sorted(rutas)}")

_cliente = httpx.AsyncClient(timeout=httpx.Timeout(60.0, connect=10.0))


class RasterParche(BaseModel):
    nombre: str | None = None
    visible: bool | None = None
    opacidad: float | None = Field(default=None, ge=0, le=1)
    orden: int | None = None
    combinacion: str | None = None


class Importacion(BaseModel):
    archivo: str
    nombre: str


def nombre_seguro(original: str) -> str:
    base = re.sub(r"[^A-Za-z0-9._-]", "_", os.path.basename(original or "raster.tif"))
    return f"{uuid.uuid4().hex[:12]}_{base[:60]}"


async def _correr(*orden: str) -> tuple[int, bytes, bytes]:
    proceso = await asyncio.create_subprocess_exec(
        *orden,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        # Limita la cache de GDAL: sin esto, convertir una ortofoto grande se
        # come la RAM del contenedor y el kernel lo mata.
        env={**os.environ, "GDAL_CACHEMAX": "256"},
    )
    salida, error = await proceso.communicate()
    return proceso.returncode, salida, error


async def _inspeccionar(ruta: str) -> dict:
    codigo, salida, error = await _correr("gdalinfo", "-json", ruta)
    if codigo != 0:
        raise RuntimeError(error.decode(errors="replace")[:300] or "gdalinfo fallo")
    return json.loads(salida)


def _es_cog(info: dict) -> bool:
    estructura = info.get("metadata", {}).get("IMAGE_STRUCTURE", {})
    return estructura.get("LAYOUT", "").upper() == "COG"


def _bounds(info: dict) -> list[float] | None:
    extension = info.get("wgs84Extent")
    if not extension:
        return None
    puntos: list[list[float]] = []

    def recolectar(nodo):
        if isinstance(nodo, list) and nodo and isinstance(nodo[0], (int, float)):
            puntos.append(nodo)
        elif isinstance(nodo, list):
            for hijo in nodo:
                recolectar(hijo)

    recolectar(extension.get("coordinates", []))
    if not puntos:
        return None
    return [
        min(p[0] for p in puntos), min(p[1] for p in puntos),
        max(p[0] for p in puntos), max(p[1] for p in puntos),
    ]


async def _medir_bandas(info: dict, ruta: str) -> list[dict]:
    """Indice, interpretacion de color y percentiles 2/98 de cada banda.

    Los percentiles vienen de TiTiler, que muestrea sobre las vistas generales
    del COG en vez de leer la imagen completa. Es el estiramiento de contraste
    estandar para imagen satelital: sin el, una escena de reflectancia se ve
    casi negra porque el rango util ocupa una fraccion del rango del dato.
    """
    bandas = [
        {
            "indice": b.get("band", i + 1),
            "interp": (b.get("colorInterpretation") or "").lower(),
            "tipo": b.get("type", ""),
            # Sentinel-2 apilado no declara color pero si nombra las bandas
            # (B2, B3, B4, B8), y eso basta para identificarlas.
            "nombre": (b.get("description") or "").strip(),
        }
        for i, b in enumerate(info.get("bands", []))
    ]

    try:
        respuesta = await _cliente.get(
            f"{config.TITILER_URL}/cog/statistics", params={"url": ruta}, timeout=180.0)
        respuesta.raise_for_status()
        estadisticas = respuesta.json()
        for banda in bandas:
            stats = estadisticas.get(f"b{banda['indice']}") or {}
            banda["p2"] = stats.get("percentile_2")
            banda["p98"] = stats.get("percentile_98")
    except Exception:
        # Sin estadisticas se pinta sin estirar: peor, pero no rompe nada.
        pass

    return bandas


# Nombres de banda de Sentinel-2 (y equivalentes de Landsat por si acaso).
_POR_NOMBRE = {
    "azul":  ("b2", "blue", "azul", "sr_b2", "b02"),
    "verde": ("b3", "green", "verde", "sr_b3", "b03"),
    "rojo":  ("b4", "red", "rojo", "sr_b4", "b04"),
    "nir":   ("b8", "b8a", "nir", "infrarrojo", "sr_b5", "b08"),
}


def _identificar_bandas(bandas: list[dict]) -> dict:
    """Averigua que indice es el rojo, el verde, el azul y el infrarrojo.

    Se intenta por interpretacion de color, luego por nombre de banda y, si el
    archivo no dice nada, se asume el apilado habitual de PlanetScope y
    Sentinel-2: Azul, Verde, Rojo, NIR.
    """
    total = len(bandas)

    por_interp: dict[str, int] = {}
    for banda in bandas:
        interp = banda.get("interp", "")
        if interp in ("red", "green", "blue") and interp not in por_interp:
            por_interp[interp] = banda["indice"]

    if {"red", "green", "blue"} <= por_interp.keys():
        rojo, verde, azul = por_interp["red"], por_interp["green"], por_interp["blue"]
        usadas = {rojo, verde, azul}
        nir = next((b["indice"] for b in bandas if b["indice"] not in usadas), None)
        return {"rojo": rojo, "verde": verde, "azul": azul, "nir": nir}

    por_nombre: dict[str, int] = {}
    for banda in bandas:
        etiqueta = banda.get("nombre", "").lower()
        for papel, alias in _POR_NOMBRE.items():
            if etiqueta in alias and papel not in por_nombre:
                por_nombre[papel] = banda["indice"]
    if {"rojo", "verde", "azul"} <= por_nombre.keys():
        return {"rojo": por_nombre["rojo"], "verde": por_nombre["verde"],
                "azul": por_nombre["azul"], "nir": por_nombre.get("nir")}

    if total >= 4:
        return {"rojo": 3, "verde": 2, "azul": 1, "nir": 4}
    if total == 3:
        return {"rojo": 1, "verde": 2, "azul": 3, "nir": None}
    return {"rojo": 1, "verde": 1, "azul": 1, "nir": None}


def _plan_de_pintado(bandas: list[dict], combinacion: str) -> dict:
    """Traduce bandas + combinacion a los parametros que entiende TiTiler."""
    if not bandas:
        return {}

    papeles = _identificar_bandas(bandas)

    if combinacion == "gris" or len(bandas) == 1:
        elegidas = [bandas[0]["indice"]]
    elif combinacion == "infrarrojo" and papeles["nir"]:
        # NIR en el canal rojo: asi la vegetacion sana se ve roja, que es la
        # lectura estandar de una composicion en falso color.
        elegidas = [papeles["nir"], papeles["rojo"], papeles["verde"]]
    else:
        elegidas = [papeles["rojo"], papeles["verde"], papeles["azul"]]

    plan: dict = {"bidx": elegidas}

    # Un raster de 8 bits ya es visible: estirarlo solo alteraria los colores.
    if any(b.get("tipo", "").lower() not in ("byte", "") for b in bandas):
        indexadas = {b["indice"]: b for b in bandas}
        rangos = []
        for indice in elegidas:
            banda = indexadas.get(indice, {})
            p2, p98 = banda.get("p2"), banda.get("p98")
            if p2 is None or p98 is None or p98 <= p2:
                rangos = []
                break
            rangos.append(f"{p2},{p98}")
        if rangos:
            plan["rescale"] = rangos

    return plan


async def procesar_raster(id_raster: int, origen: str, destino: str) -> None:
    """Valida, convierte a COG si hace falta, mide las bandas y publica.

    La ejecuta el contenedor worker, no la API. Convertir una escena de
    gigapixeles ocupa CPU durante bastantes minutos, y hacerlo dentro del
    proceso que atiende la web la dejaria lenta para todo el equipo.
    """
    try:
        info = await _inspeccionar(origen)
        if not info.get("coordinateSystem", {}).get("wkt"):
            raise RuntimeError(
                "El archivo no trae sistema de referencia. Asignalo en QGIS "
                "(Capa > Establecer SRC) y vuelve a subirlo.")

        if _es_cog(info):
            shutil.move(origen, destino)
        else:
            codigo, _, error = await _correr(
                "gdal_translate", "-of", "COG",
                "-co", "COMPRESS=DEFLATE",
                "-co", "BLOCKSIZE=512",
                "-co", "OVERVIEWS=AUTO",
                "-co", "NUM_THREADS=2",
                origen, destino,
            )
            if codigo != 0:
                raise RuntimeError(error.decode(errors="replace")[-300:] or "gdal_translate fallo")
            os.remove(origen)

        info_final = await _inspeccionar(destino)
        bandas = await _medir_bandas(info_final, destino)

        await db.pool().execute(
            "UPDATE rasters SET estado='listo', archivo=$2, bounds=$3, bandas=$4::jsonb, "
            "mensaje=NULL WHERE id=$1",
            id_raster, os.path.basename(destino), _bounds(info_final), json.dumps(bandas),
        )
    except Exception as excepcion:
        await db.pool().execute(
            "UPDATE rasters SET estado='error', mensaje=$2 WHERE id=$1",
            id_raster, str(excepcion)[:500],
        )
        for sobrante in (origen, destino):
            if os.path.exists(sobrante):
                try:
                    os.remove(sobrante)
                except OSError:
                    pass


@router.get("")
async def listar():
    filas = await db.pool().fetch(
        "SELECT id, nombre, estado, mensaje, bounds, visible, opacidad, orden, "
        "       autor, creado_en, combinacion, bandas "
        "FROM rasters ORDER BY orden NULLS LAST, id"
    )
    salida = []
    for f in filas:
        dato = dict(f)
        bandas = json.loads(dato.pop("bandas") or "[]")
        dato["num_bandas"] = len(bandas)
        # El visor solo necesita saber si puede ofrecer el falso color.
        dato["admite_infrarrojo"] = len(bandas) >= 4
        salida.append(dato)
    return salida


@router.get("/disponibles")
async def disponibles():
    """Archivos dejados en la carpeta de entrada del servidor.

    Para las escenas grandes (los Skysat rondan 1,8 GB) subir por el navegador
    es fragil y lento. Se copian por scp a /datos/entrada y se importan de un
    clic desde aqui.
    """
    os.makedirs(config.DIR_ENTRADA, exist_ok=True)
    # Al importar, el archivo se mueve fuera de esta carpeta, asi que lo que
    # queda listado es exactamente lo que falta por importar.
    archivos = []
    for nombre in sorted(os.listdir(config.DIR_ENTRADA)):
        ruta = os.path.join(config.DIR_ENTRADA, nombre)
        if not nombre.lower().endswith(EXTENSIONES) or not os.path.isfile(ruta):
            continue
        archivos.append({
            "archivo": nombre,
            "mb": round(os.path.getsize(ruta) / 1024 / 1024, 1),
        })
    return archivos


@router.post("/importar", status_code=202)
async def importar(datos: Importacion, sesion: dict = Depends(requiere_sesion)):
    """Importa un archivo dejado por scp. Solo lo encola: convierte el worker."""
    # basename evita que un ".." saque la lectura de la carpeta de entrada.
    nombre_archivo = os.path.basename(datos.archivo)
    en_entrada = os.path.join(config.DIR_ENTRADA, nombre_archivo)
    if not nombre_archivo.lower().endswith(EXTENSIONES) or not os.path.isfile(en_entrada):
        raise HTTPException(status_code=404, detail="No existe ese archivo en la carpeta de entrada")

    os.makedirs(config.DIR_RASTERS, exist_ok=True)
    seguro = nombre_seguro(nombre_archivo)
    origen = os.path.join(config.DIR_RASTERS, f"entrada_{seguro}")
    destino = os.path.join(config.DIR_RASTERS, f"{os.path.splitext(seguro)[0]}.tif")
    # Mover, no copiar: son gigabytes y estan en el mismo volumen.
    shutil.move(en_entrada, origen)

    fila = await db.pool().fetchrow(
        """
        INSERT INTO rasters (nombre, estado, autor, origen, destino, orden)
        VALUES ($1, 'pendiente', $2, $3, $4,
                COALESCE((SELECT MAX(orden) + 1 FROM rasters), 1))
        RETURNING id, nombre, estado, orden
        """,
        datos.nombre.strip() or nombre_archivo,
        sesion.get("autor"), origen, destino,
    )
    return dict(fila)


@router.patch("/{id_raster}")
async def editar(id_raster: int, parche: RasterParche):
    if parche.combinacion is not None and parche.combinacion not in COMBINACIONES:
        raise HTTPException(status_code=400,
                            detail=f"combinacion debe ser una de {COMBINACIONES}")
    fila = await db.pool().fetchrow(
        """
        UPDATE rasters SET
          nombre      = COALESCE($2, nombre),
          visible     = COALESCE($3, visible),
          opacidad    = COALESCE($4, opacidad),
          orden       = COALESCE($5, orden),
          combinacion = COALESCE($6, combinacion)
        WHERE id = $1
        RETURNING id, nombre, visible, opacidad, orden, combinacion
        """,
        id_raster, parche.nombre, parche.visible, parche.opacidad,
        parche.orden, parche.combinacion,
    )
    if fila is None:
        raise HTTPException(status_code=404, detail="Raster no encontrado")
    return dict(fila)


@router.post("/{id_raster}/remedir")
async def remedir(id_raster: int):
    """Vuelve a medir las bandas de un raster ya publicado.

    Sirve para los que se ingirieron antes de que existiera la medicion, y
    para rehacer el estiramiento si la imagen se ve mal.
    """
    archivo = await db.pool().fetchval(
        "SELECT archivo FROM rasters WHERE id=$1 AND estado='listo'", id_raster)
    if not archivo:
        raise HTTPException(status_code=404, detail="Raster no disponible")

    ruta = os.path.join(config.DIR_RASTERS, os.path.basename(archivo))
    bandas = await _medir_bandas(await _inspeccionar(ruta), ruta)
    await db.pool().execute(
        "UPDATE rasters SET bandas=$2::jsonb WHERE id=$1", id_raster, json.dumps(bandas))
    return {"ok": True, "bandas": bandas}


@router.delete("/{id_raster}")
async def borrar(id_raster: int):
    fila = await db.pool().fetchrow(
        "DELETE FROM rasters WHERE id=$1 RETURNING nombre, archivo", id_raster)
    if fila is None:
        raise HTTPException(status_code=404, detail="Raster no encontrado")
    if fila["archivo"]:
        ruta = os.path.join(config.DIR_RASTERS, fila["archivo"])
        if os.path.exists(ruta):
            try:
                os.remove(ruta)
            except OSError:
                pass
    return {"ok": True, "nombre": fila["nombre"]}


@router.get("/{id_raster}/tiles/{z}/{x}/{y}.png")
async def tesela(id_raster: int, z: int, x: int, y: int, c: str | None = None):
    fila = await db.pool().fetchrow(
        "SELECT archivo, bandas, combinacion FROM rasters WHERE id=$1 AND estado='listo'",
        id_raster)
    if fila is None or not fila["archivo"]:
        raise HTTPException(status_code=404, detail="Raster no disponible")

    combinacion = c if c in COMBINACIONES else fila["combinacion"]
    bandas = json.loads(fila["bandas"] or "[]")
    ruta_local = os.path.join(config.DIR_RASTERS, os.path.basename(fila["archivo"]))
    parametros: dict = {"url": ruta_local, **_plan_de_pintado(bandas, combinacion)}

    try:
        plantilla = await _resolver_ruta_teselas()
        respuesta = await _cliente.get(
            config.TITILER_URL + plantilla.format(z=z, x=x, y=y), params=parametros)
    except (httpx.HTTPError, RuntimeError) as excepcion:
        raise HTTPException(status_code=502, detail=f"TiTiler no responde: {excepcion}") from excepcion

    if respuesta.status_code >= 500:
        raise HTTPException(status_code=502,
                            detail=f"No se pudo pintar la tesela: {respuesta.text[:300]}")

    # Un 404 aqui significa que la tesela cae fuera del raster, cosa normal en
    # los bordes: se deja pasar tal cual y el mapa simplemente no pinta nada.
    return Response(
        content=respuesta.content,
        status_code=respuesta.status_code,
        media_type=respuesta.headers.get("content-type", "image/png"),
        # Los rasters no cambian una vez convertidos: si se pueden cachear.
        headers={"Cache-Control": "public, max-age=86400"},
    )
