"""Modelos 3D propios: catalogo y colocacion sobre el mapa.

Que son
-------
Vuelos de dron procesados en DJI Terra y exportados como 3D Tiles, el estandar
OGC que popularizo Cesium: un arbol de teselas .b3dm con doce niveles de
detalle. No es una nube de puntos sino una malla texturizada -triangulos con
las fotos pegadas encima-, que es lo que permite reconocer una grieta.

Por que estan aqui y no en `externas`
-------------------------------------
No hay servicio que consultar: los archivos viven en /datos y se sirven tal
cual. Lo unico que hay que calcular es donde se apoyan, y eso es este modulo.
Va aparte de `importar_catastro` y compania por la misma razon que `catastro`:
aqui no se importa nada de fuera, solo se lee lo que ya esta en disco.

Modulo PURO a proposito: sin asyncpg ni httpx, para que las pruebas corran sin
tener instaladas las dependencias del servidor. La parte de disco y HTTP esta
en routers/modelos.py.

El problema de la altura
------------------------
Un tileset de DJI Terra viene georreferenciado en ECEF y a su altura real
sobre el elipsoide. El Cristo Rey esta a 1.483 m. Pero MapLibre y deck.gl
ponen el suelo en 0 m y atan la altura de la camara al zoom: a zoom 16 la
camara esta a unos 700 m, o sea POR DEBAJO del modelo, que queda flotando
sobre la cabeza del que mira. No da ningun error; la pantalla sale negra.
Medido: a zoom 16 se descargaban 26 teselas y se dibujaban 0.

MapLibre 5 tiene `setCenterElevation`, que arreglaria justo esto, pero la
superposicion de deck.gl no la sigue: mantiene su propia camara y se queda
igual de ciega. Comprobado tambien.

Asi que el modelo se baja: se le mete una traslacion en el tile RAIZ, que en
3D Tiles se propaga a los hijos Y a sus volumenes de acotacion, de modo que el
descarte por frustum sigue siendo correcto. Se hace al servir, sobre una copia
en memoria del tileset.json; los archivos del disco no se tocan nunca.

`altura_base` es la altura elipsoidal que pasa a valer cero. No se pone la del
centro del modelo sino la de la zona que se va a mirar -la explanada, no el
fondo de la ladera-, porque es la que tiene que quedar bajo la camara. La
diferencia importa: con la del centro (1.426 m) la explanada quedaba 57 m por
encima del suelo y volvia a taparse a partir de zoom 20.

Lo que se pierde son las alturas absolutas de la escena; las relativas dentro
del modelo quedan intactas. Como el mapa base es plano, es el cambio correcto.
Para que una anotacion se guarde con su altura de verdad, `altura_base` se le
vuelve a sumar antes de mandarla a la base: ver `altura_real`.
"""
import math
from dataclasses import dataclass

# WGS84.
_A = 6378137.0
_F = 1 / 298.257223563
_B = _A * (1 - _F)
_E2 = _F * (2 - _F)
_EP2 = (_A * _A - _B * _B) / (_B * _B)


