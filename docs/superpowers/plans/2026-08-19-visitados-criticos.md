# Visitados críticos de Cali — plan de implementación

> **Para agentes:** SUB-SKILL OBLIGATORIA: usar superpowers:subagent-driven-development (recomendado) o superpowers:executing-plans para implementar tarea por tarea. Los pasos llevan casilla (`- [ ]`) para ir marcándolos.

**Objetivo:** Que el visor muestre en vivo los casos Visitado Crítico (colapso A o B) de la Alcaldía de Cali, como una fuente externa más del catálogo.

**Arquitectura:** Un tipo `visitados` en el despacho `_LECTORES` de `externas.py`, igual que el que ya existe para GDACS. El aplanado de la respuesta anidada vive en `backend/app/visitados.py`, un módulo puro sin red ni base, para poder probarlo entero con la biblioteca estándar. Las credenciales llegan por entorno y nunca tocan el repo.

**Tecnologías:** Python 3.11, FastAPI, httpx, `unittest` de la biblioteca estándar. Sin dependencias nuevas.

**Spec:** `docs/superpowers/specs/2026-08-19-visitados-criticos-design.md`

## Restricciones globales

- Identificadores y comentarios en castellano **sin tildes ni eñes** (`danos`, `anio`). Los textos que ve el usuario **sí** llevan tildes.
- Mensajes de commit en castellano, imperativo, sin tildes, terminados en `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- Finales de línea LF en el repo (el árbol de trabajo en Windows los ve como CRLF; `core.autocrlf=true` ya lo resuelve).
- **Nunca** meter credenciales ni datos personales reales en git. Los fixtures de prueba son sintéticos, escritos a mano.
- No añadir dependencias de terceros.
- Las credenciales ya están puestas en `/opt/geovisor/.env` de la VPS, entre comillas simples porque la clave lleva un `$` y ese archivo lo lee tanto `. ./.env` en `deploy.sh` como el parser de docker compose.

---

### Tarea 1: Utilidades puras de `visitados.py` (fechas y lectura anidada)

**Archivos:**
- Crear: `backend/app/visitados.py`
- Crear: `backend/tests/test_visitados.py`

**Interfaces:**
- Consume: nada.
- Produce: `fecha(ms) -> str | None`, `de(objeto, *ruta) -> valor | None`, `COLOMBIA` (tzinfo).

- [ ] **Paso 1: Escribir las pruebas que fallan**

Crear `backend/tests/test_visitados.py`:

```python
"""Pruebas del aplanado de Visitados criticos. Sin red y sin base.

Los datos son SINTETICOS a proposito: meter un caso real en el repo dejaria
nombres, cedulas y telefonos de personas en el historial de git, de donde ya
no se sacan.

Se ejecutan con:  cd backend && python -m unittest discover -s tests -v
"""
import unittest

from app import visitados


class Fechas(unittest.TestCase):
    def test_milisegundos_a_fecha_legible_en_hora_de_colombia(self):
        # 1786467600000 = 2026-08-11 17:00 UTC = 12:00 en Colombia (UTC-5)
        self.assertEqual(visitados.fecha(1786467600000), "2026-08-11 12:00")

    def test_sin_fecha_no_se_inventa_1970(self):
        self.assertIsNone(visitados.fecha(None))

    def test_un_texto_no_es_una_fecha(self):
        self.assertIsNone(visitados.fecha("ayer"))

    def test_un_booleano_no_es_una_fecha(self):
        # En Python True es un int, y sin cuidado saldria como 1970-01-01.
        self.assertIsNone(visitados.fecha(True))


class LecturaAnidada(unittest.TestCase):
    def test_lee_una_ruta_de_varios_tramos(self):
        self.assertEqual(visitados.de({"a": {"b": {"c": 7}}}, "a", "b", "c"), 7)

    def test_un_tramo_nulo_no_revienta(self):
        self.assertIsNone(visitados.de({"a": None}, "a", "b"))

    def test_una_clave_que_no_esta_devuelve_nulo(self):
        self.assertIsNone(visitados.de({"a": {}}, "a", "b"))

    def test_un_tramo_que_no_es_diccionario_devuelve_nulo(self):
        self.assertIsNone(visitados.de({"a": "texto"}, "a", "b"))
