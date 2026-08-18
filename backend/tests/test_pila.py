"""Pruebas de la logica de la pila. Sin base de datos: todo son funciones puras.

Se ejecutan con:  cd backend && python -m unittest discover -s tests -v
"""
import unittest

from app import pila


def e(clave, orden, grupo_id=None):
    return {"clave": clave, "grupo_id": grupo_id, "orden": orden}


class Arbol(unittest.TestCase):
    def test_nivel_superior_ordenado_de_abajo_arriba(self):
        entradas = [e("capa-2", 20), e("raster-1", 10), e("capa-3", 30)]
        self.assertEqual([n["clave"] for n in pila.arbol(entradas)],
                         ["raster-1", "capa-2", "capa-3"])

    def test_una_capa_suelta_no_tiene_hijos(self):
        self.assertIsNone(pila.arbol([e("capa-2", 10)])[0]["hijos"])

    def test_el_grupo_expande_sus_hijos_en_orden(self):
        entradas = [
            e("grupo-1", 20),
            e("capa-9", 20, grupo_id=1),
            e("capa-8", 10, grupo_id=1),
            e("capa-3", 10),
        ]
        nodos = pila.arbol(entradas)
        self.assertEqual([n["clave"] for n in nodos], ["capa-3", "grupo-1"])
        self.assertEqual([h["clave"] for h in nodos[1]["hijos"]], ["capa-8", "capa-9"])

    def test_un_grupo_vacio_sigue_apareciendo(self):
        nodos = pila.arbol([e("grupo-1", 10)])
        self.assertEqual(nodos[0]["hijos"], [])

    def test_hijo_huerfano_no_desaparece_del_arbol(self):
        # Su grupo ya no esta en la pila: debe salir al nivel superior en vez
        # de perderse, o la capa se volveria invisible sin explicacion.
        nodos = pila.arbol([e("capa-9", 10, grupo_id=99)])
        self.assertEqual([n["clave"] for n in nodos], ["capa-9"])


class Aplanar(unittest.TestCase):
    def test_devuelve_solo_capas_de_abajo_arriba(self):
        entradas = [
            e("grupo-1", 20),
            e("capa-9", 10, grupo_id=1),
            e("raster-3", 10),
        ]
        self.assertEqual(pila.aplanar(entradas), ["raster-3", "capa-9"])

    def test_el_grupo_no_aparece_como_capa(self):
        self.assertEqual(pila.aplanar([e("grupo-1", 10)]), [])


class Sembrar(unittest.TestCase):
    def test_los_rasters_quedan_debajo_de_las_capas(self):
        filas = pila.sembrar(["raster-1", "raster-2"], ["capa-5", "capa-6"])
        self.assertEqual([f["clave"] for f in filas],
                         ["raster-1", "raster-2", "capa-5", "capa-6"])

    def test_el_orden_es_creciente_y_espaciado(self):
        filas = pila.sembrar(["raster-1"], ["capa-5"])
        self.assertEqual([f["orden"] for f in filas], [pila.PASO, pila.PASO * 2])

    def test_todo_nace_suelto(self):
        filas = pila.sembrar(["raster-1"], ["capa-5"])
        self.assertTrue(all(f["grupo_id"] is None for f in filas))


class Vecino(unittest.TestCase):
    def test_intercambia_con_el_hermano_de_arriba(self):
        entradas = [e("capa-1", 10), e("capa-2", 20), e("capa-3", 30)]
        self.assertEqual(pila.vecino(entradas, "capa-2", "subir"), "capa-3")

    def test_intercambia_con_el_hermano_de_abajo(self):
        entradas = [e("capa-1", 10), e("capa-2", 20)]
        self.assertEqual(pila.vecino(entradas, "capa-2", "bajar"), "capa-1")

    def test_en_el_borde_no_hay_vecino(self):
        entradas = [e("capa-1", 10), e("capa-2", 20)]
        self.assertIsNone(pila.vecino(entradas, "capa-2", "subir"))
        self.assertIsNone(pila.vecino(entradas, "capa-1", "bajar"))

    def test_solo_se_mueve_entre_hermanos_del_mismo_grupo(self):
        # capa-9 esta dentro del grupo 1 y capa-3 esta suelta: no son
        # hermanas y moverse nunca debe sacarla del grupo.
        entradas = [e("grupo-1", 20), e("capa-9", 10, grupo_id=1), e("capa-3", 10)]
        self.assertIsNone(pila.vecino(entradas, "capa-9", "subir"))
        self.assertIsNone(pila.vecino(entradas, "capa-9", "bajar"))

    def test_un_grupo_se_mueve_entre_los_del_nivel_superior(self):
        entradas = [e("grupo-1", 10), e("capa-3", 20)]
        self.assertEqual(pila.vecino(entradas, "grupo-1", "subir"), "capa-3")

    def test_una_clave_que_no_esta_no_tiene_vecino(self):
        self.assertIsNone(pila.vecino([e("capa-1", 10)], "capa-77", "subir"))
