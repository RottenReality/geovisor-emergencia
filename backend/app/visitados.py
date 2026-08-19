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


# Las seis claves de dano vienen en los 413 casos, asi que son seis columnas
# fijas. Se guarda la etiqueta (Ninguno/Leve/Moderado/Severo), que ya es
# legible y evita tener que arrastrar un diccionario de codigos a la ficha.
DANOS = {
    "damageWallsFacades": "dano_muros_fachadas",
    "damagePartitions": "dano_divisiones",
    "damageCeilings": "dano_cielos",
    "damageRoof": "dano_cubierta",
    "damageStairs": "dano_escaleras",
    "damagePublicServices": "dano_servicios",
}

# De donde salio la posicion. Es lo unico que aporta placeId; el resto es un
# identificador opaco de Google que no le dice nada a nadie.
ORIGENES = ("arcgis", "verified", "manual", "recovered-from-arcgis-merge")


def origen(place_id) -> str | None:
    if not isinstance(place_id, str) or not place_id:
        return None
    prefijo = place_id.split(":")[0]
    return prefijo if prefijo in ORIGENES else "google"


def _numero(valor):
    """True es un int en Python, y como coordenada daria un punto en el ecuador."""
    return isinstance(valor, (int, float)) and not isinstance(valor, bool)


def _danos(lista) -> dict:
    """Las seis claves conocidas a sus seis propiedades.

    Siempre salen las seis, aunque no haya dato: si las columnas aparecen y
    desaparecen segun el caso, la tabla de atributos cambia de forma entre
    recargas y deja de poder compararse.
    """
    salida = {nombre: None for nombre in DANOS.values()}
    for dano in lista or []:
        if not isinstance(dano, dict):
            continue
        clave = dano.get("clave")
        if not clave:
            continue
        # Una clave nueva no se pierde en silencio: entra con su propio nombre.
        salida[DANOS.get(clave, f"dano_{clave}")] = (
            dano.get("valorEtiqueta") or dano.get("valor"))
    return salida


def _uno(caso: dict) -> dict:
    evaluacion = caso.get("evaluacion") or {}
    mensajes = [m for m in (caso.get("mensajes") or []) if isinstance(m, dict)]
    fechas_mensajes = [m.get("creado_utc") for m in mensajes
                       if _numero(m.get("creado_utc"))]

    propiedades = {
        # Ubicacion e identificacion
        "id": caso.get("id"),
        "direccion": caso.get("direccion"),
        "barrio": caso.get("barrio"),
        "comuna": caso.get("comunaEtiqueta"),
        "resumen_unidad": caso.get("resumenUnidad"),
        "origen_coordenadas": origen(caso.get("placeId")),

        # Evaluacion. El tipo de colapso es el de la evaluacion, no el del
        # ingreso: el primero lo verifico un tecnico en sitio.
        "colapso": evaluacion.get("tipoColapso"),
        "colapso_etiqueta": evaluacion.get("tipoColapsoEtiqueta"),
        "habitabilidad": evaluacion.get("habitabilidadEtiqueta"),
        "concepto_tecnico": evaluacion.get("conceptoTecnico"),
        "visita_especializada": evaluacion.get("aspectosVisitaEspecializada"),
        "alcance_inspeccion": evaluacion.get("alcanceInspeccionEtiqueta"),
        "evaluado": fecha(evaluacion.get("creado_utc")),

        # Inmueble
        "tipo_inmueble": de(caso, "inmueble", "tipoInmuebleEtiqueta"),
        "edificio": de(caso, "inmueble", "nombreEdificio"),
        "apartamento": de(caso, "inmueble", "numeroApartamento"),
        "casa": de(caso, "inmueble", "numeroCasa"),
        "edificio_completo": de(caso, "inmueble", "edificioCompleto"),
        "pisos_sobre_nivel": evaluacion.get("pisosSobreNivel"),
        "sotanos": evaluacion.get("sotanos"),
        "anio_construccion": evaluacion.get("anioConstruccionEtiqueta"),

        # Victimas
        "fallecidos": de(evaluacion, "victimas", "fallecidos"),
        "atrapados": de(evaluacion, "victimas", "atrapados"),
        "rescatados": de(evaluacion, "victimas", "rescatados"),
        "evacuados": de(evaluacion, "victimas", "evacuados"),
        "por_evacuar": de(evaluacion, "victimas", "porEvacuar"),
        "necesita_evacuacion": de(evaluacion, "victimas", "necesitaEvacuacion"),

        # Ingreso, tal como se reporto al principio
        "ingreso_descripcion": de(caso, "ingreso", "descripcion"),
        "ingreso_colapso": de(caso, "ingreso", "tipoColapsoEtiqueta"),
        "ingreso_estado": de(caso, "ingreso", "estadoEtiqueta"),
        "ingreso_creado": fecha(de(caso, "ingreso", "creado_utc")),
        "ingreso_enviado": fecha(de(caso, "ingreso", "enviado_utc")),

        # Personas. Decision explicita del equipo, documentada en la spec y en
        # la cabecera de fuentes.py. El contacto viene repetido en tres sitios
        # con el mismo contenido; se toma el de la raiz, que es el efectivo.
        "contacto_nombre": de(caso, "contacto", "nombre"),
        "contacto_telefono": de(caso, "contacto", "telefono"),
        "contacto_cedula": de(caso, "contacto", "cedula"),
        "tecnico_nombre": de(caso, "tecnicoVerificacion", "nombre"),
        "tecnico_correo": de(caso, "tecnicoVerificacion", "correo"),
        "tecnico_profesion": de(caso, "tecnicoVerificacion", "profesion"),
        "tecnico_cedula": de(caso, "tecnicoVerificacion", "cedula"),
        "tecnico_telefono": de(caso, "tecnicoVerificacion", "telefono"),
        "tecnico_matricula": de(caso, "tecnicoVerificacion", "matriculaProfesional"),
        "tecnico_enfasis": de(caso, "tecnicoVerificacion", "enfasis"),
        "tecnico_anos_experiencia": de(caso, "tecnicoVerificacion", "anosExperiencia"),
        "operario_nombre": de(caso, "operarioIngreso", "nombre"),
        "operario_correo": de(caso, "operarioIngreso", "correo"),
        "verificacion_asignada": fecha(caso.get("verificacion_asignada_utc")),

        # Conversacion: cuanta hay y de cuando es la ultima, no el hilo. Es
        # texto libre de longitud impredecible y la ficha no sabe pintarlo.
        "mensajes_cantidad": len(mensajes),
        "mensajes_ultimo": fecha(max(fechas_mensajes) if fechas_mensajes else None),
    }
    propiedades.update(_danos(evaluacion.get("danos")))

    lat, lon = caso.get("lat"), caso.get("lng")
    ubicado = _numero(lat) and _numero(lon)
    return {
        "geometry": {"type": "Point", "coordinates": [lon, lat]} if ubicado else None,
        "properties": propiedades,
    }


def aplanar(respuesta) -> list[dict]:
    """La respuesta entera a la lista que espera _coleccion() de externas.py."""
    casos = (respuesta or {}).get("casos") or []
    return [_uno(caso) for caso in casos if isinstance(caso, dict)]
