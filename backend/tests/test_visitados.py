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