```

- [ ] **Paso 2: Ejecutarlas y ver que fallan**

Ejecutar: `cd backend && python -m unittest tests.test_visitados -v`
Esperado: FALLA con `ModuleNotFoundError: No module named 'app.visitados'`

- [ ] **Paso 3: Escribir el módulo mínimo**

Crear `backend/app/visitados.py`:

```python
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
```

- [ ] **Paso 4: Ejecutar y ver que pasan**

Ejecutar: `cd backend && python -m unittest tests.test_visitados -v`
Esperado: 8 pruebas OK

- [ ] **Paso 5: Commit**

```bash
git add backend/app/visitados.py backend/tests/test_visitados.py
git commit -m "$(cat <<'EOF'
Anadir las utilidades de fecha y lectura anidada de Visitados criticos

La API lo da todo en epoch de milisegundos y con bloques que pueden faltar
enteros. Modulo puro para poder probarlo sin red ni base.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Tarea 2: Aplanado completo de un caso

**Archivos:**
- Modificar: `backend/app/visitados.py`
- Modificar: `backend/tests/test_visitados.py`

**Interfaces:**
- Consume: `fecha()`, `de()` de la Tarea 1.
- Produce: `aplanar(respuesta: dict) -> list[dict]`, donde cada elemento es `{"geometry": dict | None, "properties": dict}` — exactamente lo que `_coleccion()` de `externas.py` espera recibir. También `DANOS` (dict clave→propiedad) y `origen(place_id) -> str | None`.

- [ ] **Paso 1: Añadir el fixture sintético y las pruebas que fallan**

Añadir al final de `backend/tests/test_visitados.py`:

