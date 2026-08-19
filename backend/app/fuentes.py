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

DRP = "https://services.arcgis.com/vC1CdlKWEAtuT38d/arcgis/rest/services/"
IGAC_ORTO = "https://mapas2.igac.gov.co/image2/rest/services/orto/"
INVIAS = "https://hermes.invias.gov.co/arcgis/rest/services/OpenData/ServiciosOpenData/FeatureServer"


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
