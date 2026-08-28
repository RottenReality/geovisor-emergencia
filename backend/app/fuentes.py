"""Catalogo de fuentes externas de la emergencia.

Que es esto
-----------
Una lista fija de servicios publicos (IGAC, Esri Colombia, Copernicus, GDACS,
HDX y otros) que el visor consulta EN VIVO. No se copian a la base: se piden al
momento, se recortan y se cachean unos minutos. Asi lo que ve el equipo es lo
que hay ahora mismo en la fuente, sin un trabajo de sincronizacion que
mantener durante una emergencia.

De la base si sale QUE fuentes estan publicadas y en que orden: encenderlas es
una decision del equipo, no de cada navegador. El catalogo dice lo que se puede
mirar; la tabla `externas` y la pila dicen lo que el equipo decidio mirar.

Por que un modulo de codigo y no una tabla
-----------------------------------------
Cada fuente necesita saber que campos conservar, como simbolizarla y como
convertirla a GeoJSON. Eso es codigo, no configuracion: en una tabla habria
que construir ademas una pantalla de administracion que nadie pidio. Aqui se
versiona con el repo y se revisa en el mismo sitio que el resto.

El navegador NUNCA pasa una URL
-------------------------------
Pasa una clave de este catalogo y el servidor resuelve la direccion. Es la
misma regla que con TiTiler: si el cliente pudiera elegir a donde sale el
servidor, tendriamos un SSRF contra la propia VPS y contra la red interna de
Docker.

Datos personales
----------------
Varias capas traen nombres, telefonos, documentos y fotos de personas
afectadas o desaparecidas. `campos` es una lista BLANCA: solo eso sale hacia
el navegador. Lo que el mapa aporta es donde se concentran los reportes, no
como se llama cada quien; republicar los datos de contacto en un visor con
clave compartida sobre IP publica seria un problema de habeas data (Ley 1581
de 2012) sin ninguna ganancia de analisis.

La excepcion es `cali-visitados-criticos`, donde el equipo decidio de forma
expresa publicar el contacto de la persona afectada y los datos del tecnico
que evaluo, porque el uso previsto es repreguntarle. Queda dicho aqui para
que el criterio no parezca un descuido; revertirlo es quitar lineas de
`visitados.py` y volver a desplegar, sin nada que migrar.
"""
from dataclasses import dataclass, field

# ---------------------------------------------------------------------------
# Temas
# ---------------------------------------------------------------------------
# El orden manda en el catalogo. Primero lo que sirve para interpretar imagen,
# porque el equipo que usa esto hace teledeteccion; lo asistencial va despues.
TEMAS = (
    ("imagen", "Imágenes de referencia",
     "Vuelos y ortofotos oficiales. Sirven de «antes» para comparar con las escenas propias."),
    ("dano", "Daños y afectación",
     "Puntos y polígonos de daño observado. Sirven para dirigir y validar la interpretación."),
    ("respuesta", "Respuesta y recursos",
     "Albergues, acopio, salud y servicios activos."),
    ("contexto", "Contexto del sismo",
     "Epicentro, intensidad y activaciones internacionales."),
    ("catastro", "Catastro de referencia",
     "Predios, terrenos y construcciones. Base para ubicar un daño en un predio concreto."),
    ("modelo", "Modelos 3D",
     "Vuelos de dron sobre una estructura concreta. Se miran en perspectiva y se puede "
     "marcar sobre ellos."),
)


@dataclass(frozen=True)
class Fuente:
    """Una fuente del catalogo.

    tipo:
      imagen    ImageServer de ArcGIS -> teselas por /exportImage
      arcgis    FeatureServer -> /query?f=geojson (con paginacion)
      geojson   URL que ya devuelve GeoJSON
      lista     JSON con un arreglo de objetos que llevan latitud y longitud
      gdacs     un Feature suelto de la API de GDACS
      visitados API autenticada de la Alcaldia de Cali (Basic Auth + ventana)
      catastro  copia local en PostGIS -> teselas vectoriales propias
      modelo3d  malla 3D propia en /datos -> 3D Tiles (ver modelos3d.py)
      enlace    no se integra; se muestra en el catalogo con el motivo
    """
    clave: str
    nombre: str
    organizacion: str
    tema: str
    tipo: str
    url: str
    # Lista BLANCA de atributos que salen hacia el navegador. Vacia = todos.
    campos: tuple[str, ...] = ()
    # Campos que llegan como epoch en milisegundos y se convierten a fecha
    # legible. Se declaran a mano en vez de adivinarlos por el valor: un
    # entero de trece cifras puede ser un instante o pueden ser pesos, y
    # convertir un importe en una fecha de 1970 es peor que no convertir nada.
    fechas: tuple[str, ...] = ()
    titulo: str = ""            # atributo que encabeza la ficha del elemento
    color: str = "#3a86ff"
    minutos: int = 10           # cuanto vale la pena reusar lo ya descargado
    nota: str = ""              # advertencia de la fuente, tal como la dio el equipo
    # Generalizacion de la geometria, en grados. Solo para capas cuya forma
    # exacta no aporta nada: una grilla de intensidad sismica sin simplificar
    # son 36 MB, y esa precision es falsa, porque el propio ShakeMap se calcula
    # sobre una malla mucho mas gruesa.
    tolerancia: float = 0.0
    naturaleza: str = ""        # dinamica | semi-estatica | estatica
    simbologia: dict | None = None
    # Formulario de captura de la fuente, si lo tiene. Cuando esta puesto, la
    # capa ofrece abrirlo: quien consulta el dato en el visor suele ser quien
    # lo levanta en la calle, y tener el enlace ahi ahorra ir a buscarlo.
    formulario: str = ""            # URL publica del formulario de captura
    # Solo para tipo 'lista'
    lista: str = ""             # ruta al arreglo dentro del JSON ('' = raiz)
    lat: str = "lat"
    lon: str = "lon"
    enlaces: dict = field(default_factory=dict)   # {campo: prefijo a anteponer}
    # Campos por los que el navegador puede filtrar la capa.
    #
    #   ({"campo": "planta_ubicacion", "etiqueta": "Planta"},)
    #
    # El filtro es LOCAL a cada navegador y no toca el servidor: se aplica
    # sobre los atributos que ya viajan dentro de la tesela. Por eso el campo
    # tiene que estar en `campos`, y por eso cambiar de planta es instantaneo
    # en vez de una peticion y una espera.
    #
    # Se declara a mano y no se deduce de `campos` porque casi ningun atributo
    # sirve para filtrar: el numero predial son 650.975 valores distintos, y
    # ofrecerlo como filtro es ofrecer una lista inmanejable.
    filtros: tuple[dict, ...] = ()
    # Solo para tipo 'catastro'. Zoom entre el que se piden teselas.
    #
    # zoom_min existe porque el catastro no se puede dibujar a escala de
    # ciudad: una tesela z14 del centro de Cali son 32.000 poligonos, y lo
    # que se veria seria una mancha negra. Por debajo de este zoom la capa
    # simplemente no se pide.
    #
    # En las urbanas esta en 15 y no en 14: a 14 son 46.765 poligonos en una
    # sola tesela y segundo y medio de PostGIS. A 15 son 10.891 y ~250 ms,
    # porque por debajo de zoom_max la tesela se genera con menos precision de
    # coordenada, que a esa escala no se ve. Ahi si sale a cuenta.
    #
    # zoom_max NO es hasta donde se ve, sino hasta donde se GENERA: por encima
    # el navegador reescala la ultima tesela. Sin el, mirar una manzana a z20
    # pediria 256 teselas para dibujar exactamente los mismos poligonos.
    zoom_min: int = 15
    zoom_max: int = 16
    # Solo para tipo 'enlace'
    motivo: str = ""