```python
# --- Caso sintetico -------------------------------------------------------
# Inventado entero. Reproduce la forma de la respuesta real, no su contenido.
CASO = {
    "id": "caso-1",
    "estado": "critico",
    "estadoEtiqueta": "Visitado Crítico",
    "direccion": "Calle Falsa 123, Cali",
    "lat": 3.45, "lng": -76.53,
    "placeId": "verified:3.45000,-76.53000",
    "comuna": 5, "comunaEtiqueta": "Comuna 05",
    "barrio": "Barrio Inventado",
    "resumenUnidad": None,
    "ingreso": {
        "descripcion": "Reporte de prueba",
        "tipoColapso": "B", "tipoColapsoEtiqueta": "RIESGO COLAPSO",
        "tipoInmueble": "casa", "tipoInmuebleEtiqueta": "Casa",
        "nombreEdificio": None, "numeroApartamento": None, "numeroCasa": "12",
        "edificioCompleto": False,
        "contacto": {"nombre": "Persona Ingreso", "telefono": "1", "cedula": "1"},
        "creado_utc": 1786467600000, "enviado_utc": 1786471200000,
        "estado": "submitted", "estadoEtiqueta": "Enviado", "completado": True,
    },
    "contacto": {"nombre": "Persona Afectada", "telefono": "+570000000000",
                 "cedula": "000000"},
    "inmueble": {
        "tipoInmueble": "casa", "tipoInmuebleEtiqueta": "Casa",
        "nombreEdificio": "Edificio Inventado", "numeroApartamento": "301",
        "numeroCasa": None, "edificioCompleto": True,
    },
    "operarioIngreso": {"id": "op-1", "nombre": "Operario Uno",
                        "correo": "op@ejemplo.test"},
    "tecnicoVerificacion": {
        "id": "tec-1", "nombre": "Tecnico Uno", "correo": "tec@ejemplo.test",
        "profesion": "Ingeniero Civil", "cedula": "111", "telefono": "222",
        "matriculaProfesional": "333", "enfasis": "Estructuras",
        "anosExperiencia": 10,
    },
    "verificacion_asignada_utc": 1786467600000,
    "evaluacion": {
        "id": "ev-1", "creado_utc": 1786467600000,
        "visitado": True, "puedeEvaluar": True,
        "tipoColapso": "A", "tipoColapsoEtiqueta": "COLAPSO TOTAL",
        "tipoInmueble": "casa", "tipoInmuebleEtiqueta": "Casa",
        "nombreEdificio": None, "numeroApartamento": None, "numeroCasa": None,
        "edificioCompleto": None,
        "pisosSobreNivel": 3, "sotanos": 1,
        "anioConstruccion": "1931_1984",
        "anioConstruccionEtiqueta": "Entre 1931 y 1984",
        "alcanceInspeccion": "exterior",
        "alcanceInspeccionEtiqueta": "En el exterior (no se permite el ingreso)",
        "danos": [
            {"clave": "damageWallsFacades", "valor": "severo", "valorEtiqueta": "Severo"},
            {"clave": "damagePartitions", "valor": "leve", "valorEtiqueta": "Leve"},
            {"clave": "damageCeilings", "valor": "none", "valorEtiqueta": "Ninguno"},
            {"clave": "damageRoof", "valor": "moderado", "valorEtiqueta": "Moderado"},
            {"clave": "damageStairs", "valor": "severo", "valorEtiqueta": "Severo"},
            {"clave": "damagePublicServices", "valor": "none", "valorEtiqueta": "Ninguno"},
        ],
        "victimas": {"fallecidos": 0, "atrapados": 1, "rescatados": 1,
                     "necesitaEvacuacion": True, "evacuados": 4, "porEvacuar": 2},
        "habitabilidad": "not_habitable",
        "habitabilidadEtiqueta": "No habitable",
        "conceptoTecnico": "No se permite el ingreso.",
        "aspectosVisitaEspecializada": None,
        "contacto": {"nombre": "Persona Afectada", "telefono": "+570000000000",
                     "cedula": "000000"},
    },
    "mensajes": [
        {"id": "m1", "texto": "hola", "creado_utc": 1786467600000,
         "autor": {"rol": "operario", "nombre": "Operario Uno"}},
        {"id": "m2", "texto": "recibido", "creado_utc": 1786471200000,
         "autor": {"rol": "admin", "nombre": "Admin"}},
    ],
}


def solo(caso):
    """Aplana un unico caso y devuelve sus propiedades."""
    return visitados.aplanar({"casos": [caso]})[0]["properties"]


class Aplanado(unittest.TestCase):
    def test_devuelve_un_elemento_por_caso(self):
        self.assertEqual(len(visitados.aplanar({"casos": [CASO, CASO]})), 2)

    def test_la_geometria_es_el_punto_del_caso(self):
        elemento = visitados.aplanar({"casos": [CASO]})[0]
        self.assertEqual(elemento["geometry"],
                         {"type": "Point", "coordinates": [-76.53, 3.45]})

    def test_ubicacion_e_identificacion(self):
        p = solo(CASO)
        self.assertEqual(p["id"], "caso-1")
        self.assertEqual(p["direccion"], "Calle Falsa 123, Cali")
        self.assertEqual(p["barrio"], "Barrio Inventado")
        self.assertEqual(p["comuna"], "Comuna 05")

    def test_el_colapso_sale_de_la_evaluacion_no_del_ingreso(self):
        # El ingreso dice B y la evaluacion dice A: manda la evaluacion, que
        # es la que hizo el tecnico en sitio.
        p = solo(CASO)
        self.assertEqual(p["colapso"], "A")
        self.assertEqual(p["ingreso_colapso"], "RIESGO COLAPSO")

    def test_habitabilidad_y_concepto(self):
        p = solo(CASO)
        self.assertEqual(p["habitabilidad"], "No habitable")
        self.assertEqual(p["concepto_tecnico"], "No se permite el ingreso.")

    def test_los_seis_danos_van_a_sus_seis_propiedades(self):
        p = solo(CASO)
        self.assertEqual(p["dano_muros_fachadas"], "Severo")
        self.assertEqual(p["dano_divisiones"], "Leve")
        self.assertEqual(p["dano_cielos"], "Ninguno")
        self.assertEqual(p["dano_cubierta"], "Moderado")
        self.assertEqual(p["dano_escaleras"], "Severo")
        self.assertEqual(p["dano_servicios"], "Ninguno")

    def test_una_clave_de_dano_desconocida_no_se_pierde(self):
        caso = {**CASO, "evaluacion": {
            **CASO["evaluacion"],
            "danos": [{"clave": "damageNuevo", "valor": "leve",
                       "valorEtiqueta": "Leve"}]}}
        self.assertEqual(solo(caso)["dano_damageNuevo"], "Leve")

    def test_sin_danos_las_seis_propiedades_existen_vacias(self):
        # Tienen que estar aunque no haya dato: si aparecen y desaparecen, la
        # tabla de atributos cambia de columnas entre recargas.
        caso = {**CASO, "evaluacion": {**CASO["evaluacion"], "danos": []}}
        p = solo(caso)
        for nombre in visitados.DANOS.values():
            self.assertIn(nombre, p)
            self.assertIsNone(p[nombre])

    def test_victimas(self):
        p = solo(CASO)
        self.assertEqual(p["fallecidos"], 0)
        self.assertEqual(p["atrapados"], 1)
        self.assertEqual(p["evacuados"], 4)
        self.assertEqual(p["por_evacuar"], 2)
        self.assertEqual(p["necesita_evacuacion"], True)

    def test_las_fechas_salen_legibles(self):
        p = solo(CASO)
        self.assertEqual(p["evaluado"], "2026-08-11 12:00")
        self.assertEqual(p["ingreso_creado"], "2026-08-11 12:00")

    def test_datos_de_personas(self):
        # Decision explicita del equipo, documentada en la spec.
        p = solo(CASO)
        self.assertEqual(p["contacto_nombre"], "Persona Afectada")
        self.assertEqual(p["contacto_cedula"], "000000")
        self.assertEqual(p["tecnico_nombre"], "Tecnico Uno")
        self.assertEqual(p["tecnico_matricula"], "333")
        self.assertEqual(p["operario_correo"], "op@ejemplo.test")

    def test_el_contacto_se_toma_solo_de_la_raiz(self):
        # Viene repetido en raiz, ingreso y evaluacion: una sola copia.
        p = solo(CASO)
        self.assertNotIn("ingreso_contacto_nombre", p)

    def test_la_conversacion_se_resume(self):
        p = solo(CASO)
        self.assertEqual(p["mensajes_cantidad"], 2)
        self.assertEqual(p["mensajes_ultimo"], "2026-08-11 13:00")

    def test_no_sale_el_texto_de_los_mensajes(self):
        self.assertNotIn("hola", str(solo(CASO)))

    def test_el_estado_constante_no_se_copia(self):
        # Vale "critico" en todos los casos de esta API.
        self.assertNotIn("estado", solo(CASO))


class CasosIncompletos(unittest.TestCase):
    def test_sin_tecnico_ni_operario_no_revienta(self):
        caso = {**CASO, "tecnicoVerificacion": None, "operarioIngreso": None}
        p = solo(caso)
        self.assertIsNone(p["tecnico_nombre"])
        self.assertIsNone(p["operario_correo"])

    def test_sin_evaluacion_no_revienta(self):
        caso = {**CASO, "evaluacion": None}
        p = solo(caso)
        self.assertIsNone(p["colapso"])
        self.assertIsNone(p["habitabilidad"])

    def test_sin_coordenadas_el_elemento_va_sin_geometria(self):
        # _coleccion() los descarta y los cuenta, y asi el visor puede avisar
        # de cuantos registros de la fuente no estan en el mapa.
        caso = {**CASO, "lat": None, "lng": None}
        self.assertIsNone(visitados.aplanar({"casos": [caso]})[0]["geometry"])

    def test_una_respuesta_sin_casos_devuelve_lista_vacia(self):
        self.assertEqual(visitados.aplanar({"ok": True}), [])

    def test_una_respuesta_vacia_devuelve_lista_vacia(self):
        self.assertEqual(visitados.aplanar({}), [])
        self.assertEqual(visitados.aplanar(None), [])


class OrigenDeCoordenadas(unittest.TestCase):
    def test_reconoce_los_prefijos_conocidos(self):
        self.assertEqual(visitados.origen("verified:3.45,-76.53"), "verified")
        self.assertEqual(visitados.origen("manual:3.45,-76.53"), "manual")
        self.assertEqual(visitados.origen("arcgis:abc-123"), "arcgis")

    def test_un_identificador_de_google_se_resume(self):
        # No aporta nada y ocupa 27 caracteres en cada punto.
        self.assertEqual(visitados.origen("ChIJ24JA3fyjMI4Re3b5Wm3BuPQ"), "google")

    def test_sin_placeid_no_hay_origen(self):
        self.assertIsNone(visitados.origen(None))
        self.assertIsNone(visitados.origen(""))
```

