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
import hashlib
import json
import os
import re
import shutil
import unicodedata
import uuid

import httpx
from fastapi import APIRouter, Depends, HTTPException, Response
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from .. import config, db
from ..auth import requiere_sesion

router = APIRouter(prefix="/api/rasters", dependencies=[Depends(requiere_sesion)])

EXTENSIONES = (".tif", ".tiff", ".cog")
COMBINACIONES = ("natural", "infrarrojo", "swir", "gris")

# Papeles que puede desempenar una banda. Los tres primeros son obligatorios
# para poder componer una imagen; los otros dos habilitan el falso color.
PAPELES = ("rojo", "verde", "azul", "nir", "swir")

# Como repartir el contraste entre las tres bandas de una composicion.
BALANCES = ("auto", "comun", "banda")

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


class BandasEntrada(BaseModel):
    """Asignacion manual de bandas y reparto del contraste.

    Se manda siempre el estado completo, no un parche: `papeles = null` es
    "vuelve a deducirlo del archivo" y `balance = "auto"` lo mismo para el
    contraste. Con COALESCE no habria forma de expresar ese "quitalo".
    """

    papeles: dict[str, int | None] | None = None
    balance: str = "auto"


class Importacion(BaseModel):
    archivo: str
    nombre: str


def nombre_seguro(original: str) -> str:
    base = re.sub(r"[^A-Za-z0-9._-]", "_", os.path.basename(original or "raster.tif"))
    return f"{uuid.uuid4().hex[:12]}_{base[:60]}"


def _ruta_publicada(archivo: str) -> str:
    """Ruta en disco del COG publicado.

    basename + join, igual que en el resto del modulo: lo que hay en la
    columna arma la ruta, pero nunca puede salir del directorio de rasters.
    """
    return os.path.join(config.DIR_RASTERS, os.path.basename(archivo))


def _peso_mb(archivo: str | None) -> float | None:
    """Tamano del COG, en MB. None si todavia no hay archivo en disco."""
    if not archivo:
        return None
    try:
        return round(os.path.getsize(_ruta_publicada(archivo)) / 1024 / 1024, 1)
    except OSError:
        return None


def _nombre_descarga(nombre: str, archivo: str) -> str:
    """Nombre con el que baja el GeoTIFF.

    El del disco lleva el prefijo aleatorio que le puso nombre_seguro y no
    le dice nada a nadie; se entrega con el nombre que la imagen tiene en
    el visor, sin acentos ni espacios para que sobreviva al viaje a
    Windows, a un celular y a un ArcGIS.
    """
    plano = unicodedata.normalize("NFKD", nombre or "").encode("ascii", "ignore").decode()
    raiz = re.sub(r"[^A-Za-z0-9]+", "-", plano).strip("-").lower()[:60] or "raster"
    return f"{raiz}{os.path.splitext(archivo)[1].lower() or '.tif'}"


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
            "nodata": b.get("noDataValue"),
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
    "azul":     ("b2", "blue", "azul", "sr_b2", "b02"),
    "verde":    ("b3", "green", "verde", "sr_b3", "b03"),
    "rojo":     ("b4", "red", "rojo", "sr_b4", "b04"),
    "nir":      ("b8", "b8a", "nir", "infrarrojo", "sr_b5", "b08", "b08a"),
    "bordeojo": ("b5", "b05", "rededge", "b6", "b06", "b7", "b07"),
    "swir1":    ("b11", "swir1", "sr_b6"),
    "swir2":    ("b12", "swir2", "sr_b7"),
}