# ---------------------------------------------------------------------------
# Paletas
# ---------------------------------------------------------------------------
# Grados de dano de Copernicus EMS, con su codigo de color habitual. Se repite
# en varias capas a proposito: que "destruido" sea siempre el mismo rojo es lo
# que permite mirar dos fuentes distintas sin recalibrar la vista.
GRADO_EMS = {
    "Destroyed": "#8c0d10",
    "Damaged": "#e63946",
    "Possibly damaged": "#f4a261",
    "Negligible to slight damage": "#ffd166",
    "No visible damage": "#7cb518",
    "Not Applicable": "#8d99ae",
}

# Criterio de habitabilidad del EDE (Evaluacion de Danos en Edificaciones).
# Es la conclusion de la inspeccion y se comunica como un semaforo: verde se
# sigue usando, amarillo se entra con restriccion, rojo no se entra. Se
# conservan los seis codigos en vez de agruparlos en tres familias porque el
# formato los distingue, y dentro del rojo el grado es justo lo que ordena a
# quien tiene que decidir por donde empezar.
HABITABILIDAD_EDE = {
    "h":  "#1a9641",
    "r1": "#ffd166",
    "r2": "#f4a261",
    "i1": "#e63946",
    "i2": "#c1121f",
    "i3": "#8c0d10",
}

# El servicio entrega el codigo crudo. Sin esto la leyenda dice "h" e "i2",
# que no significan nada sin el manual del formato delante.
HABITABILIDAD_ETIQUETAS = {
    "h":  "Habitable",
    "r1": "Acceso restringido (R1)",
    "r2": "Acceso restringido (R2)",
    "i1": "Inhabitable (I1)",
    "i2": "Inhabitable (I2)",
    "i3": "Inhabitable (I3)",
}

# Colapso verificado por la Alcaldia de Cali. Solo hay dos grados en esta API
# y se pintan con los mismos rojos que usan las capas de Copernicus: que "lo
# mas grave" sea siempre el mismo color es lo que permite mirar dos fuentes
# distintas sin recalibrar la vista.
COLAPSO_CALI = {"A": "#8c0d10", "B": "#e63946"}
COLAPSO_CALI_ETIQUETAS = {
    "A": "A · Colapso total",
    "B": "B · Riesgo de colapso",
}

# Ventana que se pide a la API de Visitados criticos. Fija en el 1 de agosto
# de 2026, con margen sobre el caso mas antiguo que existe (11 de agosto):
# pedir siempre desde el principio garantiza que no se pierda ninguno cuando
# alguien corrige una evaluacion vieja y le cambia la fecha.
VISITADOS_DESDE_UTC = 1785542400000    # 2026-08-01 00:00 UTC

DRP = "https://services.arcgis.com/vC1CdlKWEAtuT38d/arcgis/rest/services/"
IGAC_ORTO = "https://mapas2.igac.gov.co/image2/rest/services/orto/"
INVIAS = "https://hermes.invias.gov.co/arcgis/rest/services/OpenData/ServiciosOpenData/FeatureServer"
CATASTRO_CALI = ("https://services8.arcgis.com/ljfiJpg35HWgdtaC/arcgis/rest/services/"
                 "Validacion_geografica_WFL1/FeatureServer")

# Tipo de construccion en el catastro urbano de Cali. Interesa un solo corte:
# la construccion NO convencional (10.970 de 650.975) es la informal, que es
# donde el sismo hace mas dano, asi que va en rojo y el resto en gris.
#
# Las OCHO grafias no son un descuido: es como viene el dato. Y hay que
# listarlas todas porque MapLibre casa la categoria con `match`, que distingue
# mayusculas. Contarlas contra el servicio de ArcGIS no sirve para descubrirlo:
# su GROUP BY agrupa sin distinguirlas y devuelve una sola grafia, asi que
# declarar la que el responde deja fuera al 88% de las informales -9.501 de
# 10.970 son "No_Convencional" con C mayuscula- pintadas del color de descarte
# y ausentes de la leyenda. El recuento fiable es el de la copia local.
#
# El dato NO se normaliza al importar: se guarda tal como lo publica la fuente.
# Quien lo consulte en la ficha vera la grafia real, y aqui esta escrito que
# todas significan lo mismo.
_INFORMAL = "#e63946"
CONSTRUCCION_CALI = {
    "Convencional": "#8d99ae",
    "No_Convencional": _INFORMAL,     # 9.501
    "No_convencional": _INFORMAL,     # 1.215
    "No Convencional": _INFORMAL,     #   248
    " No_Convencional": _INFORMAL,    #     2
    "N o_Convencional": _INFORMAL,    #     1
    "No convencional": _INFORMAL,     #     1
    "No__Convencional": _INFORMAL,    #     1
    "nO_Convencional": _INFORMAL,     #     1
}
# Solo estas dos salen en la leyenda: `orden` manda sobre las claves de
# `colores`, asi que las erratas colorean sin ensuciar lo que se lee en campo.
CONSTRUCCION_CALI_ETIQUETAS = {
    "Convencional": "Convencional",
    "No_Convencional": "No convencional (informal)",
}


def _orto(ciudad: str, ruta: str, clave: str) -> Fuente:
    """La clave viaja dentro de la URL de las teselas: sin tildes."""
    return Fuente(
        clave=f"igac-orto-{clave}",
        nombre=f"Ortoimagen IGAC · {ciudad}",
        organizacion="IGAC",
        tema="imagen",
        tipo="imagen",
        url=f"{IGAC_ORTO}{ruta}/ImageServer",
        naturaleza="estatica",
        nota="Vuelo anterior al sismo: sirve de «antes» para comparar con las escenas propias.",
    )