- [ ] **Paso 2: Ejecutarlas y ver que fallan**

Ejecutar: `cd backend && python -m unittest tests.test_visitados -v`
Esperado: FALLA con `AttributeError: module 'app.visitados' has no attribute 'aplanar'`

- [ ] **Paso 3: Implementar el aplanado**

Añadir al final de `backend/app/visitados.py`:

```python
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
```

- [ ] **Paso 4: Ejecutar y ver que pasan**

Ejecutar: `cd backend && python -m unittest discover -s tests -v`
Esperado: todas OK (las 8 de la Tarea 1, las nuevas de esta, y las 17 de `test_pila`)

- [ ] **Paso 5: Commit**

```bash
git add backend/app/visitados.py backend/tests/test_visitados.py
git commit -m "$(cat <<'EOF'
Aplanar un caso de Visitados criticos a un punto con sus atributos

La respuesta viene anidada a tres niveles y con bloques que faltan en buena
parte de los casos: 83 de 413 sin tecnico y 51 sin operario. El aplanado los
da por normales y deja la propiedad vacia en vez de fallar.

Los seis danos salen siempre, aunque no haya dato, para que la tabla de
atributos no cambie de columnas entre recargas.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Tarea 3: Credenciales por entorno

**Archivos:**
- Modificar: `backend/app/config.py`
- Modificar: `.env.example`

**Interfaces:**
- Produce: `config.VISITADOS_USUARIO: str`, `config.VISITADOS_CLAVE: str` (cadena vacía si no están puestas).

- [ ] **Paso 1: Añadir las dos variables**

En `backend/app/config.py`, justo después del bloque de `TITILER_URL`:

```python
# API de Visitados criticos de la Alcaldia de Cali (Basic Auth). Opcionales a
# proposito: sin ellas el visor arranca igual y solo esa capa avisa de que
# falta configurarlas. Un despliegue no debe caerse entero por una fuente.
VISITADOS_USUARIO = os.environ.get("VISITADOS_USUARIO", "")
VISITADOS_CLAVE = os.environ.get("VISITADOS_CLAVE", "")
```

- [ ] **Paso 2: Documentarlas en `.env.example`**

Añadir al final de `.env.example`:

```
# API de Visitados criticos (Alcaldia de Cali). Basic Auth: el correo
# habilitado y la contrasena creada en https://atencionsismo.cali.gov.co/operario
#
# IMPORTANTE: entre comillas simples SIEMPRE. Este archivo lo leen tanto
# `. ./.env` de deploy.sh como docker compose, y los dos expanden un $ que
# aparezca suelto en el valor.
VISITADOS_USUARIO='correo@ejemplo.com'
VISITADOS_CLAVE='la-contrasena-del-portal'
```

- [ ] **Paso 3: Comprobar que no se ha colado ninguna credencial real**

Ejecutar:

```bash
# El patron se saca del .env del servidor y NUNCA se escribe aqui: un documento
# que enumera las credenciales para comprobar que no estan en el repo acaba de
# meterlas en el repo. (Paso aprendido a base de cometerlo.)
ssh root@5.161.176.32 "grep -oP \"^VISITADOS_\w+='?\K[^']+\" /opt/geovisor/.env" > /tmp/secretos.txt
git diff --cached | grep -Ff /tmp/secretos.txt && echo "FUGA" || echo "limpio"
rm -f /tmp/secretos.txt
```

Esperado: `limpio`. `.env` está en `.gitignore` y solo existe en la VPS.

- [ ] **Paso 4: Comprobar que el módulo sigue importándose**

Ejecutar: `cd backend && python -c "import ast,sys; ast.parse(open('app/config.py').read()); print('sintaxis correcta')"`
Esperado: `sintaxis correcta`

- [ ] **Paso 5: Commit**

```bash
git add backend/app/config.py .env.example
git commit -m "$(cat <<'EOF'
Leer del entorno las credenciales de Visitados criticos

