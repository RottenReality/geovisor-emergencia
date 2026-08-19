"""Un parche no puede leer un campo que su modelo no declara.

Quitar un campo del modelo y dejar el `parche.campo` en el SQL de abajo no
rompe nada al arrancar: revienta con AttributeError la primera vez que alguien
toca esa capa desde el panel. Paso justo eso al mover el orden a la tabla
`pila`. Esta prueba lee el arbol sintactico de los routers, sin importarlos ni
tocar la base, y se queja antes de desplegar.
"""
import ast
import os
import unittest

RAIZ = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "app", "routers")


def _campos_por_modelo(arbol):
    """{'CapaParche': {'nombre', 'color', ...}} para cada clase *Parche."""
    modelos = {}
    for nodo in ast.walk(arbol):
        if isinstance(nodo, ast.ClassDef) and nodo.name.endswith("Parche"):
            modelos[nodo.name] = {
                cuerpo.target.id for cuerpo in nodo.body
                if isinstance(cuerpo, ast.AnnAssign) and isinstance(cuerpo.target, ast.Name)
            }
    return modelos


def _accesos_indebidos(ruta):
    """Cada (funcion, parametro.campo) que el modelo del parametro no declara."""
    with open(ruta, encoding="utf-8") as archivo:
        arbol = ast.parse(archivo.read())
    modelos = _campos_por_modelo(arbol)
    fallos = []

    for funcion in ast.walk(arbol):
        if not isinstance(funcion, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        for argumento in funcion.args.args:
            anotacion = argumento.annotation
            if not isinstance(anotacion, ast.Name) or anotacion.id not in modelos:
                continue
            declarados = modelos[anotacion.id]
            for nodo in ast.walk(funcion):
                if (isinstance(nodo, ast.Attribute) and isinstance(nodo.value, ast.Name)
                        and nodo.value.id == argumento.arg and nodo.attr not in declarados):
                    fallos.append(f"{funcion.name}: {argumento.arg}.{nodo.attr} "
                                  f"no esta en {anotacion.id}")
    return fallos


class Parches(unittest.TestCase):
    def test_ningun_router_lee_un_campo_inexistente(self):
        fallos = []
        for archivo in sorted(os.listdir(RAIZ)):
            if archivo.endswith(".py"):
                fallos += _accesos_indebidos(os.path.join(RAIZ, archivo))
        self.assertEqual(fallos, [], "\n".join(fallos))


if __name__ == "__main__":
    unittest.main()