CATALOGO: tuple[Fuente, ...] = (
    # -- Imagenes -----------------------------------------------------------
    _orto("Cali", "ortoCali", "cali"),
    _orto("Yumbo", "ortoYumbo", "yumbo"),
    _orto("Palmira", "ortoPalmira", "palmira"),
    _orto("Jamundí", "ortoJamundi", "jamundi"),

    # -- Danos --------------------------------------------------------------
    Fuente(
        clave="cali-visitados-criticos",
        nombre="Visitados críticos · colapso A/B (Cali)",
        organizacion="Alcaldía de Cali",
        tema="dano",
        tipo="visitados",
        url="https://atencionsismo.cali.gov.co/api/operario/reports/visitados-criticos",
        titulo="direccion",
        color="#8c0d10",
        minutos=10,
        naturaleza="dinamica",
        nota="Solo casos con visita hecha y colapso verificado A o B. "
             "Incluye datos de contacto y del técnico que evaluó.",
        simbologia={"campo": "colapso", "modo": "categorias",
                    "colores": COLAPSO_CALI,
                    "etiquetas": COLAPSO_CALI_ETIQUETAS,
                    "orden": ["A", "B"]},
    ),
    Fuente(
        # La clave se queda como esta: identifica la fuente en la pila y en la
        # tabla `externas`, y cambiarla dejaria huerfano lo ya publicado.
        clave="ungrd-ede",
        nombre="Matriz EDE · evaluación de edificaciones",
        organizacion="AMVA",
        tema="dano",
        tipo="arcgis",
        url="https://services6.arcgis.com/EF6OTqvE0RxR2jwj/arcgis/rest/services/"
            "service_d108cb3c79e242eabe99b458798936d1/FeatureServer/0",
        # Sin contacto_nombre, contacto_tel, contacto_email, nombre_evaluador,
        # matricula_profesional ni codigo_predial: ver cabecera. Si quedan la
        # direccion, el barrio y el nombre del inmueble, porque una evaluacion
        # que no se puede volver a encontrar en la calle no sirve para nada.
        campos=("nombre_edif", "barrio", "direccion",
                "habitabilidad_final", "nivel_dano_final", "severidad_final",
                "afectacion_planta", "uso_edif", "pisos_sobre", "ocupantes",
                "sis_estructural_p", "material_p", "epoca_const_p", "acceso",
                "recomendaciones_p", "eval_adicional_p", "observaciones_generales",
                "fecha_inspeccion", "EditDate"),
        titulo="nombre_edif",
        color="#d7191c",
        minutos=5,
        naturaleza="dinamica",
        formulario="https://survey123.arcgis.com/share/042e021e34e349ddadf738270674dcc9",
        nota="Inspección oficial en campo, con el criterio de habitabilidad del formato "
             "EDE. Lo comparte el Área Metropolitana del Valle de Aburrá. El servicio "
             "acepta escritura pública, así que un registro suelto no es dato firme "
             "hasta contrastarlo.",
        simbologia={"campo": "habitabilidad_final", "modo": "categorias",
                    "colores": HABITABILIDAD_EDE,
                    "etiquetas": HABITABILIDAD_ETIQUETAS,
                    "orden": ["h", "r1", "r2", "i1", "i2", "i3"]},
        fechas=("fecha_inspeccion", "EditDate"),
    ),
    Fuente(
        clave="copernicus-grading",
        nombre="Grading Copernicus · puntos verificados",
        organizacion="IGAC / Copernicus",
        tema="dano",
        tipo="arcgis",
        url="https://sigi.igac.gov.co/geografia/rest/services/otros/"
            "puntosafectacioncali_emergenciachoco_copernicus/FeatureServer/0",
        campos=("obj_type", "name", "info", "simplified", "damage_gra",
                "det_method", "notation"),
        titulo="obj_type",
        color="#e63946",
        minutos=30,
        naturaleza="dinamica",
        nota="Sin frecuencia fija: depende de la verificación en campo del IGAC.",
        simbologia={"campo": "damage_gra", "modo": "categorias",
                    "colores": GRADO_EMS, "orden": list(GRADO_EMS)},
    ),
    Fuente(
        clave="igac-sitios-video",
        nombre="Sitios con video de campo (Cali)",
        organizacion="IGAC",
        tema="dano",
        tipo="lista",
        url="https://emergencia.igac.gov.co/data/sitios-cali.json",
        lista="",
        lat="coordenadas.latitud",
        lon="coordenadas.longitud",
        campos=("nombre", "barrio", "resumen", "fechas_toma", "ruta_video", "obs"),
        titulo="nombre",
        color="#00a5cf",
        minutos=60,
        naturaleza="semi-estatica",
        nota="Archivo estático del sitio del IGAC, no una API. Varios sitios traen tomas "
             "de 2022 y de agosto de 2026: son antes y después del mismo punto.",
        enlaces={"ruta_video": "https://emergencia.igac.gov.co/"},
    ),
    Fuente(
        clave="drp-reportes-ciudadanos",
        nombre="Reportes ciudadanos geolocalizados",
        organizacion="Esri Colombia (DRP)",
        tema="dano",
        tipo="arcgis",
        url=DRP + "ReportesCiudadanos_Terremoto_20260810/FeatureServer/0",
        # Sin NOMBRE_PERSONA, NOMBRE_REPORTANTE ni TELEFONO: ver cabecera.
        campos=("TIPO_EVENTO", "SEVERIDAD", "DESCRIPCION", "CIUDAD", "BARRIO_SECTOR",
                "PERSONAS_AFECTADAS", "ESTADO_VALIDACION", "FUENTE", "IA_SEVERIDAD",
                "IA_RESUMEN", "IA_LUGAR", "CreationDate", "EditDate"),
        titulo="TIPO_EVENTO",
        color="#f77f00",
        minutos=5,
        naturaleza="dinamica",
        nota="Alto volumen y continuo. IA_SEVERIDAD e IA_RESUMEN están procesados con IA: "
             "contrastar antes de usarlos como dato firme.",
        simbologia={"campo": "SEVERIDAD", "modo": "rangos",
                    "cortes": [1, 2, 3, 4, 5, 6],
                    "colores": ["#1a9641", "#a6d96a", "#fdae61", "#e8703a", "#d7191c"]},
        fechas=("CreationDate", "EditDate"),
    ),
    Fuente(
        clave="drp-infraestructura",
        nombre="Inventario de infraestructura dañada",
        organizacion="Esri Colombia (DRP)",
        tema="dano",
        tipo="arcgis",
        url=DRP + "Infraestructura/FeatureServer/0",
        campos=("id", "tipo_infra", "nombre_ubi", "municipio", "departamen",
                "descripcio", "fuente_ofi", "medio_publ", "fecha_repo",
                "nivel_veri", "notas"),
        titulo="nombre_ubi",
        color="#c1121f",
        minutos=10,
        naturaleza="dinamica",
        nota="El campo nivel_veri dice cuánto está verificado cada registro.",
        simbologia={"campo": "nivel_veri", "modo": "categorias",
                    "colores": {"CONFIRMADO_OFICIAL": "#8c0d10",
                                "OFICIAL_PRELIMINAR": "#f4a261",
                                "NO_CONFIRMADO": "#8d99ae"},
                    "orden": ["CONFIRMADO_OFICIAL", "OFICIAL_PRELIMINAR", "NO_CONFIRMADO"]},
    ),
    Fuente(
        clave="drp-danos-survey",
        nombre="Daños a infraestructura (Survey123)",
        organizacion="Esri Colombia (DRP)",
        tema="dano",
        tipo="arcgis",
        url=DRP + "survey123_3ee0dfbbc4644a29ba547117537c8326/FeatureServer/0",
        # Sin nombre_completo ni tel_fono_de_contacto.
        campos=("categor_a_de_da_o", "nivel_de_severidad",
                "descripci_n_detallada_del_da_o", "municipio", "departamento",
                "fecha_y_hora_del_reporte", "_hay_personas_heridas_o_desapar"),
        titulo="categor_a_de_da_o",
        color="#ef476f",
        minutos=5,
        naturaleza="dinamica",
        nota="Formulario de campo activo.",
        simbologia={"campo": "nivel_de_severidad", "modo": "categorias",
                    "colores": {"Severo": "#8c0d10", "Moderado": "#f4a261", "Leve": "#ffd166"},
                    "orden": ["Severo", "Moderado", "Leve"]},
        fechas=("fecha_y_hora_del_reporte",),
    ),
    Fuente(
        clave="mapa-terremoto",
        nombre="Registro agregado (257 fuentes)",
        organizacion="Mapa del Terremoto",
        tema="dano",
        tipo="lista",
        url="https://www.mapadelterremoto.com/datos/registro-ligero.json",
        lista="puntos",
        lat="lat",
        lon="lon",
        # Sin registradoPor: identifica a quien reporta.
        campos=("codigo", "tipo", "severidad", "estado", "atencion", "departamento",
                "municipio", "barrio", "direccion", "descripcion", "pisos",
                "riesgoInminente", "accesoBloqueado", "serviciosAfectados", "actualizado"),
        titulo="direccion",
        color="#9d4edd",
        minutos=30,
        naturaleza="dinamica",
        nota="Buena parte de los registros solo tiene municipio, sin coordenadas, y esos "
             "no se pueden dibujar. Versión liviana; la completa añade el detalle de "
             "evidencias. Campos DIVIPOLA y EDAN normalizados.",
        simbologia={"campo": "severidad", "modo": "categorias",
                    "colores": {"COLAPSO": "#8c0d10", "GRAVE": "#e63946",
                                "MODERADO": "#f4a261", "LEVE": "#ffd166",
                                "SIN_EVALUAR": "#8d99ae"},
                    "orden": ["COLAPSO", "GRAVE", "MODERADO", "LEVE", "SIN_EVALUAR"]},
    ),
    Fuente(
        clave="predioz-heatmap",
        nombre="Reportes comunitarios agregados",
        organizacion="Predioz",
        tema="dano",
        tipo="geojson",
        url="https://predioz.co/api/heatmap",
        campos=("parcel_count", "report_count", "worst_severity", "avg_severity",
                "occupants", "uninhabitable_count", "collapsed_count"),
        titulo="",
        color="#fb5607",
        minutos=5,
        naturaleza="dinamica",
        nota="Agregado por celdas, no predio a predio. Cobertura nacional: no trae ciudad.",
        simbologia={"campo": "worst_severity", "modo": "rangos",
                    "cortes": [1, 2, 3, 4, 5],
                    "colores": ["#ffd166", "#f4a261", "#e63946", "#8c0d10"]},
    ),

    # -- Respuesta ----------------------------------------------------------
    Fuente(
        clave="drp-afectaciones",
        nombre="Afectaciones, rescate y centros de acopio",
        organizacion="Esri Colombia (DRP)",
        tema="respuesta",
        tipo="arcgis",
        url=DRP + "Terremoto20260810_Datos/FeatureServer/0",
        campos=("nombre_buscable", "organizacion", "ciudad", "direccion", "tipo",
                "categorias", "que_necesitan", "horario", "telefono", "nota",
                "fuente_url", "verificacion", "link_gmaps", "EditDate"),
        titulo="nombre_buscable",
        color="#2a9d8f",
        naturaleza="dinamica",
        nota="Capa principal del programa DRP de Esri Colombia.",
        fechas=("EditDate",),
    ),
    Fuente(
        clave="drp-conectividad",
        nombre="Conectividad y albergues",
        organizacion="Esri Colombia (DRP)",
        tema="respuesta",
        tipo="arcgis",
        url=DRP + "Conectividad_Terremoto_20260810/FeatureServer/0",
        campos=("nombre", "categoria", "tipo", "direccion", "barrio", "municipio",
                "departamento", "entidad_responsable", "horario", "descripcion",
                "url_fuente", "actualizado"),
        titulo="nombre",
        color="#118ab2",
        naturaleza="dinamica",
        fechas=("actualizado",),
    ),
    Fuente(
        clave="drp-albergues-pereira",
        nombre="Albergues temporales · Pereira",
        organizacion="Esri Colombia (DRP)",
        tema="respuesta",
        tipo="arcgis",
        url=DRP + "Albergues_temporales_WFL1/FeatureServer/0",
        campos=("Nombre", "Tipo", "Ciudad", "Direccion", "Capacidad_Max",
                "Ocupacion_Actual", "Porcentaje_Ocupacion", "Estado",
                "Ultima_Actualizacion"),
        titulo="Nombre",
        color="#06d6a0",
        minutos=5,
        naturaleza="dinamica",
        nota="Pese al nombre genérico del servicio, solo contiene registros de Pereira.",
        simbologia={"campo": "Porcentaje_Ocupacion", "modo": "rangos",
                    "cortes": [0, 50, 80, 95, 100],
                    "colores": ["#1a9641", "#ffd166", "#f4a261", "#d7191c"]},
        fechas=("Ultima_Actualizacion",),
    ),
    Fuente(
        clave="drp-acopio-survey",
        nombre="Centros de acopio (Survey123)",
        organizacion="Esri Colombia (DRP)",
        tema="respuesta",
        tipo="arcgis",
        url=DRP + "survey123_582cd83a7ecf4512a62ba33982c80e1f/FeatureServer/0",
        # Sin persona_de_contacto ni correo_electr_nico.
        campos=("nombre_del_lugar", "tipo_de_lugar", "organizaci_n_responsable",
                "_qu_tipo_de_apoyo_recibe_o_brin", "departamento", "municipio",
                "ciudad", "direcci_n", "horario_de_atenci_n", "d_as_de_atenci_n",
                "_est_activo_actualmente", "tel_fono", "v_nculo", "observaci_n"),
        titulo="nombre_del_lugar",
        color="#7cb518",
        naturaleza="dinamica",
        nota="Formulario de campo alimentado por voluntarios y organizaciones.",
    ),
    Fuente(
        clave="drp-salud-osm",
        nombre="Hospitales y clínicas (OSM)",
        organizacion="Esri Colombia (DRP)",
        tema="respuesta",
        tipo="arcgis",
        url=DRP + "Hospitales_y_Clinicas/FeatureServer/0",
        campos=("name", "amenity", "healthcare", "emergency", "operator",
                "addr_city", "addr_street", "phone", "website", "opening_hours"),
        titulo="name",
        color="#457b9d",
        minutos=720,
        naturaleza="semi-estatica",
        nota="Importación puntual de OpenStreetMap, no un feed en vivo.",
    ),
    Fuente(
        clave="drp-reps",
        nombre="Sedes de servicios de salud (REPS)",
        organizacion="Esri Colombia (DRP)",
        tema="respuesta",
        tipo="arcgis",
        url=DRP + "____________________________ntmMSG/FeatureServer/0",
        campos=("NombrePrestador", "NombreSede", "ClasePrestadorDesc",
                "DepartamentoSedeDesc", "MunicipioSedeDesc", "DireccionSede",
                "TelefonoSede", "CodigoHabilitacionSede", "FechaCorte"),
        titulo="NombreSede",
        color="#3a86ff",
        minutos=720,
        naturaleza="semi-estatica",
        nota="Registro nacional del Ministerio de Salud, no específico del sismo "
             "(2.936 sedes en todo el país).",
    ),
    Fuente(
        clave="drp-bancos-sangre",
        nombre="Bancos de sangre en funcionamiento",
        organizacion="Esri Colombia (DRP)",
        tema="respuesta",
        tipo="arcgis",
        url=DRP + "______1__86_XAeRAV/FeatureServer/0",
        campos=("Banco_de_Sangre", "Categor_a", "Departamento", "Ciudad",
                "Direccion", "Estado_del_establecimiento", "Concepto_tecnico",
                "Aferesis", "Ultima_visita"),
        titulo="Banco_de_Sangre",
        color="#c1121f",
        minutos=720,
        naturaleza="semi-estatica",
        nota="Corte del registro nacional (campo Ultima_visita).",
        fechas=("Ultima_visita",),
    ),
    Fuente(
        clave="drp-desaparecidos-prensa",
        nombre="Personas desaparecidas · reportes de prensa",
        organizacion="Esri Colombia (DRP)",
        tema="respuesta",
        tipo="arcgis",
        url=DRP + "datos_espectador_desaparecidos/FeatureServer/0",
        # Solo lo que no identifica: el punto ya es un centroide municipal, y
        # quien necesite el caso completo tiene el enlace a la nota de prensa.
        campos=("estado", "ciudad", "ultima_vez", "Estado_Cruce_DIVIPOLA",
                "Metodo_Georreferenciacion", "Fuente", "Enlace"),
        titulo="ciudad",
        color="#8338ec",
        minutos=15,
        naturaleza="dinamica",
        nota="Ubicación por centroide municipal (cruce DIVIPOLA), no la posición real. "
             "El visor no reproduce nombres, edades ni fotografías.",
        simbologia={"campo": "estado", "modo": "categorias",
                    "colores": {"pendiente": "#d7191c", "localizado": "#1a9641"},
                    "orden": ["pendiente", "localizado"]},
    ),
    Fuente(
        clave="drp-desaparecidos-survey",
        nombre="Personas desaparecidas · reportes ciudadanos",
        organizacion="Esri Colombia (DRP)",
        tema="respuesta",
        tipo="arcgis",
        url=DRP + "survey123_906cbcb9b38e447c943b35c57ae1a7d3/FeatureServer/0",
        # Todo el formulario es dato personal sensible (documento, condicion
        # medica, contacto). Solo sale donde y cuando.
        campos=("departamento", "ciudad_municipio",
                "_cu_ndo_fue_la_ltima_vez_que_la", "CreationDate"),
        titulo="ciudad_municipio",
        color="#8338ec",
        minutos=15,
        naturaleza="dinamica",
        nota="Formulario con datos personales sensibles: el visor solo muestra municipio "
             "y fecha. Para el caso completo hay que ir a la fuente, con su tratamiento "
             "de datos.",
        fechas=("_cu_ndo_fue_la_ltima_vez_que_la", "CreationDate"),
    ),
    Fuente(
        clave="drp-mascotas-apoyo",
        nombre="Red de apoyo para mascotas",
        organizacion="Esri Colombia (DRP)",
        tema="respuesta",
        tipo="arcgis",
        url=DRP + "apoyo_mascotas_emergencias/FeatureServer/0",
        campos=("Nombre", "Tipo_Apoyo", "Descrip_Apoyo", "Direccion", "Ciudad",
                "Departamento", "Telefono", "Estado_Recepcion", "Nota"),
        titulo="Nombre",
        color="#ffbe0b",
        naturaleza="dinamica",
    ),
    Fuente(
        clave="drp-mascotas-perdidas",
        nombre="Mascotas perdidas y encontradas",
        organizacion="Esri Colombia (DRP)",
        tema="respuesta",
        tipo="arcgis",
        url=DRP + "Mascotas_Perdidas/FeatureServer/0",
        # Sin Nombre_contacto, Telefono_contacto ni fotos.
        campos=("Nombre", "Especie", "Sexo", "Raza", "Color", "Tipo_Reporte",
                "Fecha", "Descripcion_animal", "Direccion"),
        titulo="Nombre",
        color="#f4a261",
        naturaleza="dinamica",
        nota="Sin campo de ciudad: solo dirección y coordenadas.",
        simbologia={"campo": "Tipo_Reporte", "modo": "categorias",
                    "colores": {"Mascota Desaparecida": "#e63946",
                                "Mascota Encontrada": "#1a9641"},
                    "orden": ["Mascota Desaparecida", "Mascota Encontrada"]},
    ),

    # -- Contexto -----------------------------------------------------------
    Fuente(
        clave="drp-shakemap",
        nombre="ShakeMap · intensidad del sismo",
        organizacion="Esri Colombia (DRP)",
        tema="contexto",
        tipo="arcgis",
        url=DRP + "Informacion_sismo/FeatureServer/0",
        campos=("PARAMVALUE", "GRID_CODE"),
        titulo="PARAMVALUE",
        color="#f77f00",
        minutos=1440,
        naturaleza="semi-estatica",
        tolerancia=0.01,
        nota="Polígonos de grilla, generalizados a ~1 km para poder dibujarlos: sin "
             "simplificar son 36 MB. Solo se reemplaza si se recalcula el evento.",
        simbologia={"campo": "PARAMVALUE", "modo": "rangos",
                    "cortes": [3, 4, 4.5, 5, 5.5, 6.5],
                    "colores": ["#ffffb2", "#fed976", "#feb24c", "#f03b20", "#bd0026"]},
    ),
    Fuente(
        clave="gdacs-epicentro",
        nombre="Epicentro GDACS · M 7.4",
        organizacion="GDACS",
        tema="contexto",
        tipo="gdacs",
        url="https://www.gdacs.org/gdacsapi/api/events/geteventdata?eventtype=EQ&eventid=1557236",
        titulo="name",
        color="#ffd166",
        minutos=60,
        naturaleza="dinamica",
        nota="GDACS recalcula alertas e impacto cada pocas horas.",
    ),

    # -- INVIAS --------------------------------------------------------------
    # El endpoint del inventario (hermes2 / Sistema_informacion_vial) responde
    # "Token Required". Este otro, abierto, aparecio consultando el indice del
    # portal DRP que el propio equipo incluyo en la lista.
    Fuente(
        clave="invias-red-vial",
        nombre="Red vial nacional",
        organizacion="INVIAS (OpenData)",
        tema="respuesta",
        tipo="arcgis",
        url=INVIAS + "/0",
        campos=("codigo_via", "tramo", "sector", "ruta", "territorial",
                "administrador", "concesion", "observacion_invias", "estado",
                "fecha_actualiz"),
        titulo="tramo",
        color="#f4a261",
        minutos=720,
        naturaleza="semi-estatica",
        tolerancia=0.0005,
        nota="Es el INVENTARIO de la red, no su estado tras el sismo: el campo «estado» es "
             "de uso interno de INVIAS y viene vacío en tres de cada cuatro tramos. "
             "Generalizada a ~55 m: sin simplificar son 118 MB.",
        fechas=("fecha_actualiz",),
    ),
    Fuente(
        clave="invias-puentes",
        nombre="Puentes de la red nacional",
        organizacion="INVIAS (OpenData)",
        tema="respuesta",
        tipo="arcgis",
        url=INVIAS + "/1",
        campos=("nombre", "carretera", "vias", "pr_o", "l_total", "luces",
                "luz_max", "material", "construc", "reconstr", "fecha_inspe"),
        titulo="nombre",
        color="#ffbe0b",
        minutos=720,
        naturaleza="semi-estatica",
        nota="Inventario nacional con la fecha de última inspección de cada puente. Sirve "
             "para priorizar cuáles revisar tras el sismo; no dice si están dañados.",
    ),

    # -- Catastro de referencia ---------------------------------------------
    # Catastro multiproposito del IGAC para Cali, publicado por Planeacion de
    # Cali. Son 1,5 millones de poligonos entre las seis capas: NO se consultan
    # en vivo como el resto del catalogo, sino que se copian una vez a PostGIS
    # y se sirven como teselas vectoriales propias. El porque esta en
    # catastro.py; el resumen es que una pantalla a nivel de barrio son 180.000
    # poligonos y el mecanismo en vivo tiene un tope de 8.000.
    #
    # Las seis son una carga masiva unica del 15 de agosto de 2026: las seis
    # capas comparten el mismo EditDate maximo con 21 segundos de diferencia y
    # no se han tocado desde entonces. Por eso una copia local no se desactualiza.
    Fuente(
        clave="catastro-cali-urbano-unidad-construccion",
        nombre="Unidades de construcción · urbano (Cali)",
        organizacion="IGAC · Planeación de Cali",
        tema="catastro",
        tipo="catastro",
        url=CATASTRO_CALI + "/1",
        campos=("numero_predial_nacional", "identificador", "planta_ubicacion",
                "tipo_planta", "tipo_construccion", "total_pisos",
                "anio_construccion", "id_unico_construccion"),
        titulo="numero_predial_nacional",
        color="#9b5de5",
        naturaleza="estatica",
        # La razon de ser del filtro en esta capa: con todas las plantas
        # dibujadas, la de arriba tapa a la de abajo. Aislar una planta es
        # la unica forma de mirar la que interesa.
        filtros=({"campo": "planta_ubicacion", "etiqueta": "Planta"},
                 {"campo": "tipo_planta", "etiqueta": "Tipo de planta"},
                 {"campo": "tipo_construccion", "etiqueta": "Tipo de construcción"},
                 {"campo": "anio_construccion", "etiqueta": "Año de construcción"}),
        zoom_min=15,
        zoom_max=16,
        # Un color por planta. Sin esto la capa es ilegible: las plantas de un
        # mismo edificio se superponen casi por completo y lo unico que se ve
        # es un borron mas oscuro cuanto mas alto es el edificio. Coloreando
        # por planta se distingue el zocalo de la torre de un vistazo.
        #
        # El ultimo corte separa 21..99, que NO son plantas: son 8.700 filas
        # con valor 95 a 99, y en toda la capa no hay ni un solo valor entre
        # 21 y 94. Ese hueco es lo que delata que son codigos de la fuente
        # para lo que va encima de la ultima planta. Sin este corte caian en
        # la clase de los edificios mas altos y se pintaban como una torre de
        # veinte pisos, asi que van en gris: no es una altura.
        simbologia={"campo": "planta_ubicacion", "modo": "rangos",
                    "cortes": [1, 2, 3, 5, 10, 21, 100],
                    "colores": ["#ffedbe", "#fdc47a", "#f4845f", "#c9457a",
                                "#7b2cbf", "#8d99ae"]},
        nota="Una fila por PLANTA, no por edificio: 406.048 filas sobre 174.167 predios. "
             "Incluye sótanos, semisótanos y mezanines. Los valores 95 a 99 (8.736 filas) "
             "no son plantas: son códigos de la fuente para lo que va sobre la última, y "
             "salen en gris. Copia local del 15/08/2026.",
    ),
    Fuente(
        clave="catastro-cali-urbano-terreno",
        nombre="Terrenos · urbano (Cali)",
        organizacion="IGAC · Planeación de Cali",
        tema="catastro",
        tipo="catastro",
        url=CATASTRO_CALI + "/2",
        campos=("numero_predial_nacional", "numero_predial_manzana", "area_terreno"),
        titulo="numero_predial_nacional",
        color="#00b4d8",
        naturaleza="estatica",
        filtros=({"campo": "area_terreno", "etiqueta": "Área del terreno (m²)"},),
        zoom_min=15,
        zoom_max=16,
        nota="El lindero del predio, que es la unidad sobre la que se reclama. "
             "338.312 predios. Copia local del 15/08/2026.",
    ),
    Fuente(
        clave="catastro-cali-urbano-construccion",
        nombre="Construcciones · urbano (Cali)",
        organizacion="IGAC · Planeación de Cali",
        tema="catastro",
        tipo="catastro",
        url=CATASTRO_CALI + "/3",
        campos=("numero_predial_nacional", "tipo_construccion", "numero_pisos", "altura"),
        titulo="numero_predial_nacional",
        color="#f77f00",
        naturaleza="estatica",
        filtros=({"campo": "tipo_construccion", "etiqueta": "Tipo de construcción"},
                 {"campo": "numero_pisos", "etiqueta": "Número de pisos"},
                 {"campo": "altura", "etiqueta": "Altura (m)"}),
        zoom_min=15,
        zoom_max=16,
        simbologia={"campo": "tipo_construccion", "modo": "categorias",
                    "colores": CONSTRUCCION_CALI,
                    "etiquetas": CONSTRUCCION_CALI_ETIQUETAS,
                    "orden": ["No_Convencional", "Convencional"]},
        nota="La huella de cada construcción: 650.997. OJO con «numero_pisos» y «altura»: "
             "248.282 filas (38%) traen ambos en 0, que aquí es «sin dato», no una "
             "construcción de cero pisos. Copia local del 15/08/2026.",
    ),
    Fuente(
        clave="catastro-cali-rural-unidades",
        nombre="Unidades · rural (Cali)",
        organizacion="IGAC · Planeación de Cali",
        tema="catastro",
        tipo="catastro",
        url=CATASTRO_CALI + "/4",
        campos=("etiqueta", "u_destinos", "pisopred", "edifpred", "tipo_avalu",
                "sector", "comuna", "barrio", "manzana", "terreno", "predio", "numepred"),
        titulo="etiqueta",
        color="#7209b7",
        naturaleza="estatica",
        filtros=({"campo": "pisopred", "etiqueta": "Piso"},
                 {"campo": "u_destinos", "etiqueta": "Destino"},
                 {"campo": "comuna", "etiqueta": "Comuna"},
                 {"campo": "tipo_avalu", "etiqueta": "Tipo de avalúo"}),
        zoom_min=13,
        zoom_max=16,
        nota="43.353 unidades. Pese al nombre incluye propiedad horizontal («APTO 402», "
             "«PARQUEADERO 166»): es la base rural del catastro, no solo suelo rural. "
             "Copia local del 15/08/2026.",
    ),
    Fuente(
        clave="catastro-cali-rural-terreno",
        nombre="Terrenos · rural (Cali)",
        organizacion="IGAC · Planeación de Cali",
        tema="catastro",
        tipo="catastro",
        url=CATASTRO_CALI + "/5",
        campos=("idterreno", "npn", "nom_edific", "etiqueta", "tipo_avalu",
                "sector", "comuna", "barrio", "manzana", "terreno", "predio", "numepred"),
        titulo="idterreno",
        color="#06a77d",
        naturaleza="estatica",
        filtros=({"campo": "comuna", "etiqueta": "Comuna"},
                 {"campo": "sector", "etiqueta": "Sector"},
                 {"campo": "tipo_avalu", "etiqueta": "Tipo de avalúo"}),
        zoom_min=13,
        zoom_max=16,
        nota="18.196 terrenos. El número predial nacional («npn») solo viene en el 6%; "
             "el identificador utilizable es «idterreno». Copia local del 15/08/2026.",
    ),
    Fuente(
        clave="catastro-cali-rural-construcciones",
        nombre="Construcciones · rural (Cali)",
        organizacion="IGAC · Planeación de Cali",
        tema="catastro",
        tipo="catastro",
        url=CATASTRO_CALI + "/6",
        campos=("etiqueta", "npisos", "u_destinos", "tipo_cons", "edifpred", "tipo_avalu",
                "sector", "comuna", "barrio", "manzana", "terreno", "predio", "numepred"),
        titulo="etiqueta",
        color="#d62828",
        naturaleza="estatica",
        filtros=({"campo": "npisos", "etiqueta": "Número de pisos"},
                 {"campo": "u_destinos", "etiqueta": "Destino"},
                 {"campo": "tipo_cons", "etiqueta": "Tipo de construcción"},
                 {"campo": "comuna", "etiqueta": "Comuna"}),
        zoom_min=13,
        zoom_max=16,
        nota="47.429 construcciones. «npisos» viene en el 98%, al contrario que en la capa "
             "urbana. Copia local del 15/08/2026.",
    ),

    # -- No integradas ------------------------------------------------------
    Fuente(
        clave="igac-basemap-ott",
        nombre="Basemap OTT (teselas vectoriales)",
        organizacion="IGAC",
        tema="contexto",
        tipo="enlace",
        url="https://tiles.arcgis.com/tiles/RVvWzU3lgJISqdke/arcgis/rest/services/"
            "BasemapOTT20240925/VectorTileServer",
        naturaleza="estatica",
        motivo="Es cartografía base sin datos de la emergencia, y el visor ya trae tres "
               "mapas base. Se puede añadir si el equipo prefiere la base del IGAC.",
    ),

    # -- Modelos 3D ---------------------------------------------------------
    # No es una fuente externa: los archivos estan en /datos y los sirve la
    # propia API. Vive en este catalogo porque es donde el equipo enciende y
    # apaga capas, y tener los modelos en otro sitio seria una lista mas que
    # aprenderse. Lo geometrico -donde se apoya, que encuadre tiene- esta en
    # modelos3d.py, que es la unica fuente de verdad de eso.
    Fuente(
        clave="modelo-cristo-rey",
        nombre="Cristo Rey · modelo 3D del vuelo",
        organizacion="SIATA",
        tema="modelo",
        tipo="modelo3d",
        url="",
        color="#c77dff",
        naturaleza="estatica",
        # Por debajo de 16 el modelo son 545 m de lado en una pantalla de
        # ciudad: una mancha parda que no dice nada y cuesta descargarse.
        zoom_min=16,
        nota="Vuelo de dron procesado en DJI Terra. Malla texturizada, no nube de puntos: "
             "resolución de unos 2 cm. Cubre 545 × 478 m alrededor del monumento y solo "
             "lo que vio la cámara, así que hay huecos bajo los aleros y la vegetación.",
    ),
    Fuente(
        clave="modelo-cristo-monumento",
        nombre="Cristo Rey · el monumento en detalle",
        organizacion="SIATA",
        tema="modelo",
        tipo="modelo3d",
        url="",
        color="#c77dff",
        naturaleza="estatica",
        zoom_min=17,
        nota="Recorte del mismo vuelo, solo el monumento y su explanada: 19 MB en vez "
             "de 628. Al ser pequeño se pide con mucho más detalle, así que la estatua "
             "se ve nítida sin esperar. Se solapa con la capa del vuelo completo; "
             "conviene tener encendida una de las dos, no las dos a la vez.",
    ),
)