Opcionales: sin ellas el visor arranca igual y solo esa capa avisa. Un
despliegue no debe caerse entero por una fuente externa.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Tarea 4: La fuente en el catálogo

**Archivos:**
- Modificar: `backend/app/fuentes.py`

**Interfaces:**
- Consume: nada.
- Produce: `fuentes.VISITADOS_DESDE_UTC: int`, `fuentes.COLAPSO_CALI: dict`, y la entrada `cali-visitados-criticos` en `CATALOGO` con `tipo="visitados"`.

- [ ] **Paso 1: Añadir la paleta y la ventana**

En `backend/app/fuentes.py`, junto a las demás paletas (después de `HABITABILIDAD_ETIQUETAS`):

```python
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
```

- [ ] **Paso 2: Añadir la fuente al catálogo**

En `CATALOGO`, como primera entrada del tema `dano`, justo antes de la fuente `ungrd-ede`:

```python
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
```

- [ ] **Paso 3: Documentar el tipo nuevo en el `docstring` de `Fuente`**

En la lista de tipos del `docstring` de la clase `Fuente`, añadir tras la línea de `gdacs`:

```
      visitados API autenticada de la Alcaldia de Cali (Basic Auth + ventana)
```

- [ ] **Paso 4: Corregir la nota de datos personales de la cabecera**