def _identificar_bandas(bandas: list[dict], manual: dict | None = None) -> dict:
    """Averigua que indice es el rojo, el verde, el azul y el infrarrojo.

    Por orden de fiabilidad: lo que haya asignado el equipo a mano, luego la
    interpretacion de color que declare el archivo, luego el nombre de las
    bandas y, si nada de eso existe, el apilado habitual de PlanetScope y
    Sentinel-2 (Azul, Verde, Rojo, NIR).

    Ese ultimo caso es una SUPOSICION y se marca como tal en 'origen', porque
    cada mision entrega el apilado en su propio orden: Skysat y buena parte de
    la fotografia aerea van Rojo, Verde, Azul, NIR, justo al reves. Adivinar
    mal intercambia el rojo con el azul y la escena sale azulada. Por eso el
    visor deja corregirlo a mano y avisa cuando lo que hay es una suposicion.
    """
    total = len(bandas)
    existentes = {b["indice"] for b in bandas}

    if manual:
        elegidas = {p: manual.get(p) for p in PAPELES}
        # Un indice fuera de rango se ignora en vez de romper el pintado: la
        # asignacion pudo guardarse antes de volver a medir el archivo.
        elegidas = {p: (i if i in existentes else None) for p, i in elegidas.items()}
        if all(elegidas[p] for p in ("rojo", "verde", "azul")):
            return {**elegidas, "visible": True, "origen": "manual"}

    por_interp: dict[str, int] = {}
    for banda in bandas:
        interp = banda.get("interp", "")
        if interp in ("red", "green", "blue") and interp not in por_interp:
            por_interp[interp] = banda["indice"]

    if {"red", "green", "blue"} <= por_interp.keys():
        rojo, verde, azul = por_interp["red"], por_interp["green"], por_interp["blue"]
        usadas = {rojo, verde, azul}
        nir = next((b["indice"] for b in bandas if b["indice"] not in usadas), None)
        return {"rojo": rojo, "verde": verde, "azul": azul, "nir": nir,
                "swir": None, "visible": True, "origen": "interpretacion"}

    por_nombre: dict[str, int] = {}
    for banda in bandas:
        etiqueta = banda.get("nombre", "").lower()
        for papel, alias in _POR_NOMBRE.items():
            if etiqueta in alias and papel not in por_nombre:
                por_nombre[papel] = banda["indice"]

    if {"rojo", "verde", "azul"} <= por_nombre.keys():
        return {"rojo": por_nombre["rojo"], "verde": por_nombre["verde"],
                "azul": por_nombre["azul"], "nir": por_nombre.get("nir"),
                "swir": por_nombre.get("swir2") or por_nombre.get("swir1"),
                "visible": True, "origen": "nombre"}

    # Productos sin ninguna banda visible: los 20 m de Sentinel-2 traen borde
    # rojo, NIR estrecho y SWIR (B5,B6,B7,B8A,B11,B12). Ahi el color natural no
    # existe; la lectura util es SWIR/NIR/borde rojo, que separa suelo desnudo,
    # humedad y vegetacion, justo lo que interesa tras un sismo.
    swir = por_nombre.get("swir2") or por_nombre.get("swir1")
    if swir and por_nombre.get("nir"):
        return {"rojo": swir, "verde": por_nombre["nir"],
                "azul": por_nombre.get("bordeojo", 1),
                "nir": por_nombre["nir"], "swir": swir, "visible": False,
                "origen": "nombre"}

    if total >= 4:
        return {"rojo": 3, "verde": 2, "azul": 1, "nir": 4, "swir": None,
                "visible": True, "origen": "supuesto"}
    if total == 3:
        return {"rojo": 1, "verde": 2, "azul": 3, "nir": None, "swir": None,
                "visible": True, "origen": "supuesto"}
    return {"rojo": 1, "verde": 1, "azul": 1, "nir": None, "swir": None,
            "visible": True, "origen": "unica"}


def _mismo_rango(combinacion: str, limites: list, bandas: list[dict], balance: str) -> bool:
    """Decide si las tres bandas deben compartir un unico rango de contraste.

    Estirar cada banda a SU propio rango es realce de contraste, no color
    verdadero: rompe la relacion entre bandas y mete un tinte. Con un rango
    comun los colores salen como son... pero solo si las bandas ya estaban en
    la misma escala. Si no lo estaban, el rango comun aplasta a la mas oscura
    y el tinte aparece igual, solo que en el otro sentido: eso es exactamente
    lo que dejaba azulada una escena cuyo rojo llegaba a 17.000 mientras el
    verde llegaba a 29.000.

    Cuando el equipo lo fija a mano se respeta sin mas. En automatico se usa el
    rango comun solo si consta que las bandas son comparables:

      - sus blancos ya caen a menos de un 25% unos de otros, o
      - los valores son de un producto de reflectancia (<=1 en coma flotante,
        <=12.000 en entero, que es la reflectancia por 10.000 con margen para
        las nubes), donde compartir escala es parte de la definicion del dato.
    """
    if balance == "comun":
        return True
    if balance == "banda":
        return False
    if combinacion != "natural":
        return False

    altos = [alto for _, alto in limites]
    if min(altos) >= 0.75 * max(altos):
        return True

    flotante = any((b.get("tipo") or "").lower().startswith("float") for b in bandas)
    return max(altos) <= (1.5 if flotante else 12000)