POR_CLAVE = {f.clave: f for f in CATALOGO}


# ---------------------------------------------------------------------------
# Productos descargables
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class Producto:
    """Archivo que no es un servicio: se descarga una vez y se ingiere.

    Se convierten en capas y rasters PROPIOS, no en fuentes en vivo: son
    productos versionados e inmutables, y una vez dentro admiten simbología,
    filtro, medición en 9377 y exportación como cualquier capa del equipo.
    """
    clave: str
    nombre: str
    organizacion: str
    url: str
    tipo: str            # zip-ems | raster | geojson | huellas | enlace
    mb: float
    nota: str = ""
    motivo: str = ""
    # Solo para 'huellas': que filas se quedan, en SQL de OGR. Es lo que hace
    # importable un archivo que entero no cabe.
    filtro: str = ""


EMS = "https://rapidmapping.emergency.copernicus.eu/backend/EMSR916/"

# Que huellas de edificación vale la pena traer del producto de HDX.
#
# El equipo propuso recortar por municipios usando su capa de areas urbanas, y
# la idea es buena; para ESTOS dos archivos no es la que sirve. Son de Cali
# solamente, asi que recortar por area urbana deja fuera 167 de los 614
# edificios marcados -los periurbanos- y sigue dejando dentro trescientos mil
# sin nada que mirar. Lo que separa la señal del volumen aqui es la prediccion:
# 320.791 huellas, 1.047 con algun indicio de daño. Se traen esas, todas, sin
# recorte geografico, para no perder ni una marca.
FILTRO_HUELLAS = "damaged = 1 OR damage_pct_0m > 0"

