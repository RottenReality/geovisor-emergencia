"""Pruebas de la copia local del catastro.

No tocan ni la red ni la base: prueban la preparacion del lote -que es donde
se aplica la lista blanca- y la coherencia de las seis fuentes del catalogo.

Se ejecutan con:  cd backend && python -m unittest discover -s tests -v
"""
import json
import unittest

from app import catastro, fuentes

CATASTRALES = [f for f in fuentes.CATALOGO if f.tipo == "catastro"]


def _entidad(props, geometria=None):
    return {
        "type": "Feature",
        "properties": props,
        "geometry": geometria or {"type": "Point", "coordinates": [-76.5, 3.4]},
    }


class Preparar(unittest.TestCase):
    def test_la_lista_blanca_deja_fuera_lo_que_no_esta(self):
        lote = [_entidad({"numero_predial_nacional": "760010100", "created_user": "lmajin",
                          "globalid": "{ABC}", "Shape__Area": 123.4})]
        props, _, _ = catastro.preparar(lote, ("numero_predial_nacional",))
        self.assertEqual(json.loads(props[0]), {"numero_predial_nacional": "760010100"})

    def test_no_se_inventan_campos_que_la_fuente_no_mando(self):
        # Declarar un campo en el catalogo no obliga a la fuente a traerlo.
        # Si se rellenara con null, la tabla de atributos mostraria columnas
        # vacias que pareceria que el dato existe y esta en blanco.
        props, _, _ = catastro.preparar([_entidad({"a": 1})], ("a", "b"))
        self.assertEqual(json.loads(props[0]), {"a": 1})

    def test_una_lista_blanca_vacia_deja_pasar_todo(self):
        # Mismo criterio que en las fuentes en vivo. Si se interpretara como
        # "ningun campo", una fuente sin `campos` se guardaria sin atributos.
        props, _, _ = catastro.preparar([_entidad({"a": 1, "b": 2})], ())
        self.assertEqual(json.loads(props[0]), {"a": 1, "b": 2})

    def test_lo_que_no_tiene_geometria_se_cuenta_como_omitido(self):
        lote = [_entidad({"a": 1}), {"type": "Feature", "properties": {"a": 2}, "geometry": None}]
        props, geoms, omitidas = catastro.preparar(lote, ("a",))
        self.assertEqual((len(props), len(geoms), omitidas), (1, 1, 1))

    def test_props_y_geometrias_van_emparejadas(self):
        # Se insertan con unnest de dos arreglos en paralelo: si una entidad
        # sin geometria dejara hueco en una sola de las dos listas, los
        # atributos se pegarian al predio equivocado a partir de ahi.
        lote = [_entidad({"n": 1}), {"type": "Feature", "properties": {"n": 2}},
                _entidad({"n": 3})]
        props, geoms, _ = catastro.preparar(lote, ("n",))
        self.assertEqual(len(props), len(geoms))
        self.assertEqual([json.loads(p)["n"] for p in props], [1, 3])

    def test_los_acentos_se_guardan_como_acentos(self):
        # ensure_ascii convertiria "Jamundí" en "Jamund\\u00ed" dentro del
        # JSONB, y asi es como se guardaria y como saldria en la ficha.
        props, _, _ = catastro.preparar([_entidad({"barrio": "Jamundí"})], ("barrio",))
        self.assertIn("Jamundí", props[0])


class Paginacion(unittest.TestCase):
    def test_se_pagina_por_objectid_y_no_por_offset(self):
        # Con resultOffset, ArcGIS recorre y descarta todo lo anterior en cada
        # peticion, asi que la pagina 750 tarda muchisimo mas que la primera.
        parametros = catastro.consulta_pagina("OBJECTID,npn", 4000)
        self.assertEqual(parametros["where"], "OBJECTID>4000")
        self.assertNotIn("resultOffset", parametros)

    def test_el_orden_es_estable(self):
        # Sin orderByFields el servicio no garantiza el orden entre peticiones,
        # y una descarga por rangos de OBJECTID se saltaria filas en silencio.
        self.assertEqual(catastro.consulta_pagina("*", 0)["orderByFields"], "OBJECTID")

    def test_no_se_pide_mas_de_lo_que_el_servicio_sirve(self):
        # Pedir mas de maxRecordCount no trae mas: ArcGIS recorta en silencio.
        self.assertLessEqual(catastro.consulta_pagina("*", 0)["resultRecordCount"], 2000)

    def test_se_piden_las_entidades_por_encima_del_tope(self):
        # Sin returnExceededLimitFeatures, una capa mas grande que el tope
        # devuelve solo el aviso de que lo excede, sin entidades.
        self.assertEqual(
            catastro.consulta_pagina("*", 0)["returnExceededLimitFeatures"], "true")

    def test_la_geometria_llega_en_4326(self):
        # La tabla guarda siempre 4326; el servicio publica en 3857.
        self.assertEqual(catastro.consulta_pagina("*", 0)["outSR"], 4326)

    def test_objectid_va_siempre_entre_los_campos_pedidos(self):
        # Es lo que ordena y pagina: sin el, la descarga no puede avanzar.
        self.assertTrue(catastro.campos_a_pedir(("npn",)).startswith("OBJECTID"))


class Catalogo(unittest.TestCase):
    def test_hay_seis_capas_catastrales(self):
        self.assertEqual(len(CATASTRALES), 6)

    def test_cada_una_apunta_a_una_capa_concreta_del_servicio(self):
        # La URL tiene que terminar en el numero de capa. Sin el, la consulta
        # iria contra el FeatureServer entero y devolveria un error que solo
        # se veria al importar.
        for fuente in CATASTRALES:
            self.assertRegex(fuente.url, r"/FeatureServer/\d+$", fuente.clave)

    def test_no_se_repite_la_capa_de_origen(self):
        # Dos claves distintas apuntando a la misma capa duplicarian los
        # poligonos en el mapa sin que nada lo delatara.
        urls = [f.url for f in CATASTRALES]
        self.assertEqual(len(urls), len(set(urls)))

    def test_la_lista_blanca_no_esta_vacia(self):
        # En estas capas `campos` no es opcional: el origen trae GUID, nombres
        # de usuario de quien edito y Shape__Area, que multiplicarian el peso
        # de cada tesela sin aportar nada.
        for fuente in CATASTRALES:
            self.assertTrue(fuente.campos, fuente.clave)

    def test_el_zoom_minimo_no_supera_al_maximo(self):
        # Al reves MapLibre no pide ninguna tesela y la capa no se ve nunca,
        # sin ningun error de por medio.
        for fuente in CATASTRALES:
            self.assertLessEqual(fuente.zoom_min, fuente.zoom_max, fuente.clave)

    def test_no_se_dibujan_a_escala_de_ciudad(self):
        # Medido sobre el servicio: una tesela z14 del centro de Cali son
        # 32.000 poligonos de una sola capa. Permitirlo cuelga el navegador.
        for fuente in CATASTRALES:
            self.assertGreaterEqual(fuente.zoom_min, 13, fuente.clave)

    def test_el_campo_de_OBJECTID_no_se_guarda(self):
        # Se pide para paginar, pero no es un atributo del predio y ocuparia
        # sitio en cada tesela.
        for fuente in CATASTRALES:
            self.assertNotIn("OBJECTID", fuente.campos, fuente.clave)
