"""Fechas legibles a partir del epoch que devuelven las fuentes externas.

Casi todas mandan los instantes como un entero de milisegundos desde 1970:
ArcGIS lo hace siempre, y la API de la Alcaldia de Cali tambien. Un numero de
trece cifras no le dice nada a quien esta mirando el mapa, y tanto la ficha
como la tabla de atributos muestran los valores tal cual llegan.

Modulo aparte y sin dependencias para poder probarlo sin red ni base. Lo usan
el catalogo de fuentes externas y el aplanado de Visitados criticos.
"""
import datetime

# Colombia no cambia la hora en todo el ano, asi que el desfase es fijo.
COLOMBIA = datetime.timezone(datetime.timedelta(hours=-5))

# Formato ordenable como texto: asi la tabla de atributos sigue pudiendo
# ordenar por fecha aunque el valor ya no sea un numero.
FORMATO = "%Y-%m-%d %H:%M"


def legible(ms) -> str | None:
    """Milisegundos UTC a fecha y hora de Colombia. None si no es un instante.

    Devuelve None en vez de lanzar: estos valores vienen de servicios ajenos
    que durante una emergencia mandan de todo, y una capa entera no puede
    caerse porque un registro traiga texto donde deberia haber un numero.
    """
    # bool es subclase de int en Python: sin esta guarda, True saldria como
    # 1970-01-01 y pareceria un dato real.
    if isinstance(ms, bool) or not isinstance(ms, (int, float)):
        return None
    try:
        return datetime.datetime.fromtimestamp(ms / 1000, COLOMBIA).strftime(FORMATO)
    except (OverflowError, OSError, ValueError):
        # Fuera del rango representable. Pasa con centinelas tipo 0 o -1 y con
        # campos que en realidad no eran fechas.
        return None
