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

    def test_se_puede_filtrar_solo_por_lo_que_llega_al_navegador(self):
        # El filtro se aplica sobre los atributos de la tesela, y la tesela
        # solo lleva la lista blanca. Un campo filtrable que no este en
        # `campos` da un desplegable que no filtra nada, sin ningun error.
        for fuente in fuentes.CATALOGO:
            if not (fuente.filtros and fuente.campos):
                continue
            for filtro in fuente.filtros:
                self.assertIn(filtro["campo"], fuente.campos,
                              f"{fuente.clave}: se puede filtrar por "
                              f"{filtro['campo']}, que la lista blanca descarta")

    def test_cada_filtro_dice_como_se_llama(self):
        # Sin etiqueta, el panel mostraria el nombre crudo del campo del
        # servicio ("u_destinos", "tipo_avalu"), que no dice nada en campo.
        for fuente in fuentes.CATALOGO:
            for filtro in fuente.filtros:
                self.assertTrue(filtro.get("etiqueta"),
                                f"{fuente.clave}: {filtro.get('campo')} sin etiqueta")

    def test_no_se_repite_un_campo_filtrable(self):
        for fuente in fuentes.CATALOGO:
            campos = [f["campo"] for f in fuente.filtros]
            self.assertEqual(len(campos), len(set(campos)), fuente.clave)

    def test_lo_que_sale_en_la_leyenda_tiene_color(self):
        # `orden` manda sobre las claves de `colores`: un valor listado ahi
        # que no tenga color se dibuja con el color plano de la capa y la
        # leyenda miente, sin ningun error de por medio.
        for fuente in fuentes.CATALOGO:
            estilo = fuente.simbologia or {}
            if estilo.get("modo") != "categorias":
                continue
            for valor in estilo.get("orden") or ():
                self.assertIn(valor, estilo.get("colores") or {},
                              f"{fuente.clave}: {valor!r} sale en la leyenda "
                              f"pero no tiene color")

    def test_lo_que_sale_en_la_leyenda_tiene_nombre(self):
        # Media capa clasifica por codigo ("h", "i2", "A"). Si hay tabla de
        # etiquetas tiene que cubrir lo que se lee en campo.
        for fuente in fuentes.CATALOGO:
            estilo = fuente.simbologia or {}
            etiquetas = estilo.get("etiquetas")
            if estilo.get("modo") != "categorias" or not etiquetas:
                continue
            for valor in estilo.get("orden") or ():
                self.assertIn(valor, etiquetas,
                              f"{fuente.clave}: {valor!r} sale en la leyenda "
                              f"sin nombre legible")

    def test_los_rangos_tienen_un_color_menos_que_cortes(self):
        # expresionColor() exige colores == cortes - 1. Si no cuadra devuelve
        # el color plano en silencio: la capa se ve de un color y parece que
        # nadie le puso simbologia.
        for fuente in fuentes.CATALOGO:
            estilo = fuente.simbologia or {}
            if estilo.get("modo") != "rangos":
                continue
            cortes, colores = estilo.get("cortes") or [], estilo.get("colores") or []
            self.assertGreaterEqual(len(cortes), 2, fuente.clave)
            self.assertEqual(len(colores), len(cortes) - 1,
                             f"{fuente.clave}: {len(colores)} colores para "
                             f"{len(cortes)} cortes")

    def test_el_titulo_de_la_ficha_sale_hacia_el_navegador(self):
        for fuente in fuentes.CATALOGO:
            if fuente.titulo and fuente.campos:
                self.assertIn(fuente.titulo, fuente.campos,
                              f"{fuente.clave}: el titulo de la ficha es "
                              f"{fuente.titulo}, que la lista blanca descarta")