En el `docstring` del módulo, sustituir el párrafo que empieza por `Datos personales` por:

```
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
```

- [ ] **Paso 5: Comprobar que el catálogo sigue siendo válido**

Ejecutar:

```bash
cd backend && python -c "
import sys; sys.path.insert(0, '.')
from app import fuentes
f = fuentes.POR_CLAVE['cali-visitados-criticos']
print('clave:', f.clave, '| tipo:', f.tipo, '| tema:', f.tema)
print('simbologia:', f.simbologia['campo'], f.simbologia['orden'])
print('ventana desde:', fuentes.VISITADOS_DESDE_UTC)
print('claves duplicadas:', len(fuentes.CATALOGO) != len(fuentes.POR_CLAVE))
"
```

Esperado: `tipo: visitados`, `simbologia: colapso ['A', 'B']`, `claves duplicadas: False`

- [ ] **Paso 6: Commit**

```bash
git add backend/app/fuentes.py
git commit -m "$(cat <<'EOF'
Anadir Visitados criticos de Cali al catalogo de fuentes

Encabeza el tema de danos: son los casos con colapso ya verificado en sitio.
Se pinta con los rojos de Copernicus para que lo mas grave sea siempre el
mismo color en todo el visor.

La cabecera del modulo decia que ninguna capa publica datos de contacto. Con
esta fuente deja de ser cierto, asi que la nota lo dice.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Tarea 5: El lector con autenticación

**Archivos:**
- Modificar: `backend/app/routers/externas.py`

**Interfaces:**
- Consume: `visitados.aplanar()` (Tarea 2), `config.VISITADOS_USUARIO`/`VISITADOS_CLAVE` (Tarea 3), `fuentes.VISITADOS_DESDE_UTC` (Tarea 4), y las funciones `_coleccion()` y `_cliente` que ya existen en el archivo.
- Produce: la entrada `"visitados": _de_visitados` en `_LECTORES`.

- [ ] **Paso 1: Importar el módulo**

En la línea de importaciones del proyecto (junto a `from .. import config, db, fuentes`), dejarla así:

```python
from .. import config, db, fuentes, visitados
```

- [ ] **Paso 2: Escribir el lector**

Añadir justo antes del diccionario `_LECTORES`:

```python
async def _de_visitados(fuente: fuentes.Fuente) -> dict:
    """API autenticada de la Alcaldia de Cali.

    Es la unica fuente con credenciales y con parametros obligatorios: sin la
    ventana de fechas responde 400. Se pide siempre desde el principio de la
    emergencia, que hoy cabe de sobra en una llamada.
    """
    if not (config.VISITADOS_USUARIO and config.VISITADOS_CLAVE):
        raise HTTPException(
            status_code=503,
            detail="Falta configurar VISITADOS_USUARIO y VISITADOS_CLAVE "
                   "en el .env del servidor.")

    ventana = {
        "desde_utc": fuentes.VISITADOS_DESDE_UTC,
        "hasta_utc": int(time.time() * 1000),
    }
    try:
        respuesta = await _cliente.get(
            fuente.url, params=ventana, timeout=120.0,
            auth=(config.VISITADOS_USUARIO, config.VISITADOS_CLAVE))
        respuesta.raise_for_status()
    except httpx.HTTPStatusError as excepcion:
        # Un 401 o un 403 aqui no es "el servidor no responde": es un problema
        # de configuracion nuestro, y decirlo ahorra ir a mirar los registros.
        codigo = excepcion.response.status_code
        if codigo == 401:
            raise HTTPException(
                status_code=502,
                detail="La Alcaldía de Cali rechazó las credenciales de Visitados "
                       "críticos. Revisar VISITADOS_USUARIO y VISITADOS_CLAVE "
                       "en el .env del servidor.") from excepcion
        if codigo == 403:
            raise HTTPException(
                status_code=502,
                detail="El correo está habilitado pero todavía no tiene contraseña "
                       "creada en el portal de operarios de la Alcaldía de Cali."
            ) from excepcion
        raise

    return _coleccion(visitados.aplanar(respuesta.json()), fuente)