@dataclass(frozen=True)
class Modelo:
    """Un modelo 3D servido desde /datos/modelos/<carpeta>."""
    clave: str
    carpeta: str
    # Ruta del tileset.json que genero DJI Terra, dentro de la carpeta.
    raiz: str
    # Altura elipsoidal, en metros, que pasa a ser el cero del mapa.
    altura_base: float
    # Centro y encuadre, para el boton «Ir a la capa».
    centro: tuple[float, float]
    caja: tuple[float, float, float, float]   # oeste, sur, este, norte
    # Metros por pixel del vuelo, para poder decirlo en el panel.
    resolucion_cm: float = 0.0
    # Zoom al que aterriza «Ir a la capa».
    #
    # No es el mismo que zoom_min. Por debajo de zoom_min no se pide nada,
    # pero llegar justo ahi deja el modelo en su nivel mas basto -una mancha
    # parda sin textura- y la primera impresion es que esta roto. A 18 el
    # vuelo llena la pantalla y ya se distinguen los techos.
    zoom_llegada: float = 18.0
    # Cuanto detalle se pide para lo que se ve de lejos.
    #
    # Va a parar a `viewDistanceScale` de la libreria, que multiplica la
    # distancia aparente al elegir el nivel: mas alto, mas detalle. Con 1 -lo
    # de serie- mirar el monumento entero desde arriba traia TRES teselas y se
    # veia una mancha parda; con 3, veintisiete, y se distinguen los senderos
    # y los arboles.
    #
    # Estuvo en 5 dos veces y las dos hubo que bajarlo. Lo que decide es
    # cuanto pesa mirar una vez, y a este vuelo le pesa mucho: medido en el
    # visor de verdad, quieto a zoom 19 en ventana de 1.400 x 850 y esperando
    # a que no quede nada por cargar,
    #
    #     detalle 3 -> 198 teselas,  50 MB de descarga, 185 MB en la tarjeta
    #     detalle 4 -> 244 teselas,  63 MB,             260 MB
    #     detalle 5 -> 296 teselas,  76 MB,             363 MB
    #
    # Con el enlace del equipo medido en el log -unos 3,6 MB/s- eso son 14 s
    # contra 21 s de espera hasta ver el vuelo nitido, cada vez que alguien se
    # mueve. Se elige 3: la diferencia de nitidez frente a 5 se ve en una
    # captura al lado de la otra, pero no compensa esperar la mitad mas.
    #
    # OJO con como se prueba esto: el banco corre con el renderizador por
    # SOFTWARE de Chrome, que se queda sin memoria de texturas alrededor de
    # los 200 MB y entonces dibuja la malla de un salmon liso -parecido a lo
    # que el equipo llama «faltan trozos», pero por otro motivo-. Con GPU de
    # verdad, las tres se ven bien. O sea que ese techo es el suelo de lo que
    # aguanta cualquier maquina, no una medida de las del equipo: no sirve
    # para elegir el numero, solo para saber que con 3 se ve hasta sin GPU.
    #
    # Y NO se toca `maximumScreenSpaceError` desde `options`: la libreria lo
    # copia UNA vez al construirse, en el campo `memoryAdjustedScreenSpaceError`,
    # y despues lee el campo. Cambiar la opcion no mueve nada -de ahi el
    # barrido de 16 a 1 sin que cambiara una sola tesela-. `viewDistanceScale`
    # si se lee en cada recorrido, y hace exactamente lo mismo.
    detalle: float = 3.0
    # Presupuesto de cache de la malla, en MB.
    #
    # No es cuanta memoria se gasta sino a partir de cuanta la libreria
    # empieza a soltar teselas. Nunca suelta las que se estan viendo: suelta
    # las que se acaban de dejar de ver, que son justo las que vuelven a
    # hacer falta al girar.
    #
    # AQUI ESTABAN LAS MANCHAS. Este numero llevaba desde el principio sin
    # llegar a la libreria: el navegador lo ponia en `options`, y el objeto
    # declara `maximumMemoryUsage = 32` como campo propio y no lo copia nunca
    # desde ahi. O sea que 128, 256, 384 y 512 eran todos 32, y por eso
    # ninguno cambio nada. Corregido en modelo3d.js.
    #
    # Con 32 MB de verdad, la malla que se esta viendo ya pesa el doble o el
    # triple, asi que la libreria soltaba TODO lo que no estuviera en pantalla
    # en ese fotograma. Al girar, esas teselas volvian a hacer falta, no habian
    # llegado todavia, y mientras tanto se dibujaba en su lugar el nivel basto
    # del que cuelgan: una mancha lisa color salmon sobre la ladera.
    #
    # Medido con el mismo recorrido de camara -llegar, dar la vuelta, acercar
    # a zoom 19, alejar y volver-, ventana de 1.600 x 900 y detalle 5:
    #
    #     32 MB (lo que corria) -> 238 teselas descargadas, 166 soltadas
    #     384 MB                -> 146 descargadas, 0 soltadas
    #
    # O sea que descargaba MAS y ensenaba PEOR: se pasaba el rato volviendo a
    # pedir lo que acababa de tirar.
    #
    # Se queda en 256 y no en 384 porque con detalle 3 una vista de cerca usa
    # 185 MB: 256 deja margen de sobra para girar sin volver a pedir nada -que
    # es para lo que sirve la cache- sin reservar memoria de video que nadie
    # va a usar. Si algun dia se sube el detalle, hay que subir esto con el.
    memoria_mb: int = 256