def _nodata(bandas: list[dict]) -> float | str | None:
    """Valor de relleno, para que los bordes salgan transparentes.

    Sin esto la escena se dibuja sobre un rectangulo negro que tapa lo que
    haya debajo.
    """
    declarado = next((b.get("nodata") for b in bandas if b.get("nodata") is not None), None)
    if declarado is not None:
        return declarado

    tipo = (bandas[0].get("tipo") or "").lower()
    if tipo.startswith("float"):
        # Los productos de reflectancia rellenan con NaN y casi nunca lo
        # declaran. Comprobado en estos Sentinel-2: el pixel de esquina es NaN
        # y el minimo real es 0.002, asi que el cero no aparece como dato
        # valido y buscarlo no serviria de nada.
        return "nan"
    if tipo and tipo != "byte":
        # Enteros de 16 bits: el relleno convencional es 0. En una ortofoto de
        # 8 bits no se asume nada, porque ahi el 0 es negro legitimo.
        return 0
    return None


def _limites(bandas: list[dict], elegidas: list[int]) -> list[tuple]:
    """Percentiles 2/98 de las bandas elegidas, o vacio si falta alguno.

    Un raster de 8 bits ya es visible: estirarlo solo alteraria los colores.
    """
    if not any(b.get("tipo", "").lower() not in ("byte", "") for b in bandas):
        return []

    indexadas = {b["indice"]: b for b in bandas}
    limites = []
    for indice in elegidas:
        banda = indexadas.get(indice, {})
        p2, p98 = banda.get("p2"), banda.get("p98")
        if p2 is None or p98 is None or p98 <= p2:
            return []
        limites.append((p2, p98))
    return limites


def _plan_de_pintado(bandas: list[dict], combinacion: str,
                     manual: dict | None = None, balance: str = "auto") -> dict:
    """Traduce bandas + combinacion a los parametros que entiende TiTiler."""
    if not bandas:
        return {}

    papeles = _identificar_bandas(bandas, manual)

    if combinacion == "gris" or len(bandas) == 1:
        elegidas = [bandas[0]["indice"]]
    elif (combinacion == "swir" and papeles["swir"] and papeles["nir"]
          and papeles["visible"]):
        # Solo tiene sentido como alternativa cuando SI hay bandas visibles.
        # Sin ellas, la composicion por defecto ya es esta.
        elegidas = [papeles["swir"], papeles["nir"], papeles["rojo"]]
    elif combinacion == "infrarrojo" and papeles["nir"] and papeles["visible"]:
        # NIR en el canal rojo: asi la vegetacion sana se ve roja, que es la
        # lectura estandar de una composicion en falso color.
        elegidas = [papeles["nir"], papeles["rojo"], papeles["verde"]]
    else:
        elegidas = [papeles["rojo"], papeles["verde"], papeles["azul"]]

    plan: dict = {"bidx": elegidas}

    limites = _limites(bandas, elegidas)
    if limites:
        if len(limites) == 3 and _mismo_rango(combinacion, limites, bandas, balance):
            bajo = min(p2 for p2, _ in limites)
            alto = max(p98 for _, p98 in limites)
            plan["rescale"] = [f"{bajo},{alto}"] * len(limites)
        else:
            plan["rescale"] = [f"{p2},{p98}" for p2, p98 in limites]

    relleno = _nodata(bandas)
    if relleno is not None:
        plan["nodata"] = relleno

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
        "       autor, creado_en, combinacion, bandas, papeles, balance, archivo "
        "FROM rasters ORDER BY orden NULLS LAST, id"
    )
    salida = []
    for f in filas:
        dato = dict(f)
        # El peso va rotulado en el boton de descarga: sobre el terreno no
        # se decide igual bajar 40 MB que 1,8 GB, y hay que saberlo ANTES de
        # pulsar. El nombre del archivo en disco no sale de aqui.
        dato["mb"] = _peso_mb(dato.pop("archivo", None))
        bandas = json.loads(dato.pop("bandas") or "[]")
        manual = json.loads(dato["papeles"]) if dato["papeles"] else None
        dato["balance"] = dato["balance"] or "auto"
        papeles = _identificar_bandas(bandas, manual) if bandas else {}

        dato["num_bandas"] = len(bandas)
        dato["papeles"] = papeles
        # Lo que el archivo declara de cada banda, para que el panel de ajuste
        # pueda decir "Banda 3 -- B4" en vez de solo "Banda 3".
        dato["detalle_bandas"] = [
            {"indice": b["indice"], "nombre": b.get("nombre") or "",
             "interp": b.get("interp") or ""}
            for b in bandas
        ]

        # Huella del plan de pintado. Viaja en la URL de las teselas para que
        # cualquier cambio en como se pinta el raster invalide lo que el
        # navegador tenga guardado. Sin esto, arreglar el pintado no sirve de
        # nada durante las 24 horas que dura la cache.
        plan = (_plan_de_pintado(bandas, dato["combinacion"], manual, dato["balance"])
                if bandas else {})
        dato["render"] = hashlib.sha1(
            json.dumps(plan, sort_keys=True, default=str).encode()).hexdigest()[:10]
        # Que reparto de contraste quedo en efecto, para poder mostrarlo cuando
        # esta en automatico.
        escalas = plan.get("rescale") or []
        dato["mismo_rango"] = len(escalas) == 3 and len(set(escalas)) == 1
        # Una ortofoto de 8 bits ya es visible y no se estira: ahi el reparto
        # de contraste no hace nada y el visor no debe ofrecerlo.
        dato["estirable"] = bool(escalas)
        # El visor solo necesita saber que combinaciones ofrecer.
        dato["admite_infrarrojo"] = bool(papeles.get("nir")) and papeles.get("visible", True)
        dato["admite_swir"] = (bool(papeles.get("swir")) and bool(papeles.get("nir"))
                               and papeles.get("visible", True))
        dato["tiene_visible"] = papeles.get("visible", True)
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


