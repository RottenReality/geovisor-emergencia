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