MODELOS: tuple[Modelo, ...] = (
    Modelo(
        clave="modelo-cristo-rey",
        carpeta="cristo-rey",
        raiz="tileset.json",
        # La explanada del monumento. El modelo entero va de 1.340 a 1.512 m.
        altura_base=1483.0,
        centro=(-76.564498, 3.435738),
        caja=(-76.566948, 3.433575, -76.562047, 3.437902),
        resolucion_cm=2.0,
        zoom_llegada=18.0,
        detalle=3.0,
        memoria_mb=256,
    ),
)

POR_CLAVE = {m.clave: m for m in MODELOS}


# ---------------------------------------------------------------------------
# Geodesia
# ---------------------------------------------------------------------------
def a_geodesica(x: float, y: float, z: float) -> tuple[float, float, float]:
    """ECEF -> (longitud, latitud, altura elipsoidal), en grados y metros."""
    lon = math.atan2(y, x)
    p = math.hypot(x, y)
    theta = math.atan2(z * _A, p * _B)
    lat = math.atan2(z + _EP2 * _B * math.sin(theta) ** 3,
                     p - _E2 * _A * math.cos(theta) ** 3)
    n = _A / math.sqrt(1 - _E2 * math.sin(lat) ** 2)
    return math.degrees(lon), math.degrees(lat), p / math.cos(lat) - n


def _vertical(centro: tuple[float, float, float]) -> tuple[float, float, float]:
    """Vector unitario que apunta al cenit en un punto ECEF.

    La normal al elipsoide, NO el radial geocentrico. Los dos parecen «hacia
    arriba» y difieren en decimas de grado, pero bajar 1.483 m por el radial
    corre el modelo entero 57 cm hacia el ecuador: medido, no estimado. Sobre
    un vuelo de 2 cm de resolucion con el que se van a senalar grietas y
    cruzarlas contra el catastro, medio metro de sesgo no es despreciable.

    Por definicion de coordenada geodesica, moverse por la normal cambia la
    altura y deja la longitud y la latitud intactas.
    """
    lon, lat, _ = a_geodesica(*centro)
    lon, lat = math.radians(lon), math.radians(lat)
    return (math.cos(lat) * math.cos(lon),
            math.cos(lat) * math.sin(lon),
            math.sin(lat))


def altura_del_tileset(tileset: dict) -> float:
    """Altura elipsoidal del centro del tileset, en metros.

    Sirve de valor por defecto razonable cuando nadie ha calibrado el modelo
    todavia: deja el centro a ras de suelo, que es mejor que dejarlo a 1.500 m.
    """
    centro = _centro_ecef(tileset)
    return a_geodesica(*centro)[2]


def _centro_ecef(tileset: dict) -> tuple[float, float, float]:
    caja = (tileset.get("root") or {}).get("boundingVolume", {}).get("box")
    if not caja or len(caja) < 3:
        raise ValueError("el tileset no trae un boundingVolume.box en la raiz")
    return (caja[0], caja[1], caja[2])


def raiz_apoyada(tileset: dict, altura_base: float) -> dict:
    """Copia del tileset con el modelo bajado para que se pueda mirar.

    Devuelve una copia superficial con el `transform` puesto en el tile raiz.
    No modifica el original.
    """
    if not isinstance(tileset, dict) or "root" not in tileset:
        raise ValueError("no parece un tileset.json de 3D Tiles")

    arriba = _vertical(_centro_ecef(tileset))
    dx, dy, dz = (-altura_base * c for c in arriba)

    raiz = dict(tileset["root"])
    # Columna-mayor, como manda glTF: identidad mas traslacion. Se ignora
    # cualquier transform que ya trajera la raiz porque los tilesets de Terra
    # no ponen ninguno ahi -lo llevan los hijos, y ese se compone debajo.
    raiz["transform"] = [1.0, 0.0, 0.0, 0.0,
                         0.0, 1.0, 0.0, 0.0,
                         0.0, 0.0, 1.0, 0.0,
                         dx, dy, dz, 1.0]
    copia = dict(tileset)
    copia["root"] = raiz
    return copia


def altura_real(modelo: Modelo, z: float) -> float:
    """Deshace el apoyo: de la z que ve el navegador a altura elipsoidal.

    Lo que el navegador recoge al marcar una grieta es una z relativa al plano
    del mapa. Guardarla asi haria que la anotacion dejase de cuadrar en cuanto
    alguien recalibrase `altura_base`. Se guarda la altura de verdad.
    """
    return z + modelo.altura_base