@router.put("/{id_raster}/bandas")
async def asignar_bandas(id_raster: int, entrada: BandasEntrada):
    """Fija a mano que banda es cual, y como repartir el contraste.

    Se guarda en el servidor, no en cada navegador: que banda es el rojo es un
    hecho del archivo, no una preferencia. Si cada quien lo ajustara por su
    cuenta, el equipo compararia capturas de la misma escena con colores
    distintos.
    """
    if entrada.balance not in BALANCES:
        raise HTTPException(status_code=400, detail=f"balance debe ser uno de {BALANCES}")

    fila = await db.pool().fetchrow("SELECT bandas FROM rasters WHERE id=$1", id_raster)
    if fila is None:
        raise HTTPException(status_code=404, detail="Raster no encontrado")

    papeles = None
    if entrada.papeles:
        total = len(json.loads(fila["bandas"] or "[]"))
        limpio: dict[str, int] = {}
        for papel, indice in entrada.papeles.items():
            if papel not in PAPELES:
                raise HTTPException(status_code=400, detail=f"Papel desconocido: {papel}")
            if indice is None:
                continue
            if not 1 <= indice <= total:
                raise HTTPException(
                    status_code=400,
                    detail=f"La banda {indice} no existe: el archivo tiene {total}")
            limpio[papel] = indice
        faltan = [p for p in ("rojo", "verde", "azul") if p not in limpio]
        if faltan:
            raise HTTPException(status_code=400,
                                detail=f"Falta asignar: {', '.join(faltan)}")
        papeles = limpio

    await db.pool().execute(
        "UPDATE rasters SET papeles=$2::jsonb, balance=$3 WHERE id=$1",
        id_raster, json.dumps(papeles) if papeles else None, entrada.balance,
    )
    return {"ok": True, "papeles": papeles, "balance": entrada.balance}


