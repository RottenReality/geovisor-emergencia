"""Aplanado de la API de Visitados criticos de la Alcaldia de Cali.

Sin base de datos y sin red a proposito. La respuesta viene anidada a tres
niveles y con bloques que pueden faltar enteros; convertirla en un punto plano
es justo el sitio donde un error pasa desapercibido, porque un campo mal leido
no rompe nada: se queda vacio para siempre y nadie se entera. Al no tocar la
red se prueba entero en un segundo.

El detalle de que campo sale de donde esta en la spec:
docs/superpowers/specs/2026-08-19-visitados-criticos-design.md
"""
import datetime

# Colombia no cambia la hora en todo el ano, asi que el desfase es fijo.
COLOMBIA = datetime.timezone(datetime.timedelta(hours=-5))


def fecha(ms) -> str | None:
    """Milisegundos UTC a fecha legible en hora de Colombia.

    La API lo da todo en epoch. Un numero de trece cifras no le dice nada a
    quien esta mirando el mapa, y la ficha muestra los valores tal cual.
    """
    # bool es subclase de int en Python: sin esta guarda, True saldria como
    # 1970-01-01 y pareceria un dato real.
    if isinstance(ms, bool) or not isinstance(ms, (int, float)):
        return None
    return datetime.datetime.fromtimestamp(ms / 1000, COLOMBIA).strftime("%Y-%m-%d %H:%M")


def de(objeto, *ruta):
    """Lee una ruta anidada tolerando que cualquier tramo falte o sea nulo.

    83 casos de 413 no traen tecnico y 51 no traen operario: que un bloque
    entero sea None es lo normal aqui, no una anomalia.
    """
    for parte in ruta:
        if not isinstance(objeto, dict):
            return None
        objeto = objeto.get(parte)
    return objeto
