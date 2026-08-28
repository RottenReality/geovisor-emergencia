"""Colocacion de los modelos 3D sobre el mapa.

Lo que se prueba aqui es la unica parte del asunto que se puede equivocar en
silencio: si el modelo queda a la altura que no es, no hay error, no hay traza
en el log y la pantalla sale negra. Cuesta media tarde averiguar por que.

Se ejecutan con:  cd backend && python -m unittest discover -s tests -v
"""
import json
import math
import unittest

from app import fuentes, modelos3d


# Un tileset como los que exporta DJI Terra, recortado a lo que se usa.
# Los numeros son los del vuelo del Cristo Rey.
TILESET = {
    "asset": {"gltfUpAxis": "Z", "version": "0.0"},
    "geometricError": 821.12,
    "root": {
        "boundingVolume": {
            "box": [1479649.0, -6193889.5, 379766.6875,
                    288.25, 0.0, 0.0,
                    0.0, 161.0, 0.0,
                    0.0, 0.0, 244.03125],
        },
        "children": [{"content": {"uri": "BlockR/tileset.json"},
                      "geometricError": 745.32, "refine": "REPLACE"}],
        "geometricError": 821.12,
        "refine": "REPLACE",
    },
}


class Geodesia(unittest.TestCase):
    def test_el_centro_del_vuelo_cae_donde_dice_el_catalogo(self):
        # Si esto se desvia, el boton «Ir a la capa» lleva a otro sitio y el
        # modelo aparece en el borde de la pantalla o fuera de ella.
        lon, lat, altura = modelos3d.a_geodesica(*TILESET["root"]["boundingVolume"]["box"][:3])
        modelo = modelos3d.POR_CLAVE["modelo-cristo-rey"]
        self.assertAlmostEqual(lon, modelo.centro[0], places=2)
        self.assertAlmostEqual(lat, modelo.centro[1], places=2)
        # Cali esta sobre los 1.000 m y el cerro sube a 1.400 y pico.
        self.assertTrue(1200 < altura < 1700, altura)

    def test_la_conversion_es_reversible(self):
        # ECEF de un punto conocido -Greenwich, ecuador, nivel del mar-.
        lon, lat, altura = modelos3d.a_geodesica(6378137.0, 0.0, 0.0)
        self.assertAlmostEqual(lon, 0.0, places=6)
        self.assertAlmostEqual(lat, 0.0, places=6)
        self.assertAlmostEqual(altura, 0.0, places=3)


class Apoyo(unittest.TestCase):
    def test_bajar_el_modelo_lo_deja_a_ras_del_plano(self):
        # El corazon del asunto: tras aplicar la traslacion, el centro del
        # tileset tiene que quedar a altura cero. Es lo que hace que la camara
        # de MapLibre, que vive a la altura que le dicta el zoom, lo vea.
        altura = modelos3d.altura_del_tileset(TILESET)
        apoyado = modelos3d.raiz_apoyada(TILESET, altura)
        t = apoyado["root"]["transform"]

        caja = TILESET["root"]["boundingVolume"]["box"]
        movido = (caja[0] + t[12], caja[1] + t[13], caja[2] + t[14])
        self.assertAlmostEqual(modelos3d.a_geodesica(*movido)[2], 0.0, places=3)

    def test_bajarlo_no_lo_mueve_de_sitio(self):
        # Se baja en vertical, no en diagonal: la grieta tiene que seguir
        # estando sobre el predio que le corresponde.
        altura = modelos3d.altura_del_tileset(TILESET)
        t = modelos3d.raiz_apoyada(TILESET, altura)["root"]["transform"]
        caja = TILESET["root"]["boundingVolume"]["box"]
        antes = modelos3d.a_geodesica(*caja[:3])
        despues = modelos3d.a_geodesica(caja[0] + t[12], caja[1] + t[13], caja[2] + t[14])
        self.assertAlmostEqual(antes[0], despues[0], places=9)
        self.assertAlmostEqual(antes[1], despues[1], places=9)

    def test_la_traslacion_mide_lo_que_se_pidio_bajar(self):
        t = modelos3d.raiz_apoyada(TILESET, 1483.0)["root"]["transform"]
        self.assertAlmostEqual(math.dist((0, 0, 0), t[12:15]), 1483.0, places=6)

    def test_es_una_matriz_de_glTF_valida(self):
        # Columna-mayor, 16 numeros, sin rotacion ni escala: cualquier otra
        # cosa deforma la malla o la tumba de lado.
        t = modelos3d.raiz_apoyada(TILESET, 100.0)["root"]["transform"]
        self.assertEqual(len(t), 16)
        self.assertEqual(t[:12], [1.0, 0.0, 0.0, 0.0,
                                  0.0, 1.0, 0.0, 0.0,
                                  0.0, 0.0, 1.0, 0.0])
        self.assertEqual(t[15], 1.0)

    def test_no_se_toca_el_tileset_original(self):
        # Se sirve una copia porque el original esta en disco y es de 628 MB
        # de archivos que nadie quiere reescribir.
        copia = dict(TILESET)
        modelos3d.raiz_apoyada(TILESET, 1483.0)
        self.assertEqual(TILESET, copia)
        self.assertNotIn("transform", TILESET["root"])

    def test_un_json_que_no_es_un_tileset_se_rechaza(self):
        # Mejor un 500 que lo diga que un modelo invisible.
        for basura in ({}, {"root": {}}, {"root": {"boundingVolume": {}}}):
            with self.assertRaises(ValueError):
                modelos3d.raiz_apoyada(basura, 10.0)

    def test_la_altura_guardada_es_la_de_verdad(self):
        # El navegador recoge z relativa al plano; en la base se guarda la
        # altura elipsoidal, para que recalibrar el apoyo no mueva las marcas
        # ya guardadas.
        modelo = modelos3d.POR_CLAVE["modelo-cristo-rey"]
        self.assertAlmostEqual(modelos3d.altura_real(modelo, 0.0), modelo.altura_base)
        self.assertAlmostEqual(modelos3d.altura_real(modelo, 26.0),
                               modelo.altura_base + 26.0)