PRODUCTOS: tuple[Producto, ...] = (
    Producto(
        clave="ems-aoi02-pereira",
        nombre="Copernicus EMSR916 · grading AOI02 Pereira",
        organizacion="Copernicus EMS",
        url=EMS + "AOI02/GRA_PRODUCT/EMSR916_AOI02_GRA_PRODUCT_v1.zip",
        tipo="zip-ems",
        mb=12.7,
        nota="Trae edificaciones, vías, huella de imagen y área de interés, ya en WGS84. "
             "Entra como varias capas del equipo.",
    ),
    Producto(
        clave="ems-aoi03-cali",
        nombre="Copernicus EMSR916 · grading AOI03 Cali Centro",
        organizacion="Copernicus EMS",
        url=EMS + "AOI03/GRA_PRODUCT/EMSR916_AOI03_GRA_PRODUCT_v1.zip",
        tipo="zip-ems",
        mb=4.4,
        nota="Mismo contenido para el centro de Cali.",
    ),
    Producto(
        clave="hdx-predicciones",
        nombre="Daño estimado con IA sobre imagen Airbus (Cali)",
        organizacion="HDX / Microsoft AI for Good Lab",
        url="https://data.humdata.org/dataset/98e2bb4b-e2b9-4178-bf47-826883ca08cc/resource/"
            "25f91e45-a0aa-4bf7-bcc8-6addf3c68303/download/"
            "airbus_cali_warped_cog_model-predictions.tif",
        tipo="raster",
        mb=19.5,
        nota="COG con la predicción del modelo sobre la escena Airbus del 10 de agosto. "
             "Entra como imagen y se puede comparar con las escenas propias.",
    ),
    Producto(
        clave="hdx-area-valida",
        nombre="Área válida de la predicción de IA (Cali)",
        organizacion="HDX / Microsoft AI for Good Lab",
        url="https://data.humdata.org/dataset/98e2bb4b-e2b9-4178-bf47-826883ca08cc/resource/"
            "2e917265-3d4e-4660-8256-51c77c435063/download/"
            "airbus_8-10_cali_valid_area_mask.geojson",
        tipo="geojson",
        mb=0.001,
        nota="Dónde vale la predicción del modelo. Fuera de este polígono el ráster de "
             "daño estimado no significa nada, así que conviene tenerlo encima.",
    ),
    Producto(
        clave="hdx-footprints-hdx",
        nombre="Edificaciones con daño estimado · Google (Cali)",
        organizacion="HDX / Microsoft AI for Good Lab",
        url="https://data.humdata.org/dataset/98e2bb4b-e2b9-4178-bf47-826883ca08cc/resource/"
            "d146b2a4-6794-4792-a0df-31841312b85c/download/"
            "airbus_8-10_cali_hdx_building_footprints_with_predictions_validated.gpkg",
        tipo="huellas",
        mb=73.3,
        filtro=FILTRO_HUELLAS,
        nota="De las 320.791 huellas del archivo se traen las 1.054 que el modelo marca con "
             "algún indicio; el resto dejaría el visor lento para todo el equipo. Clasificar "
             "por damage_pct_0m; unas pocas vienen marcadas sin porcentaje.",
    ),
    Producto(
        clave="hdx-footprints-overture",
        nombre="Edificaciones con daño estimado · Overture (Cali)",
        organizacion="HDX / Microsoft AI for Good Lab",
        url="https://data.humdata.org/dataset/98e2bb4b-e2b9-4178-bf47-826883ca08cc/resource/"
            "a00eebfb-0590-456a-b46d-4633122330d9/download/"
            "airbus_8-10_cali_overture_building_footprints_with_predictions.gpkg",
        tipo="huellas",
        mb=27.1,
        filtro=FILTRO_HUELLAS,
        nota="De las 97.351 huellas de Overture se traen las 570 marcadas. Mismo criterio que "
             "el anterior; sirve para contrastar las dos fuentes de huellas entre sí.",
    ),
)

PRODUCTO_POR_CLAVE = {p.clave: p for p in PRODUCTOS}


# ---------------------------------------------------------------------------
# Endpoints de contexto y descubrimiento
# ---------------------------------------------------------------------------
# Ficha del evento: que paso, segun quien.
URL_GDACS = "https://www.gdacs.org/gdacsapi/api/events/geteventdata?eventtype=EQ&eventid=1557236"
URL_EMS = ("https://rapidmapping.emergency.copernicus.eu/backend/dashboard-api/"
           "public-activations/?code=EMSR916")

# Indice de todo lo publico del programa DRP. Sirve para enterarse de las capas
# que Esri Colombia publica DESPUES de escribir este catalogo, que en una
# emergencia en curso son varias por dia.
ORG_DRP = "vC1CdlKWEAtuT38d"
URL_PORTAL = (f"https://www.arcgis.com/sharing/rest/search?q=orgid:{ORG_DRP}"
              "&f=json&num=100&sortField=modified&sortOrder=desc")