```

- [ ] **Paso 3: Registrarlo en el despacho**

```python
_LECTORES = {
    "arcgis": _de_arcgis,
    "geojson": _de_geojson,
    "lista": _de_lista,
    "gdacs": _de_gdacs,
    "visitados": _de_visitados,
}
```

- [ ] **Paso 4: Comprobar la sintaxis y que el lector queda registrado**

Ejecutar:

```bash
cd backend && python -c "
import ast
arbol = ast.parse(open('app/routers/externas.py').read())
print('sintaxis correcta')
print('define _de_visitados:', any(
    isinstance(n, ast.AsyncFunctionDef) and n.name == '_de_visitados'
    for n in ast.walk(arbol)))
print('registrado:', '\"visitados\": _de_visitados' in open('app/routers/externas.py').read())
"
```

Esperado: las tres líneas afirmativas.

- [ ] **Paso 5: Commit**

```bash
git add backend/app/routers/externas.py
git commit -m "$(cat <<'EOF'
Leer la API de Visitados criticos con Basic Auth y ventana de fechas

Es la unica fuente del catalogo con credenciales y con parametros
obligatorios. Un 401 o un 403 se traducen a un mensaje que dice que revisar,
en vez del 502 generico de "no responde", que mandaria a mirar los registros
para nada.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Tarea 6: Desplegar y verificar contra la API real

**Archivos:** ninguno. Es la comprobación de que lo anterior funciona de punta a punta.

- [ ] **Paso 1: Todas las pruebas en verde antes de desplegar**

Ejecutar: `cd backend && python -m unittest discover -s tests -v`
Esperado: OK, sin fallos ni errores.

- [ ] **Paso 2: Empujar y desplegar**

```bash
git push origin main
ssh root@5.161.176.32 "cd /opt/geovisor && ./deploy.sh 2>&1 | tail -12"
```

Esperado: `API respondiendo`, y los seis contenedores `oar_*` en pie al final.

- [ ] **Paso 3: Comprobar que la capa aparece en el catálogo**

```bash
ssh root@5.161.176.32 "cd /opt/geovisor; D=\$(grep -oP '^DOMINIO=\K.*' .env); CL=\$(grep -oP '^CLAVE_ACCESO=\K.*' .env); C=/tmp/v.txt
curl -sk -c \$C -X POST https://\$D/api/login -H 'Content-Type: application/json' -d \"{\\\"clave\\\":\\\"\$CL\\\"}\" -o /dev/null
curl -sk -b \$C https://\$D/api/externas | python3 -c \"
import json,sys
d = json.load(sys.stdin)
f = [x for x in d['fuentes'] if x['clave'] == 'cali-visitados-criticos']
print('esta en el catalogo:', bool(f))
print(json.dumps(f[0], ensure_ascii=False)[:300] if f else '')\"
rm -f \$C"
```

Esperado: `esta en el catalogo: True`

- [ ] **Paso 4: Encender la capa y comprobar el GeoJSON real**

```bash
ssh root@5.161.176.32 "cd /opt/geovisor; D=\$(grep -oP '^DOMINIO=\K.*' .env); CL=\$(grep -oP '^CLAVE_ACCESO=\K.*' .env); C=/tmp/v.txt
curl -sk -c \$C -X POST https://\$D/api/login -H 'Content-Type: application/json' -d \"{\\\"clave\\\":\\\"\$CL\\\"}\" -o /dev/null
curl -sk -b \$C 'https://\$D/api/externas/cali-visitados-criticos.geojson' -o /tmp/vc.geojson -w 'http %{http_code}  %{size_download} bytes  %{time_total}s\n'
python3 -c \"
import json, collections
d = json.load(open('/tmp/vc.geojson'))
print('entidades:', len(d['features']))
print('sin ubicacion:', d.get('sin_ubicacion'))
p = d['features'][0]['properties']
print('propiedades por punto:', len(p))
print('colapso:', dict(collections.Counter(f['properties']['colapso'] for f in d['features'])))
print('fechas legibles:', p['evaluado'])
print('los seis danos presentes:', all(k in p for k in
      ('dano_muros_fachadas','dano_divisiones','dano_cielos',
       'dano_cubierta','dano_escaleras','dano_servicios')))
print('sin texto de mensajes:', 'mensajes_ultimo' in p and 'texto' not in p)\"
rm -f \$C"
```

