"""Invariantes del catalogo de fuentes externas.

No prueba logica: prueba que el catalogo sea coherente consigo mismo. Son
errores que no dan excepcion y solo se notan mirando el mapa, que durante una
emergencia es tarde.

Se ejecutan con:  cd backend && python -m unittest discover -s tests -v
"""
import unittest

from app import fuentes


class Coherencia(unittest.TestCase):
    def test_no_hay_claves_repetidas(self):
        # La clave identifica la fuente en la pila y en la tabla `externas`.
        claves = [f.clave for f in fuentes.CATALOGO]
        self.assertEqual(len(claves), len(set(claves)))

    def test_todas_las_fuentes_tienen_un_tema_del_catalogo(self):
        temas = {clave for clave, _, _ in fuentes.TEMAS}
        for fuente in fuentes.CATALOGO:
            self.assertIn(fuente.tema, temas, fuente.clave)

    def test_los_campos_de_fecha_estan_en_la_lista_blanca(self):
        # _recortar() filtra por `campos` ANTES de convertir las fechas: un
        # campo de fecha que no este en la lista blanca ya no existe cuando le
        # toca convertirse, y la declaracion seria letra muerta sin avisar.
        for fuente in fuentes.CATALOGO:
            if not (fuente.fechas and fuente.campos):
                continue
            for campo in fuente.fechas:
                self.assertIn(campo, fuente.campos,
                              f"{fuente.clave}: {campo} se declara como fecha "
                              f"pero la lista blanca lo descarta")

    def test_el_campo_de_la_simbologia_sale_hacia_el_navegador(self):
        # Simbolizar por un atributo que la lista blanca elimina deja la capa
        # de un solo color, sin ningun error que lo delate.
        for fuente in fuentes.CATALOGO:
            if not (fuente.simbologia and fuente.campos):
                continue
            campo = fuente.simbologia.get("campo")
            if campo:
                self.assertIn(campo, fuente.campos,
                              f"{fuente.clave}: simboliza por {campo}, que la "
                              f"lista blanca descarta")

    def test_el_titulo_de_la_ficha_sale_hacia_el_navegador(self):
        for fuente in fuentes.CATALOGO:
            if fuente.titulo and fuente.campos:
                self.assertIn(fuente.titulo, fuente.campos,
                              f"{fuente.clave}: el titulo de la ficha es "
                              f"{fuente.titulo}, que la lista blanca descarta")
