"""Pruebas de la conversion de epoch a fecha legible.

Se ejecutan con:  cd backend && python -m unittest discover -s tests -v
"""
import unittest

from app import fechas


class Legible(unittest.TestCase):
    def test_milisegundos_a_fecha_y_hora_de_colombia(self):
        # 1786467600000 = 2026-08-11 17:00 UTC = 12:00 en Colombia (UTC-5)
        self.assertEqual(fechas.legible(1786467600000), "2026-08-11 12:00")

    def test_conserva_la_hora_cuando_la_trae(self):
        # 1786500000000 = 2026-08-12 02:00 UTC = 2026-08-11 21:00 en Colombia
        self.assertEqual(fechas.legible(1786500000000), "2026-08-11 21:00")

    def test_el_formato_ordena_bien_como_texto(self):
        # La tabla de atributos ordena cadenas: enero tiene que quedar antes
        # que diciembre, y para eso el ano va delante.
        enero = fechas.legible(1767225600000)      # 2026-01-01
        agosto = fechas.legible(1785542400000)     # 2026-08-01
        self.assertLess(enero, agosto)

    def test_sin_fecha_no_se_inventa_1970(self):
        self.assertIsNone(fechas.legible(None))

    def test_un_texto_no_es_una_fecha(self):
        self.assertIsNone(fechas.legible("ayer"))

    def test_un_booleano_no_es_una_fecha(self):
        # En Python True es un int, y sin cuidado saldria como 1970-01-01.
        self.assertIsNone(fechas.legible(True))

    def test_un_numero_desmesurado_no_revienta(self):
        # Pasa con centinelas y con campos que no eran fechas. Una capa entera
        # no puede caerse porque un registro traiga basura.
        self.assertIsNone(fechas.legible(10 ** 20))
        self.assertIsNone(fechas.legible(-10 ** 20))

    def test_una_fecha_en_segundos_se_convierte_igualmente(self):
        # No se adivina la unidad: quien declara el campo en el catalogo dice
        # que son milisegundos. Un valor en segundos daria 1970, y eso se ve a
        # simple vista en el mapa, que es justo lo que se quiere que pase.
        self.assertTrue(fechas.legible(1786467600).startswith("1970-"))