Esperado: `http 200`, unas 413 entidades, `sin ubicacion: 0`, 54 propiedades, `colapso: {'B': 372, 'A': 41}` (los números crecerán), fecha con formato `2026-08-11 12:00`, y las dos últimas líneas en `True`.

- [ ] **Paso 5: Comprobar el mensaje de credenciales rechazadas**

Sin tocar el `.env` bueno: se levanta un contenedor de usar y tirar con una clave mala y se comprueba el texto del error.

```bash
ssh root@5.161.176.32 "cd /opt/geovisor
docker compose run --rm -e VISITADOS_CLAVE='clave-mala' --entrypoint python api -c \"
import asyncio, httpx
from app import config, fuentes
async def probar():
    async with httpx.AsyncClient(timeout=30) as c:
        r = await c.get(fuentes.POR_CLAVE['cali-visitados-criticos'].url,
                        params={'desde_utc': fuentes.VISITADOS_DESDE_UTC,
                                'hasta_utc': 1790000000000},
                        auth=(config.VISITADOS_USUARIO, 'clave-mala'))
        print('codigo con clave mala:', r.status_code)
asyncio.run(probar())\""
```

Esperado: `codigo con clave mala: 401` — que es la rama que produce el mensaje sobre revisar `VISITADOS_USUARIO` y `VISITADOS_CLAVE`.

- [ ] **Paso 6: Regresión completa**

```bash
ssh root@5.161.176.32 "cd /opt/geovisor; D=\$(grep -oP '^DOMINIO=\K.*' .env); CL=\$(grep -oP '^CLAVE_ACCESO=\K.*' .env); C=/tmp/v.txt
curl -sk -c \$C -X POST https://\$D/api/login -H 'Content-Type: application/json' -d \"{\\\"clave\\\":\\\"\$CL\\\"}\" -o /dev/null
for R in health api/session api/capas api/rasters api/pila api/externas api/externas/evento api/externas/novedades; do printf '%-26s ' \"\$R\"; curl -sk -b \$C -o /dev/null -w '%{http_code}\n' https://\$D/\$R; done
rm -f \$C
echo '--- errores en el log ---'; docker logs geo_api --since 5m 2>&1 | grep -ciE 'traceback|ERROR:'
echo '--- ajenos ---'; docker ps --filter name=oar_ --format '{{.Names}} {{.Status}}'"
```

Esperado: todo en 200, `0` errores, y los seis `oar_*` en pie.

- [ ] **Paso 7: Comprobar que ninguna credencial llegó al repo**

```bash
# Mismo principio que en la Tarea 3: el patron sale del .env del servidor.
ssh root@5.161.176.32 "grep -oP \"^VISITADOS_\w+='?\K[^']+\" /opt/geovisor/.env" > /tmp/secretos.txt
git log -p --all | grep -Ff /tmp/secretos.txt && echo "FUGA" || echo "limpio"
rm -f /tmp/secretos.txt
```

Esperado: `limpio`

**El repositorio es público.** Cualquier credencial que entre en un commit hay
que darla por comprometida aunque se borre después: queda en el historial, en
los forks y en la caché de GitHub. La única reparación real es rotarla.

---

## Notas para quien ejecute

- **No hay migración de base.** Esta fuente no toca el esquema: se consulta en vivo y la tabla `externas` solo guarda que alguien la encendió, igual que con las demás.
- **La capa no se enciende sola.** Después de desplegar, alguien del equipo tiene que encenderla desde el catálogo de fuentes externas; a partir de ahí queda encendida para todos.
- **El primer encendido tarda unos 3 segundos** (1,6 MB desde Cali). Los siguientes diez minutos salen de la caché.
- **Si la API cambia de forma**, el aplanado no se cae: devuelve la propiedad vacía. El síntoma sería una columna que se queda en blanco, no una capa rota.