@router.get("/{id_raster}/vista.png")
async def vista(id_raster: int, banda: int | None = None, c: str | None = None):
    """Miniatura de la escena completa: de una banda suelta, o de la composicion.

    Es la herramienta que hace contestable la pregunta "cual de estas cuatro es
    el rojo". Vista en gris, el infrarrojo se reconoce de un vistazo porque la
    vegetacion sale clara y el asfalto oscuro, y el azul porque tiene poco
    contraste. Sin esto, asignar bandas a mano seria adivinar a ciegas.
    """
    fila = await db.pool().fetchrow(
        "SELECT archivo, bandas, combinacion, papeles, balance "
        "FROM rasters WHERE id=$1 AND estado='listo'", id_raster)
    if fila is None or not fila["archivo"]:
        raise HTTPException(status_code=404, detail="Raster no disponible")

    bandas = json.loads(fila["bandas"] or "[]")
    ruta = os.path.join(config.DIR_RASTERS, os.path.basename(fila["archivo"]))
    # La compuesta se mira para decidir si el color quedo bien, y a 220 px una
    # ciudad se promedia hasta parecer oscura y sin color. Las de cada banda
    # solo tienen que dejar reconocer la banda, y ahi 200 px sobran.
    parametros: dict = {"url": ruta, "max_size": 200 if banda is not None else 560}

    if banda is not None:
        if not any(b["indice"] == banda for b in bandas):
            raise HTTPException(status_code=404, detail="Esa banda no existe")
        parametros["bidx"] = [banda]
        # Cada banda a su propio rango: aqui no se busca color fiel sino
        # reconocer la banda, y para eso hace falta todo el contraste posible.
        limites = _limites(bandas, [banda])
        if limites:
            parametros["rescale"] = [f"{limites[0][0]},{limites[0][1]}"]
        relleno = _nodata(bandas)
        if relleno is not None:
            parametros["nodata"] = relleno
    else:
        manual = json.loads(fila["papeles"]) if fila["papeles"] else None
        combinacion = c if c in COMBINACIONES else fila["combinacion"]
        parametros.update(
            _plan_de_pintado(bandas, combinacion, manual, fila["balance"] or "auto"))

    try:
        respuesta = await _cliente.get(
            f"{config.TITILER_URL}/cog/preview.png", params=parametros, timeout=120.0)
    except httpx.HTTPError as excepcion:
        raise HTTPException(status_code=502, detail=f"TiTiler no responde: {excepcion}") from excepcion

    if respuesta.status_code != 200:
        raise HTTPException(status_code=502,
                            detail=f"No se pudo pintar la vista: {respuesta.text[:200]}")

    return Response(
        content=respuesta.content,
        media_type=respuesta.headers.get("content-type", "image/png"),
        # Corta: se mira mientras se ajusta, y el ajuste cambia lo que muestra.
        headers={"Cache-Control": "private, max-age=60"},
    )


@router.get("/{id_raster}/descargar")
async def descargar(id_raster: int):
    """Entrega el COG publicado tal cual.

    Es el archivo YA convertido, no el que se subio: georreferenciado, con
    piramides y utilizable en QGIS o ArcGIS sin ningun paso previo.

    Va por FileResponse y no por Response: lo manda en trozos y con
    Content-Length, asi el navegador muestra progreso y admite reanudar en
    vez de parecer colgado durante los cientos de MB que pesa una escena.
    """
    fila = await db.pool().fetchrow(
        "SELECT nombre, archivo, estado FROM rasters WHERE id=$1", id_raster)
    if fila is None:
        raise HTTPException(status_code=404, detail="Raster no encontrado")
    # 409 y no 404: la imagen existe, lo que pasa es que aun se esta
    # convirtiendo o fallo. El visor lo distingue para decir cual es.
    if fila["estado"] != "listo" or not fila["archivo"]:
        raise HTTPException(
            status_code=409,
            detail="Esa imagen todavia no esta lista para descargar")

    ruta = _ruta_publicada(fila["archivo"])
    if not os.path.isfile(ruta):
        raise HTTPException(
            status_code=404, detail="El archivo ya no esta en el servidor")

    return FileResponse(
        ruta,
        media_type="image/tiff",
        filename=_nombre_descarga(fila["nombre"], fila["archivo"]),
    )


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
        "SELECT archivo, bandas, combinacion, papeles, balance "
        "FROM rasters WHERE id=$1 AND estado='listo'",
        id_raster)
    if fila is None or not fila["archivo"]:
        raise HTTPException(status_code=404, detail="Raster no disponible")

    combinacion = c if c in COMBINACIONES else fila["combinacion"]
    bandas = json.loads(fila["bandas"] or "[]")
    manual = json.loads(fila["papeles"]) if fila["papeles"] else None
    ruta_local = os.path.join(config.DIR_RASTERS, os.path.basename(fila["archivo"]))
    parametros: dict = {
        "url": ruta_local,
        **_plan_de_pintado(bandas, combinacion, manual, fila["balance"] or "auto"),
    }

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
