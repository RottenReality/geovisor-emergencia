"""Logica de la pila de capas. Sin base de datos a proposito.

Aqui vive lo unico de este subsistema donde un error es silencioso: si el
aplanado se equivoca, el mapa queda mal apilado y no hay mensaje de error que
lo delate. Al no tocar Postgres se puede probar entero en un segundo.

Vocabulario:

  entrada   {clave, grupo_id, orden}. Una fila de la tabla `pila`.
  clave     'capa-13' | 'raster-6' | 'ext-ungrd-ede' | 'grupo-2'
  arbol     nivel superior en orden, con cada grupo expandido en su sitio
  aplanar   el arbol reducido a la lista de capas, de abajo arriba

Todo va SIEMPRE de abajo arriba: el ultimo elemento es el que se dibuja
encima. El panel lo pinta al reves, que es la convencion de QGIS.
"""

# Separacion entre dos posiciones consecutivas al sembrar. Deja hueco para
# intercalar sin renumerar, aunque hoy mover solo intercambia dos valores.
PASO = 10

PREFIJO_GRUPO = "grupo-"


def es_grupo(clave: str) -> bool:
    return clave.startswith(PREFIJO_GRUPO)


def id_de_grupo(clave: str) -> int:
    return int(clave[len(PREFIJO_GRUPO):])


def _ordenadas(entradas: list[dict]) -> list[dict]:
    # Desempate por clave: dos filas con el mismo orden deben salir siempre
    # igual, o la lista bailaria entre recargas sin que nadie toque nada.
    return sorted(entradas, key=lambda f: (f["orden"], f["clave"]))


def arbol(entradas: list[dict]) -> list[dict]:
    """Nivel superior en orden, con los grupos expandidos."""
    grupos_presentes = {id_de_grupo(f["clave"]) for f in entradas if es_grupo(f["clave"])}

    hijos: dict[int, list[dict]] = {}
    superiores: list[dict] = []
    for fila in entradas:
        grupo = fila["grupo_id"]
        # Un hijo cuyo grupo ya no existe sale al nivel superior. Dejarlo
        # colgando lo haria desaparecer del panel y del mapa sin aviso.
        if grupo is None or grupo not in grupos_presentes:
            superiores.append(fila)
        else:
            hijos.setdefault(grupo, []).append(fila)

    nodos = []
    for fila in _ordenadas(superiores):
        nodo = dict(fila)
        nodo["grupo_id"] = None
        nodo["hijos"] = (_ordenadas(hijos.get(id_de_grupo(fila["clave"]), []))
                         if es_grupo(fila["clave"]) else None)
        nodos.append(nodo)
    return nodos


def aplanar(entradas: list[dict]) -> list[str]:
    """Solo las capas, de abajo arriba. Los grupos no se dibujan."""
    salida: list[str] = []
    for nodo in arbol(entradas):
        if nodo["hijos"] is None:
            salida.append(nodo["clave"])
        else:
            salida.extend(h["clave"] for h in nodo["hijos"])
    return salida


def sembrar(claves_rasters: list[str], claves_capas: list[str]) -> list[dict]:
    """Orden inicial que reproduce lo que el equipo ve hoy.

    Las imagenes debajo y el dibujo encima, que es la disposicion fija que
    tenia el visor antes de que existiera la pila. Nadie debe encontrarse el
    mapa cambiado el dia del despliegue.
    """
    return [{"clave": clave, "grupo_id": None, "orden": (i + 1) * PASO}
            for i, clave in enumerate([*claves_rasters, *claves_capas])]


def vecino(entradas: list[dict], clave: str, direccion: str) -> str | None:
    """Con quien intercambia `clave` al moverse. None si esta en el borde.

    Solo entre hermanos: dentro del grupo si esta en uno, en el nivel superior
    si esta suelta. Mover NUNCA saca una capa de su grupo ni la mete en otro;
    para eso esta `agrupar`.
    """
    fila = next((f for f in entradas if f["clave"] == clave), None)
    if fila is None:
        return None

    grupos_presentes = {id_de_grupo(f["clave"]) for f in entradas if es_grupo(f["clave"])}
    suyo = fila["grupo_id"] if fila["grupo_id"] in grupos_presentes else None

    hermanos = _ordenadas([
        f for f in entradas
        if (f["grupo_id"] if f["grupo_id"] in grupos_presentes else None) == suyo
    ])
    posicion = next(i for i, f in enumerate(hermanos) if f["clave"] == clave)
    destino = posicion + (1 if direccion == "subir" else -1)
    if destino < 0 or destino >= len(hermanos):
        return None
    return hermanos[destino]["clave"]