class NivelesBastos(unittest.TestCase):
    """El vaciado que hace utilizable un recorte del vuelo."""

    ARBOL = {
        "root": {
            "content": {"uri": "BlockR_L13_1.b3dm"},
            "children": [
                {"content": {"uri": "BlockR_L19_82.b3dm"}, "children": [
                    {"content": {"uri": "BlockR_L23_800.b3dm"}},
                    {"content": {"uri": "BlockR_L20_160.json"}},
                ]},
                {"content": {"uri": "sin_nivel_en_el_nombre.b3dm"}},
            ],
        },
    }

    def _uris(self, tile, acc=None):
        acc = [] if acc is None else acc
        uri = (tile.get("content") or {}).get("uri")
        if uri:
            acc.append(uri)
        for h in tile.get("children", []):
            self._uris(h, acc)
        return acc

    def test_se_quita_lo_basto_y_se_queda_lo_fino(self):
        # Un recorte hereda las teselas bastas con la malla del vuelo entero:
        # son las que dibujan planos por delante del monumento.
        salida = modelos3d.sin_niveles_bastos(self.ARBOL, 20)
        uris = self._uris(salida["root"])
        self.assertNotIn("BlockR_L13_1.b3dm", uris)
        self.assertNotIn("BlockR_L19_82.b3dm", uris)
        self.assertIn("BlockR_L23_800.b3dm", uris)

    def test_los_nodos_siguen_estando(self):
        # Vaciar no es podar: sin el nodo intermedio no hay camino hasta la
        # tesela fina que cuelga de el.
        salida = modelos3d.sin_niveles_bastos(self.ARBOL, 20)
        self.assertEqual(len(salida["root"]["children"]), 2)
        self.assertEqual(len(salida["root"]["children"][0]["children"]), 2)

    def test_los_tilesets_hijos_no_se_tocan(self):
        # Un .json no es geometria: es la continuacion del arbol.
        salida = modelos3d.sin_niveles_bastos(self.ARBOL, 20)
        self.assertIn("BlockR_L20_160.json", self._uris(salida["root"]))

    def test_un_nombre_raro_se_deja_como_esta(self):
        # Mas vale que dibuje de mas a que desaparezca sin avisar.
        salida = modelos3d.sin_niveles_bastos(self.ARBOL, 20)
        self.assertIn("sin_nivel_en_el_nombre.b3dm", self._uris(salida["root"]))

    def test_con_cero_no_hace_nada(self):
        # Es lo normal: solo los recortes lo necesitan.
        self.assertIs(modelos3d.sin_niveles_bastos(self.ARBOL, 0), self.ARBOL)

    def test_no_se_toca_el_original(self):
        antes = json.dumps(self.ARBOL, sort_keys=True)
        modelos3d.sin_niveles_bastos(self.ARBOL, 20)
        self.assertEqual(json.dumps(self.ARBOL, sort_keys=True), antes)


class Catalogo(unittest.TestCase):
    def test_cada_modelo_del_catalogo_tiene_archivos_declarados(self):
        # Una fuente de tipo modelo3d sin entrada en MODELOS sale en el panel,
        # se puede encender y no dibuja nada.
        for fuente in fuentes.CATALOGO:
            if fuente.tipo == "modelo3d":
                self.assertIn(fuente.clave, modelos3d.POR_CLAVE, fuente.clave)

    def test_cada_modelo_esta_en_el_catalogo(self):
        # Y al reves: un modelo en disco que nadie puede encender es 628 MB
        # ocupados para nada.
        claves = {f.clave for f in fuentes.CATALOGO if f.tipo == "modelo3d"}
        for modelo in modelos3d.MODELOS:
            self.assertIn(modelo.clave, claves, modelo.clave)

    def test_las_claves_no_se_repiten(self):
        claves = [m.clave for m in modelos3d.MODELOS]
        self.assertEqual(len(claves), len(set(claves)))

    def test_la_carpeta_es_un_nombre_simple(self):
        # Se concatena con DIR_DATOS para armar una ruta. Un '..' aqui seria
        # una travesia de directorios servida por el propio catalogo.
        for modelo in modelos3d.MODELOS:
            self.assertNotIn("..", modelo.carpeta)
            self.assertNotIn("/", modelo.carpeta)
            self.assertNotIn("\\", modelo.carpeta)

    def test_el_centro_cae_dentro_de_la_caja(self):
        for modelo in modelos3d.MODELOS:
            oeste, sur, este, norte = modelo.caja
            self.assertLess(oeste, este, modelo.clave)
            self.assertLess(sur, norte, modelo.clave)
            self.assertTrue(oeste <= modelo.centro[0] <= este, modelo.clave)
            self.assertTrue(sur <= modelo.centro[1] <= norte, modelo.clave)

    def test_la_altura_base_es_plausible(self):
        # Cero significaria «sin calibrar», y el modelo quedaria a 1.400 m
        # sobre la camara. Un valor absurdo lo enterraria bajo el mapa.
        for modelo in modelos3d.MODELOS:
            self.assertTrue(0 < modelo.altura_base < 6000, modelo.clave)
