# Grupos de capas y orden compartido — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que cualquier capa —dibujo, imagen o fuente externa— se pueda ordenar libremente y agrupar con las demás, en una única escala compartida por todo el equipo.

**Architecture:** Una tabla `pila` pasa a ser dueña del orden; un grupo es también una fila de esa tabla. La lógica delicada (aplanado, siembra, vecino con quien intercambiar) se aísla en un módulo puro sin base de datos para poder probarla. El apilado del mapa no se toca: `sincronizarCapas` ya ordena recorriendo el arreglo de items.

**Tech Stack:** FastAPI + asyncpg + PostGIS; JavaScript ES modules sin build step; MapLibre GL.

**Spec:** `docs/superpowers/specs/2026-08-18-grupos-de-capas-design.md`

## Global Constraints

- **Idioma del código:** comentarios y nombres en castellano **sin tildes ni eñes** (`danos`, `numeracion`), como todo el repo. Los textos de interfaz sí llevan tildes.
- **Mensajes de commit:** castellano, imperativo, sin tildes. Terminar con `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- **Finales de línea:** LF. Escribir siempre con `newline='\n'`.
- **`db/init.sql` es idempotente** y se aplica en cada despliegue: solo `CREATE TABLE IF NOT EXISTS` y `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`. Nunca `DROP` ni `ALTER COLUMN`.
- **El navegador nunca pasa una URL al servidor.** Pasa una clave del catálogo. Regla vigente de `fuentes.py`.
- **No desplegar hasta la Tarea 9.** Las tareas 1-8 se acumulan en la rama `grupos-de-capas`.
- **Prohibido `docker stop`/`prune` globales en la VPS:** conviven los contenedores ajenos `oar_*`.
- **Claves de la pila:** `capa-{id}`, `raster-{id}`, `ext-{clave_catalogo}`, `grupo-{id}`. Exactamente esos prefijos.
- **`direccion`** toma los valores `subir` y `bajar`. Subir es acercarse al frente del mapa.

---

## Estructura de archivos

| Archivo | Responsabilidad |
|---|---|
| `backend/app/pila.py` *(nuevo)* | Lógica pura: árbol, aplanado, siembra, vecino. Sin DB, sin FastAPI |
| `backend/tests/test_pila.py` *(nuevo)* | Pruebas de lo anterior, con `unittest` de la stdlib |
| `backend/app/routers/pila.py` *(nuevo)* | Endpoints de pila y grupos |
| `db/init.sql` | Tablas `grupos`, `externas`, `pila` |
| `backend/app/routers/externas.py` | Estado de una externa en el servidor; cabecera del módulo reescrita |
| `backend/app/main.py` | Registrar el router nuevo |
| `backend/app/routers/capas.py`, `rasters.py` | Retirar `orden` del PATCH |
| `web/js/pila.js` *(nuevo)* | Cliente del API de pila y construcción del árbol |
| `web/js/capas.js` | Ensamblado de items y pintado con grupos |
| `web/js/externas.js` | Estado contra el servidor en vez de `localStorage` |
| `web/estilos.css` | Cabecera de grupo, sangría, chips `ext` e `img` |

### Nota sobre las pruebas

El repo no tiene pruebas. Este plan añade **un** archivo de pruebas, solo para
`pila.py`, con `unittest` de la biblioteca estándar: sin dependencia nueva, sin
base de datos y sin Docker. Se justifica porque el aplanado, la siembra y el
intercambio entre hermanos son la única parte del trabajo donde un error es
silencioso —el mapa queda mal apilado y nadie sabe por qué— y son funciones
puras, que es justo lo barato de probar. El resto se verifica contra el
despliegue, como el trabajo anterior.

Se ejecutan así, sin levantar nada:

```bash
cd backend && python -m unittest discover -s tests -v
```

---

### Task 1: Lógica pura de la pila, con pruebas

**Files:**
- Create: `backend/app/pila.py`
- Create: `backend/tests/test_pila.py`

**Interfaces:**
- Consumes: nada.
- Produces:
  - `arbol(entradas: list[dict]) -> list[dict]`
  - `aplanar(entradas: list[dict]) -> list[str]`
  - `sembrar(claves_rasters: list[str], claves_capas: list[str]) -> list[dict]`
  - `vecino(entradas: list[dict], clave: str, direccion: str) -> str | None`
  - Constante `PASO = 10`

  Una *entrada* es `{"clave": str, "grupo_id": int | None, "orden": int}`.
  Un nodo de `arbol` es `{"clave": str, "grupo_id": None, "orden": int, "hijos": list[dict] | None}`; `hijos` es `None` para una capa suelta y una lista para un grupo.

- [ ] **Step 1: Escribir las pruebas que fallan**

Crear `backend/tests/test_pila.py`:

```python
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
```

- [ ] **Step 2: Ejecutar y comprobar que fallan**

```bash
cd backend && python -m unittest discover -s tests -v
```

Esperado: error de importación, `ModuleNotFoundError: No module named 'app.pila'`.

- [ ] **Step 3: Escribir el módulo**

Crear `backend/app/pila.py`:

```python
"""Logica de la pila de capas. Sin base de datos a proposito.

Aqui vive lo unico de este subsistema donde un error es silencioso: si el
aplanado se equivoca, el mapa queda mal apilado y no hay mensaje de error que
lo delate. Al no tocar Postgres se puede probar entero en un segundo.

Vocabulario:

  entrada   {clave, grupo_id, orden}. Una fila de la tabla `pila`.
  clave     'capa-13' | 'raster-6' | 'ext-ungrd-ede' | 'grupo-2'
  arbol     nivel superior en orden, con cada grupo expandido en su sitio
  aplanar   el arbol reducido a la lista de capas, de abajo arriba

Todo va SIEMPRE de abajo arriba: el ultimo elemento es el que se dibuja
encima. El panel lo pinta al reves, que es la convencion de QGIS.
"""

# Separacion entre dos posiciones consecutivas al sembrar. Deja hueco para
# intercalar sin renumerar, aunque hoy mover solo intercambia dos valores.
PASO = 10

PREFIJO_GRUPO = "grupo-"


def es_grupo(clave: str) -> bool:
    return clave.startswith(PREFIJO_GRUPO)


def id_de_grupo(clave: str) -> int:
    return int(clave[len(PREFIJO_GRUPO):])


def _ordenadas(entradas: list[dict]) -> list[dict]:
    # Desempate por clave: dos filas con el mismo orden deben salir siempre
    # igual, o la lista bailaria entre recargas sin que nadie toque nada.
    return sorted(entradas, key=lambda f: (f["orden"], f["clave"]))


def arbol(entradas: list[dict]) -> list[dict]:
    """Nivel superior en orden, con los grupos expandidos."""
    grupos_presentes = {id_de_grupo(f["clave"]) for f in entradas if es_grupo(f["clave"])}

    hijos: dict[int, list[dict]] = {}
    superiores: list[dict] = []
    for fila in entradas:
        grupo = fila["grupo_id"]
        # Un hijo cuyo grupo ya no existe sale al nivel superior. Dejarlo
        # colgando lo haria desaparecer del panel y del mapa sin aviso.
        if grupo is None or grupo not in grupos_presentes:
            superiores.append(fila)
        else:
            hijos.setdefault(grupo, []).append(fila)

    nodos = []
    for fila in _ordenadas(superiores):
        nodo = dict(fila)
        nodo["grupo_id"] = None
        nodo["hijos"] = (_ordenadas(hijos.get(id_de_grupo(fila["clave"]), []))
                         if es_grupo(fila["clave"]) else None)
        nodos.append(nodo)
    return nodos


def aplanar(entradas: list[dict]) -> list[str]:
    """Solo las capas, de abajo arriba. Los grupos no se dibujan."""
    salida: list[str] = []
    for nodo in arbol(entradas):
        if nodo["hijos"] is None:
            salida.append(nodo["clave"])
        else:
            salida.extend(h["clave"] for h in nodo["hijos"])
    return salida


def sembrar(claves_rasters: list[str], claves_capas: list[str]) -> list[dict]:
    """Orden inicial que reproduce lo que el equipo ve hoy.

    Las imagenes debajo y el dibujo encima, que es la disposicion fija que
    tenia el visor antes de que existiera la pila. Nadie debe encontrarse el
    mapa cambiado el dia del despliegue.
    """
    return [{"clave": clave, "grupo_id": None, "orden": (i + 1) * PASO}
            for i, clave in enumerate([*claves_rasters, *claves_capas])]


def vecino(entradas: list[dict], clave: str, direccion: str) -> str | None:
    """Con quien intercambia `clave` al moverse. None si esta en el borde.

    Solo entre hermanos: dentro del grupo si esta en uno, en el nivel superior
    si esta suelta. Mover NUNCA saca una capa de su grupo ni la mete en otro;
    para eso esta `agrupar`.
    """
    fila = next((f for f in entradas if f["clave"] == clave), None)
    if fila is None:
        return None

    grupos_presentes = {id_de_grupo(f["clave"]) for f in entradas if es_grupo(f["clave"])}
    suyo = fila["grupo_id"] if fila["grupo_id"] in grupos_presentes else None

    hermanos = _ordenadas([
        f for f in entradas
        if (f["grupo_id"] if f["grupo_id"] in grupos_presentes else None) == suyo
    ])
    posicion = next(i for i, f in enumerate(hermanos) if f["clave"] == clave)
    destino = posicion + (1 if direccion == "subir" else -1)
    if destino < 0 or destino >= len(hermanos):
        return None
    return hermanos[destino]["clave"]
```

- [ ] **Step 4: Ejecutar y comprobar que pasan**

```bash
cd backend && python -m unittest discover -s tests -v
```

Esperado: `OK`, 16 pruebas.

- [ ] **Step 5: Commit**

```bash
git add backend/app/pila.py backend/tests/test_pila.py
git commit -m "Aislar la logica de la pila de capas, con pruebas

El aplanado, la siembra y el intercambio entre hermanos son la unica
parte de este trabajo donde un error no da la cara: el mapa queda mal
apilado y no hay mensaje que lo delate. Se separan de la base de datos
para poder probarlos sin levantar nada.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Esquema de la base

**Files:**
- Modify: `db/init.sql` (al final, antes del bloque de capas iniciales)

**Interfaces:**
- Consumes: nada.
- Produces: tablas `grupos`, `externas`, `pila`.

- [ ] **Step 1: Añadir las tablas**

Insertar en `db/init.sql`, justo **antes** del comentario `-- Capas iniciales para respuesta sismica`:

```sql
-- ---------------------------------------------------------------------------
-- Pila de capas: quien va encima de quien, y que hay dentro de que grupo.
--
-- Antes el orden vivia en capas.orden, rasters.orden y el localStorage de cada
-- navegador, con escalas independientes. Eso hacia imposible intercalar una
-- fuente externa entre dos capas propias, y hacia que dos navegadores con
-- distinto juego de externas se pisaran la numeracion en cada recarga.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS grupos (
  id     SERIAL PRIMARY KEY,
  nombre TEXT NOT NULL,
  color  TEXT NOT NULL DEFAULT '#8d99ae'
);

-- Estado de una fuente externa publicada en el mapa del equipo. Es el
-- equivalente de lo que capas y rasters ya guardan en su propia tabla; el
-- nombre, el color y la URL los pone el catalogo de fuentes.py, no la base.
CREATE TABLE IF NOT EXISTS externas (
  clave    TEXT PRIMARY KEY,
  visible  BOOLEAN NOT NULL DEFAULT true,
  opacidad REAL    NOT NULL DEFAULT 1
);

-- Una fila por cosa que ocupa sitio en el panel, grupos incluidos:
--   capa-13  raster-6  ext-ungrd-ede  grupo-2
-- Estar aqui es lo que significa estar en el mapa.
CREATE TABLE IF NOT EXISTS pila (
  clave    TEXT PRIMARY KEY,
  grupo_id INTEGER REFERENCES grupos(id) ON DELETE SET NULL,
  orden    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pila_grupo ON pila (grupo_id, orden);
```

- [ ] **Step 2: Comprobar que el SQL es válido y idempotente**

```bash
docker run --rm --name geo_sql_check -e POSTGRES_PASSWORD=x -d postgis/postgis:16-3.4
sleep 12
docker exec -i geo_sql_check psql -U postgres -v ON_ERROR_STOP=1 -q < db/init.sql
docker exec -i geo_sql_check psql -U postgres -v ON_ERROR_STOP=1 -q < db/init.sql
docker exec geo_sql_check psql -U postgres -c "\d pila"
docker rm -f geo_sql_check
```

Esperado: las dos pasadas sin error (idempotencia) y la tabla `pila` con sus tres columnas. **Es un contenedor propio y desechable: no toca `geo_db` ni los `oar_*`.**

- [ ] **Step 3: Commit**

```bash
git add db/init.sql
git commit -m "Anadir las tablas de la pila de capas y los grupos

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Lectura de la pila, con materialización

**Files:**
- Create: `backend/app/routers/pila.py`
- Modify: `backend/app/main.py`

**Interfaces:**
- Consumes: `app.pila.sembrar`, `app.pila.arbol`, `app.pila.PASO`.
- Produces: `GET /api/pila` → `{"grupos": [{"id","nombre","color"}], "entradas": [{"clave","grupo_id","orden"}]}`; y la corrutina `async def materializar() -> list[dict]` que reutilizan las tareas siguientes.

- [ ] **Step 1: Escribir el router**

Crear `backend/app/routers/pila.py`:

```python
"""Pila de capas: orden compartido y grupos.

La pila es la unica fuente de verdad de que va encima de que. capas.orden y
rasters.orden quedan solo como semilla del primer arranque.

Se autorrepara en cada lectura en vez de exigir un script de migracion: toda
capa o raster sin sitio recibe uno, y toda fila que apunte a algo que ya no
existe se va. Asi el despliegue no tiene un paso manual que se pueda olvidar.
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from .. import db, fuentes, pila
from ..auth import requiere_sesion

router = APIRouter(prefix="/api/pila", dependencies=[Depends(requiere_sesion)])


class Movimiento(BaseModel):
    clave: str
    direccion: str


class Agrupacion(BaseModel):
    clave: str
    grupo_id: int | None = None


async def _filas(conexion) -> list[dict]:
    return [dict(f) for f in await conexion.fetch(
        "SELECT clave, grupo_id, orden FROM pila")]


async def materializar() -> list[dict]:
    """Deja la pila coherente con lo que existe y la devuelve.

    Idempotente: si no falta ni sobra nada, no escribe.
    """
    async with db.pool().acquire() as conexion:
        async with conexion.transaction():
            existentes = {f["clave"] for f in await _filas(conexion)}

            claves_capas = [f"capa-{f['id']}" for f in await conexion.fetch(
                "SELECT id FROM capas ORDER BY orden NULLS LAST, id")]
            claves_rasters = [f"raster-{f['id']}" for f in await conexion.fetch(
                "SELECT id FROM rasters ORDER BY orden NULLS LAST, id")]
            vivas = set(claves_capas) | set(claves_rasters)

            # Sobrantes: capas y rasters borrados, y fuentes externas que el
            # catalogo ya no ofrece.
            sobran = [c for c in existentes
                      if not c.startswith(("grupo-",))
                      and (c[4:] not in fuentes.POR_CLAVE if c.startswith("ext-")
                           else c not in vivas)]
            if sobran:
                await conexion.execute(
                    "DELETE FROM pila WHERE clave = ANY($1::text[])", sobran)
                existentes -= set(sobran)

            faltan_rasters = [c for c in claves_rasters if c not in existentes]
            faltan_capas = [c for c in claves_capas if c not in existentes]

            if faltan_rasters or faltan_capas:
                if existentes:
                    # Ya hay pila: lo nuevo se coloca sin tocar lo demas. La
                    # imagen entra por abajo -es fondo- y el dibujo por arriba,
                    # que es donde se acaba de crear para dibujar en el.
                    limites = await conexion.fetchrow(
                        "SELECT MIN(orden) AS suelo, MAX(orden) AS techo "
                        "FROM pila WHERE grupo_id IS NULL")
                    suelo = limites["suelo"] or 0
                    techo = limites["techo"] or 0
                    nuevas = [
                        *({"clave": c, "grupo_id": None,
                           "orden": suelo - (i + 1) * pila.PASO}
                          for i, c in enumerate(faltan_rasters)),
                        *({"clave": c, "grupo_id": None,
                           "orden": techo + (i + 1) * pila.PASO}
                          for i, c in enumerate(faltan_capas)),
                    ]
                else:
                    # Primer arranque: se siembra reproduciendo la disposicion
                    # fija que tenia el visor, imagenes debajo del dibujo.
                    nuevas = pila.sembrar(faltan_rasters, faltan_capas)

                await conexion.executemany(
                    "INSERT INTO pila (clave, grupo_id, orden) VALUES ($1, $2, $3) "
                    "ON CONFLICT (clave) DO NOTHING",
                    [(f["clave"], f["grupo_id"], f["orden"]) for f in nuevas])

            return await _filas(conexion)


@router.get("")
async def leer():
    entradas = await materializar()
    grupos = await db.pool().fetch("SELECT id, nombre, color FROM grupos ORDER BY id")
    return {"grupos": [dict(g) for g in grupos], "entradas": entradas}
```

- [ ] **Step 2: Registrar el router**

En `backend/app/main.py`, cambiar la línea de importación:

```python
from .routers import capas, export, externas, features, pila, rasters, subidas, uploads
```

y añadir junto al resto de `include_router`:

```python
app.include_router(pila.router)
```

- [ ] **Step 3: Comprobar que la aplicación importa y la ruta existe**

```bash
docker compose build api
docker run --rm --network none -e DATABASE_URL=postgresql://x/x -e CLAVE_ACCESO=x -e SECRET_KEY=x \
  geovisor-api python -c "
from app.main import app
print([r.path for r in app.routes if 'pila' in r.path])"
```

Esperado: `['/api/pila']`.

- [ ] **Step 4: Commit**

```bash
git add backend/app/routers/pila.py backend/app/main.py
git commit -m "Leer la pila de capas, materializandola al vuelo

Se autorrepara en cada lectura en vez de pedir un script de migracion:
lo que falta recibe sitio y lo que apunta a algo borrado se va. El primer
arranque siembra la disposicion que el visor ya tenia, para que nadie se
encuentre el mapa cambiado.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Mover y agrupar

**Files:**
- Modify: `backend/app/routers/pila.py`

**Interfaces:**
- Consumes: `materializar()`, `app.pila.vecino`, `app.pila.PASO`.
- Produces: `POST /api/pila/mover`, `POST /api/pila/agrupar`. Ambos devuelven `{"ok": True}`.

- [ ] **Step 1: Añadir los dos endpoints**

Añadir al final de `backend/app/routers/pila.py`:

```python
@router.post("/mover")
async def mover(datos: Movimiento):
    """Intercambia el sitio con el hermano vecino.

    Solo entre hermanos: mover nunca saca una capa de su grupo. En el borde
    de su contenedor no hace nada y el panel ya deshabilita el boton.
    """
    if datos.direccion not in ("subir", "bajar"):
        raise HTTPException(status_code=400, detail="direccion debe ser subir o bajar")

    entradas = await materializar()
    otra = pila.vecino(entradas, datos.clave, datos.direccion)
    if otra is None:
        return {"ok": True, "movido": False}

    por_clave = {f["clave"]: f for f in entradas}
    async with db.pool().acquire() as conexion:
        async with conexion.transaction():
            await conexion.execute("UPDATE pila SET orden=$2 WHERE clave=$1",
                                   datos.clave, por_clave[otra]["orden"])
            await conexion.execute("UPDATE pila SET orden=$2 WHERE clave=$1",
                                   otra, por_clave[datos.clave]["orden"])
    return {"ok": True, "movido": True}


@router.post("/agrupar")
async def agrupar(datos: Agrupacion):
    """Mete una capa en un grupo, o la saca si grupo_id es null.

    Entra al frente de su nuevo contenedor: se acaba de mover ahi a proposito
    y esconderla al fondo obligaria a buscarla.
    """
    if pila.es_grupo(datos.clave):
        raise HTTPException(status_code=400, detail="Un grupo no puede entrar en otro")

    entradas = await materializar()
    if not any(f["clave"] == datos.clave for f in entradas):
        raise HTTPException(status_code=404, detail="Esa capa no esta en la pila")

    if datos.grupo_id is not None:
        existe = await db.pool().fetchval(
            "SELECT 1 FROM grupos WHERE id=$1", datos.grupo_id)
        if not existe:
            raise HTTPException(status_code=404, detail="No existe ese grupo")

    hermanos = [f["orden"] for f in entradas
                if f["grupo_id"] == datos.grupo_id and f["clave"] != datos.clave]
    await db.pool().execute(
        "UPDATE pila SET grupo_id=$2, orden=$3 WHERE clave=$1",
        datos.clave, datos.grupo_id, (max(hermanos) if hermanos else 0) + pila.PASO)
    return {"ok": True}
```

- [ ] **Step 2: Comprobar que importa**

```bash
docker compose build api
docker run --rm --network none -e DATABASE_URL=postgresql://x/x -e CLAVE_ACCESO=x -e SECRET_KEY=x \
  geovisor-api python -c "
from app.main import app
print(sorted(r.path for r in app.routes if '/api/pila' in r.path))"
```

Esperado: `['/api/pila', '/api/pila/agrupar', '/api/pila/mover']`.

- [ ] **Step 3: Commit**

```bash
git add backend/app/routers/pila.py
git commit -m "Mover capas entre hermanas y meterlas o sacarlas de un grupo

Dos operaciones explicitas y no un PUT de la pila entera: con varias
personas trabajando a la vez, enviar el monton completo haria que el
ultimo en guardar pisara el reordenamiento del otro.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Grupos (crear, renombrar, disolver)

**Files:**
- Modify: `backend/app/routers/pila.py`

**Interfaces:**
- Consumes: `materializar()`, `app.pila.PASO`.
- Produces: `POST /api/grupos` → `{"id","nombre","color"}`; `PATCH /api/grupos/{id}`; `DELETE /api/grupos/{id}`.

- [ ] **Step 1: Añadir el router de grupos**

Añadir al final de `backend/app/routers/pila.py`:

```python
# ---------------------------------------------------------------------------
# Grupos
# ---------------------------------------------------------------------------
# Router aparte por el prefijo, pero vive en este archivo: un grupo no es nada
# sin la pila -es una entrada mas de ella- y separarlos obligaria a leer dos
# archivos para entender uno.
grupos_router = APIRouter(prefix="/api/grupos", dependencies=[Depends(requiere_sesion)])


class GrupoEntrada(BaseModel):
    nombre: str
    color: str = "#8d99ae"


class GrupoParche(BaseModel):
    nombre: str | None = None
    color: str | None = None


@grupos_router.post("", status_code=201)
async def crear_grupo(datos: GrupoEntrada):
    """El grupo nuevo entra al frente del nivel superior, para verlo sin buscarlo."""
    entradas = await materializar()
    techo = max([f["orden"] for f in entradas if f["grupo_id"] is None], default=0)

    async with db.pool().acquire() as conexion:
        async with conexion.transaction():
            fila = await conexion.fetchrow(
                "INSERT INTO grupos (nombre, color) VALUES ($1, $2) "
                "RETURNING id, nombre, color",
                datos.nombre.strip() or "Grupo sin nombre", datos.color)
            await conexion.execute(
                "INSERT INTO pila (clave, grupo_id, orden) VALUES ($1, NULL, $2)",
                f"grupo-{fila['id']}", techo + pila.PASO)
    return dict(fila)


@grupos_router.patch("/{id_grupo}")
async def editar_grupo(id_grupo: int, parche: GrupoParche):
    fila = await db.pool().fetchrow(
        "UPDATE grupos SET nombre=COALESCE($2, nombre), color=COALESCE($3, color) "
        "WHERE id=$1 RETURNING id, nombre, color",
        id_grupo, parche.nombre.strip() if parche.nombre else None, parche.color)
    if fila is None:
        raise HTTPException(status_code=404, detail="No existe ese grupo")
    return dict(fila)


@grupos_router.delete("/{id_grupo}")
async def disolver_grupo(id_grupo: int):
    """Disuelve el grupo. Sus capas NO se borran.

    Quedan sueltas en el sitio donde estaba el grupo y conservando su orden
    relativo: quien disuelve espera recuperar sus capas donde estaban, no
    repartidas por todo el monton.
    """
    clave_grupo = f"grupo-{id_grupo}"
    async with db.pool().acquire() as conexion:
        async with conexion.transaction():
            sitio = await conexion.fetchval(
                "SELECT orden FROM pila WHERE clave=$1", clave_grupo)
            if sitio is None:
                raise HTTPException(status_code=404, detail="No existe ese grupo")

            hijos = await conexion.fetch(
                "SELECT clave FROM pila WHERE grupo_id=$1 ORDER BY orden, clave",
                id_grupo)
            # Se reparten en el hueco que deja el grupo, por debajo del
            # siguiente vecino, para no alterar el orden de lo que hay alrededor.
            siguiente = await conexion.fetchval(
                "SELECT MIN(orden) FROM pila WHERE grupo_id IS NULL AND orden > $1",
                sitio)
            techo = siguiente if siguiente is not None else sitio + pila.PASO * (len(hijos) + 1)
            hueco = (techo - sitio) / (len(hijos) + 1) if hijos else 0

            for i, hijo in enumerate(hijos):
                await conexion.execute(
                    "UPDATE pila SET grupo_id=NULL, orden=$2 WHERE clave=$1",
                    hijo["clave"], int(sitio + hueco * (i + 1)))

            await conexion.execute("DELETE FROM pila WHERE clave=$1", clave_grupo)
            await conexion.execute("DELETE FROM grupos WHERE id=$1", id_grupo)
    return {"ok": True, "sueltas": len(hijos)}
```

- [ ] **Step 2: Registrar el router de grupos**

En `backend/app/main.py`, junto al `include_router` de la pila:

```python
app.include_router(pila.grupos_router)
```

- [ ] **Step 3: Comprobar las rutas**

```bash
docker compose build api
docker run --rm --network none -e DATABASE_URL=postgresql://x/x -e CLAVE_ACCESO=x -e SECRET_KEY=x \
  geovisor-api python -c "
from app.main import app
print(sorted(r.path for r in app.routes if 'grupos' in r.path))"
```

Esperado: `['/api/grupos', '/api/grupos/{id_grupo}']`.

- [ ] **Step 4: Commit**

```bash
git add backend/app/routers/pila.py backend/app/main.py
git commit -m "Crear, renombrar y disolver grupos de capas

Disolver no borra nada: las capas quedan sueltas en el sitio donde estaba
el grupo y conservando su orden relativo, que es lo que espera quien
disuelve.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Estado de las fuentes externas en el servidor

**Files:**
- Modify: `backend/app/routers/externas.py`
- Modify: `backend/app/fuentes.py` (solo la cabecera del módulo)

**Interfaces:**
- Consumes: `app.routers.pila.materializar`, `app.pila.PASO`.
- Produces: `POST /api/externas/{clave}/encender`, `DELETE /api/externas/{clave}`, `PATCH /api/externas/{clave}` con `{visible?, opacidad?}`. `GET /api/externas` gana la clave `publicadas`: `[{"clave","visible","opacidad"}]`.

- [ ] **Step 1: Añadir los endpoints de estado**

En `backend/app/routers/externas.py`, añadir cerca del final de las rutas (después de `datos`, la que sirve el GeoJSON):

```python
class ExternaParche(BaseModel):
    visible: bool | None = None
    opacidad: float | None = Field(default=None, ge=0, le=1)


@router.post("/{clave}/encender", status_code=201)
async def encender(clave: str):
    """Publica la fuente en el mapa del EQUIPO, no solo para quien pulsa.

    Entra al frente del nivel superior: se acaba de anadir y esconderla al
    fondo obligaria a buscarla.
    """
    _buscar(clave)   # 404 si no esta en el catalogo
    entradas = await materializar()
    techo = max([f["orden"] for f in entradas if f["grupo_id"] is None], default=0)

    async with db.pool().acquire() as conexion:
        async with conexion.transaction():
            await conexion.execute(
                "INSERT INTO externas (clave) VALUES ($1) ON CONFLICT DO NOTHING", clave)
            await conexion.execute(
                "INSERT INTO pila (clave, grupo_id, orden) VALUES ($1, NULL, $2) "
                "ON CONFLICT (clave) DO NOTHING",
                f"ext-{clave}", techo + pila_logica.PASO)
    return {"ok": True}


@router.delete("/{clave}")
async def apagar(clave: str):
    """La quita del mapa del equipo. Sin confirmacion: el panel es de todos."""
    async with db.pool().acquire() as conexion:
        async with conexion.transaction():
            await conexion.execute("DELETE FROM pila WHERE clave=$1", f"ext-{clave}")
            await conexion.execute("DELETE FROM externas WHERE clave=$1", clave)
    return {"ok": True}


@router.patch("/{clave}")
async def editar(clave: str, parche: ExternaParche):
    fila = await db.pool().fetchrow(
        "UPDATE externas SET visible=COALESCE($2, visible), "
        "opacidad=COALESCE($3, opacidad) WHERE clave=$1 "
        "RETURNING clave, visible, opacidad",
        clave, parche.visible, parche.opacidad)
    if fila is None:
        raise HTTPException(status_code=404, detail="Esa fuente no esta publicada")
    return dict(fila)
```

Ajustar las importaciones del archivo. La línea 29 ya existe y solo gana `Field`;
las otras dos son nuevas y van junto al bloque de las líneas 31-34:

```python
from pydantic import BaseModel, Field          # línea 29: añadir Field

from .. import config, db, fuentes
from .. import pila as pila_logica             # nueva: la lógica pura
from ..auth import requiere_sesion
from .pila import materializar                 # nueva: el router de la pila
```

El alias `pila_logica` es obligatorio: sin él, `pila` sería ambiguo entre el
módulo puro `app.pila` y el router `app.routers.pila`, y ambos se usan aquí.
No hay ciclo de importación: `routers/pila.py` no importa `externas`.

- [ ] **Step 2: Exponer las publicadas en el catálogo**

En `backend/app/routers/externas.py`, dentro de `async def catalogo()`, cambiar el `return` para añadir la clave `publicadas`:

```python
    publicadas = await db.pool().fetch(
        "SELECT clave, visible, opacidad FROM externas")

    return {
        "temas": [{"clave": c, "titulo": t, "descripcion": d} for c, t, d in fuentes.TEMAS],
        "fuentes": fichas,
        "publicadas": [dict(p) for p in publicadas],
        "productos": [{
            "clave": p.clave, "nombre": p.nombre, "organizacion": p.organizacion,
            "tipo": p.tipo, "mb": p.mb, "nota": p.nota, "motivo": p.motivo, "url": p.url,
        } for p in fuentes.PRODUCTOS],
    }
```

- [ ] **Step 3: Corregir la cabecera de `fuentes.py`, que ahora miente**

En `backend/app/fuentes.py`, localizar en la cabecera del módulo el bloque
`Que es esto` y sustituirlo. **No tocar** los otros tres bloques de esa
cabecera —`Por que un modulo de codigo y no una tabla`, `El navegador NUNCA
pasa una URL` y `Datos personales`—, que siguen siendo ciertos.

Sustituir esto:

```
Que es esto
-----------
Una lista fija de servicios publicos (IGAC, Esri Colombia, Copernicus, GDACS,
HDX y otros) que el visor consulta EN VIVO. No se copian a la base: se piden al
momento, se recortan y se cachean unos minutos. Asi lo que ve el equipo es lo
que hay ahora mismo en la fuente, sin un trabajo de sincronizacion que
mantener durante una emergencia.
```

por:

```
Que es esto
-----------
Una lista fija de servicios publicos (IGAC, Esri Colombia, Copernicus, GDACS,
HDX y otros) que el visor consulta EN VIVO. No se copian a la base: se piden al
momento, se recortan y se cachean unos minutos. Asi lo que ve el equipo es lo
que hay ahora mismo en la fuente, sin un trabajo de sincronizacion que
mantener durante una emergencia.

De la base si sale QUE fuentes estan publicadas y en que orden: encenderlas es
una decision del equipo, no de cada navegador. El catalogo dice lo que se puede
mirar; la tabla `externas` y la pila dicen lo que el equipo decidio mirar.
```

- [ ] **Step 4: Comprobar las rutas**

```bash
docker compose build api
docker run --rm --network none -e DATABASE_URL=postgresql://x/x -e CLAVE_ACCESO=x -e SECRET_KEY=x \
  geovisor-api python -c "
from app.main import app
print(sorted((r.path, sorted(r.methods)) for r in app.routes if 'externas' in r.path))"
```

Esperado: entre otras, `/api/externas/{clave}` con `DELETE` y `PATCH`, y `/api/externas/{clave}/encender` con `POST`.

- [ ] **Step 5: Commit**

```bash
git add backend/app/routers/externas.py backend/app/fuentes.py
git commit -m "Publicar las fuentes externas en el servidor, no en cada navegador

Encender una fuente pasa a ser una decision del equipo: entra en la pila
como cualquier otra capa y se ordena con ellas. Quitarla se la quita a
todos, sin confirmacion, porque el panel es de todos.

La cabecera de fuentes.py decia que esto se guardaba en cada navegador.
Se corrige en el mismo cambio para que el archivo no mienta.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: Frontend — la lista sale de la pila

**Files:**
- Create: `web/js/pila.js`
- Modify: `web/js/capas.js:51-77` (`cargar`), y la constante `GRUPOS`
- Modify: `web/js/externas.js` (estado contra el servidor; cabecera del módulo)

**Interfaces:**
- Consumes: `GET /api/pila`, `GET /api/externas`, endpoints de la Tarea 6.
- Produces:
  - `pila.js`: `cargar() -> Promise<void>`, `arbol() -> nodo[]`, `aplanar() -> string[]`, `grupos() -> {id,nombre,color}[]`, `mover(clave, direccion) -> Promise`, `agrupar(clave, grupoId) -> Promise`, `crearGrupo(nombre, color)`, `editarGrupo(id, cambios)`, `disolverGrupo(id)`.
  - Un *nodo* es `{clave, orden, hijos: string[] | null}`.

- [ ] **Step 1: Escribir el cliente de la pila**

Crear `web/js/pila.js`:

```javascript
/* Pila de capas: quien va encima de quien, y que hay dentro de que grupo.
 *
 * El orden es del EQUIPO y vive en el servidor. Este modulo solo lo pide, lo
 * cachea entre repintados y ofrece las operaciones; no decide nada.
 *
 * Todo va de abajo arriba, igual que en el backend: el ultimo es el que se
 * dibuja encima. El panel lo pinta al reves.
 */

import { api } from './util.js';

let entradas = [];
let losGrupos = [];

export async function cargar() {
  const datos = await api('/api/pila');
  entradas = datos.entradas;
  losGrupos = datos.grupos;
}

export const grupos = () => losGrupos;

const esGrupo = (clave) => clave.startsWith('grupo-');
const idDeGrupo = (clave) => Number(clave.slice('grupo-'.length));
const porOrden = (a, b) => (a.orden - b.orden) || a.clave.localeCompare(b.clave);

/** Nivel superior en orden, con cada grupo expandido en su sitio. */
export function arbol() {
  const presentes = new Set(entradas.filter((f) => esGrupo(f.clave)).map((f) => idDeGrupo(f.clave)));
  const hijos = new Map();
  const superiores = [];

  for (const fila of entradas) {
    // Un hijo cuyo grupo ya no existe sale al nivel superior: dejarlo
    // colgando lo haria desaparecer del panel sin ningun aviso.
    const suyo = presentes.has(fila.grupo_id) ? fila.grupo_id : null;
    if (suyo === null) superiores.push(fila);
    else hijos.set(suyo, [...(hijos.get(suyo) || []), fila]);
  }

  return superiores.sort(porOrden).map((fila) => ({
    clave: fila.clave,
    orden: fila.orden,
    hijos: esGrupo(fila.clave)
      ? (hijos.get(idDeGrupo(fila.clave)) || []).sort(porOrden).map((h) => h.clave)
      : null,
  }));
}

/** Solo las capas, de abajo arriba. Los grupos no se dibujan en el mapa. */
export const aplanar = () =>
  arbol().flatMap((nodo) => (nodo.hijos === null ? [nodo.clave] : nodo.hijos));

/** Grupo al que pertenece una capa, o null. */
export function grupoDe(clave) {
  const fila = entradas.find((f) => f.clave === clave);
  const presentes = new Set(entradas.filter((f) => esGrupo(f.clave)).map((f) => idDeGrupo(f.clave)));
  return fila && presentes.has(fila.grupo_id) ? fila.grupo_id : null;
}

/** Si esta en el borde de su contenedor, el boton debe salir deshabilitado. */
export function enElBorde(clave, direccion) {
  const nodos = arbol();
  const dentro = nodos.find((n) => n.hijos?.includes(clave));
  const hermanos = dentro ? dentro.hijos : nodos.map((n) => n.clave);
  const posicion = hermanos.indexOf(clave);
  return direccion === 'subir' ? posicion === hermanos.length - 1 : posicion === 0;
}

const enviar = (ruta, cuerpo, metodo = 'POST') => api(ruta, {
  method: metodo,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(cuerpo),
});

export const mover = (clave, direccion) => enviar('/api/pila/mover', { clave, direccion });
export const agrupar = (clave, grupoId) =>
  enviar('/api/pila/agrupar', { clave, grupo_id: grupoId });
export const crearGrupo = (nombre, color) => enviar('/api/grupos', { nombre, color });
export const editarGrupo = (id, cambios) => enviar(`/api/grupos/${id}`, cambios, 'PATCH');
export const disolverGrupo = (id) => api(`/api/grupos/${id}`, { method: 'DELETE' });
```

- [ ] **Step 2: Pasar el estado de las externas al servidor**

En `web/js/externas.js`:

**2a.** Sustituir el párrafo de la cabecera que dice lo contrario de lo que ahora ocurre:

```
 * Que este encendido se guarda en ESTE navegador, no en el servidor. Encender
 * una fuente externa es mirar, no decidir: cada quien explora las que le
 * sirven sin cambiarle el mapa al resto. Lo que si es una decision de equipo
 * -guardar una copia fechada como capa propia- tiene su propio boton y esa si
 * la ve todo el mundo.
```

por:

```
 * Encender una fuente la publica en el mapa del EQUIPO, no solo en este
 * navegador: entra en la pila como cualquier otra capa y se ordena con ellas.
 * Antes era al reves y se guardaba aqui, pero eso hacia imposible poner una
 * externa suelta debajo de un grupo -no habia una sola escala de orden-, y
 * ese caso resulto ser justo el que el equipo necesitaba.
 *
 * Quitarla se la quita a todos, y va sin confirmacion a proposito: el panel
 * es del equipo y volver a encenderla son dos clics.
```

**2b.** Sustituir el bloque de estado local:

```javascript
const LLAVE = 'geovisor.externas';

/** {clave: {visible, opacidad, orden}} de las fuentes encendidas. */
let encendidas = {};
try { encendidas = JSON.parse(localStorage.getItem(LLAVE) || '{}'); } catch { encendidas = {}; }
const guardar = () => localStorage.setItem(LLAVE, JSON.stringify(encendidas));
```

por:

```javascript
/** {clave: {visible, opacidad}} de las fuentes publicadas. Llega del servidor. */
let encendidas = {};
```

**2c.** Sustituir `items()`, `fijar()`, `encender()`, `apagar()` y `mover()` por:

```javascript
/** Fuentes publicadas, con la forma que espera el resto del visor.
 *  El ORDEN no sale de aqui: lo pone la pila. */
export function items() {
  if (!catalogo) return [];
  return Object.keys(encendidas).map((clave) => {
    const fuente = fuenteDe(clave);
    if (!fuente) return null;
    const estado = encendidas[clave];
    return {
      id: clave,
      esExterna: true,
      esRaster: false,
      esImagen: fuente.tipo === 'imagen',
      nombre: fuente.nombre,
      color: fuente.color,
      estilo: fuente.simbologia || null,
      visible: estado.visible !== false,
      opacidad: estado.opacidad ?? 1,
      bounds: fuente.bounds || null,
      total: totales[clave] ?? fuente.total,
      sinUbicacion: sinUbicacion[clave] ?? fuente.sin_ubicacion ?? 0,
      fuente,
    };
  }).filter(Boolean);
}

export async function fijar(clave, cambios) {
  if (!encendidas[clave]) return;
  Object.assign(encendidas[clave], cambios);
  await api(`/api/externas/${clave}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cambios),
  });
}

export async function encender(clave) {
  const fuente = fuenteDe(clave);
  if (!fuente) return;
  if (!encendidas[clave]) {
    await api(`/api/externas/${clave}/encender`, { method: 'POST' });
    encendidas[clave] = { visible: true, opacidad: 1 };
  }
  await precargar(fuente);
  await alCambiar();
}

export async function apagar(clave) {
  await api(`/api/externas/${clave}`, { method: 'DELETE' });
  delete encendidas[clave];
  await alCambiar();
}

export const estaEncendida = (clave) => clave in encendidas;
```

> **Aviso al implementador:** `precargar(fuente)` es el cuerpo que hoy vive dentro de `encender()` y que descarga el GeoJSON para saber cuántos elementos trajo. Extráelo tal cual a una función propia `async function precargar(fuente)` **sin cambiar su lógica**, y llámala desde `encender()`. No la reescribas.

**2d.** Sustituir `inicializar()` entera. Hoy dice:

```javascript
  // Si el navegador venia con fuentes encendidas hay que tener el catalogo
  // antes de pintar el panel, o no se sabria ni como se llaman.
  if (Object.keys(encendidas).length) await cargarCatalogo();
```

Eso **deja de funcionar**: `encendidas` ya no viene del navegador sino del
propio catálogo, así que arranca vacío y esa condición nunca se cumpliría —
el catálogo no se cargaría nunca y no habría fuentes publicadas jamás. Ahora
el catálogo hace falta siempre:

```javascript
export async function inicializar(alCambiarCapas) {
  alCambiar = alCambiarCapas;
  $('externas').onclick = abrir;
  $('externas-cerrar').onclick = cerrar;
  // Ahora hace falta SIEMPRE: que fuentes estan publicadas lo dice el
  // servidor, y viene dentro del propio catalogo.
  await cargarCatalogo();
  encendidas = Object.fromEntries((catalogo?.publicadas || []).map(
    (p) => [p.clave, { visible: p.visible, opacidad: p.opacidad }]));
}
```

> **Aviso al implementador:** comprobar que `cargarCatalogo()` deja el catálogo
> en la variable `catalogo` del módulo y que tolera un fallo de red sin lanzar,
> o el visor entero no arrancaría cuando el catálogo esté caído. Si lanza,
> envolver en `try/catch` y dejar `encendidas = {}`.

- [ ] **Step 3: Construir `items` desde la pila**

En `web/js/capas.js`, añadir la importación:

```javascript
import * as pila from './pila.js';
```

y sustituir el cuerpo de `cargar()` (líneas 51-71) por:

```javascript
export async function cargar() {
  const [capas, rasters] = await Promise.all([
    api('/api/capas').catch(() => []),
    api('/api/rasters').catch(() => []),
    pila.cargar().catch(() => {}),
  ]);

  // La pila manda: dice que hay en el mapa y en que orden. Este mapa solo
  // resuelve cada clave al objeto que el resto del visor sabe pintar.
  const porClave = new Map([
    ...rasters.map((r) => [`raster-${r.id}`, { ...r, esRaster: true }]),
    ...capas.map((c) => [`capa-${c.id}`, { ...c, esRaster: false }]),
    ...externas.items().map((x) => [`ext-${x.id}`, x]),
  ]);

  items = pila.aplanar().map((clave) => porClave.get(clave)).filter(Boolean);

  pintar();
  sincronizarCapas(
    items.filter((i) => i.esExterna || !i.esRaster || i.estado === 'listo').map(efectivo));
  simbologia.reaplicarFiltros(items);
  simbologia.pintarLeyenda(items.map(efectivo));
  vigilarConversiones();
  document.dispatchEvent(new CustomEvent('capas:cambiadas'));
}
```

- [ ] **Step 4: Pintar una lista plana mientras tanto**

Sustituir la constante `GRUPOS` y el cuerpo de `pintar()` por una lista sin cabeceras de categoría. El pintado de grupos llega en la Tarea 8; **este paso solo desmonta las tres categorías fijas**:

```javascript
function pintar() {
  const lista = $('lista-capas');
  lista.innerHTML = '';

  if (!items.length) {
    lista.innerHTML = '<p class="vacio">Aún no hay capas. Crea una o carga un archivo.</p>';
    return;
  }

  // De frente a fondo: arriba en la lista es encima en el mapa, como en QGIS.
  [...items].reverse().forEach((item, indice, arreglo) =>
    lista.appendChild(item.esExterna
      ? pintarFilaExterna(item, indice, arreglo.length, false)
      : pintarFila(item, indice, arreglo.length, false)));
}
```

Borrar también la constante `GRUPOS`, el `Set` `gruposOcultos`, la función `grupoDe` y el uso de `plegados`/`guardarPlegados`, que dejan de tener sentido. `efectivo(item)` pasa a ser `(item) => item`.

- [ ] **Step 5: Enrutar `↑↓` a la pila**

En `capas.js`, sustituir la función `intercambiar()` completa y el caso `subir`/`bajar` de `manejar()` y de `manejarExterna()` por una única llamada:

```javascript
    case 'subir':
    case 'bajar':
      await pila.mover(claveDePila(item), accion);
      await cargar();
      break;
```

y añadir el auxiliar junto a `grupoDe` (que se acaba de borrar):

```javascript
/** Clave de esta capa dentro de la pila. */
const claveDePila = (item) =>
  item.esExterna ? `ext-${item.id}` : `${item.esRaster ? 'raster' : 'capa'}-${item.id}`;
```

En ambas funciones de pintado, el `disabled` de los botones pasa a salir de la pila:

```javascript
        <button class="icono" data-accion="subir" ${pila.enElBorde(claveDePila(item), 'subir') ? 'disabled' : ''}
```

y lo análogo para `bajar`. Borrar los parámetros `indice` y `total` de ambas funciones si dejan de usarse.

- [ ] **Step 6: Comprobar sintaxis**

```bash
node --check web/js/pila.js && node --check web/js/capas.js && node --check web/js/externas.js
```

Esperado: sin salida (correcto).

- [ ] **Step 7: Commit**

```bash
git add web/js/pila.js web/js/capas.js web/js/externas.js
git commit -m "Ordenar todas las capas en una sola escala, la de la pila

Desaparecen las tres categorias fijas. Cualquier capa se puede poner
encima de cualquier otra, sea dibujo, imagen o fuente externa, que era
justo lo que el modelo anterior hacia imposible.

El mapa no se toca: sincronizarCapas ya apilaba recorriendo el arreglo.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: Frontend — grupos en el panel

**Files:**
- Modify: `web/js/capas.js` (`pintar`, `pintarFila`, `pintarFilaExterna`, `manejar`)
- Modify: `web/estilos.css`

**Interfaces:**
- Consumes: `pila.arbol()`, `pila.grupos()`, `pila.agrupar`, `pila.crearGrupo`, `pila.editarGrupo`, `pila.disolverGrupo`, `pila.grupoDe`.
- Produces: nada que consuman otras tareas.

- [ ] **Step 1: Pintar el árbol con cabeceras de grupo**

En `capas.js`, sustituir `pintar()` por:

```javascript
/** Plegado de grupos: es preferencia de vista, se queda en este navegador. */
const plegados = new Set(
  JSON.parse(localStorage.getItem('geovisor.grupos-plegados') || '[]'));
const guardarPlegados = () =>
  localStorage.setItem('geovisor.grupos-plegados', JSON.stringify([...plegados]));

function pintar() {
  const lista = $('lista-capas');
  lista.innerHTML = '';

  if (!items.length && !pila.grupos().length) {
    lista.innerHTML = '<p class="vacio">Aún no hay capas. Crea una o carga un archivo.</p>';
    return;
  }

  const porClave = new Map(items.map((i) => [claveDePila(i), i]));

  // De frente a fondo, como en QGIS: arriba en la lista es encima en el mapa.
  for (const nodo of [...pila.arbol()].reverse()) {
    if (nodo.hijos === null) {
      const item = porClave.get(nodo.clave);
      if (item) lista.appendChild(filaDe(item));
      continue;
    }
    lista.appendChild(cabeceraDeGrupo(nodo));
    if (plegados.has(nodo.clave)) continue;
    const cuerpo = document.createElement('div');
    cuerpo.className = 'grupo-cuerpo';
    for (const clave of [...nodo.hijos].reverse()) {
      const item = porClave.get(clave);
      if (item) cuerpo.appendChild(filaDe(item));
    }
    lista.appendChild(cuerpo);
  }
}

const filaDe = (item) => (item.esExterna ? pintarFilaExterna(item) : pintarFila(item));
```

- [ ] **Step 2: Escribir la cabecera de grupo**

Añadir en `capas.js`, justo antes de `pintarFila`:

```javascript
/** Cabecera de un grupo: plegar, encender todo, color, nombre y orden.
 *
 *  Sustituye a las cabeceras de categoria fijas que habia antes. La
 *  diferencia es que estas las define el equipo, y por eso llevan tambien
 *  renombrar y disolver. */
function cabeceraDeGrupo(nodo) {
  const id = Number(nodo.clave.slice('grupo-'.length));
  const grupo = pila.grupos().find((g) => g.id === id);
  if (!grupo) return document.createDocumentFragment();

  const dentro = nodo.hijos
    .map((c) => items.find((i) => claveDePila(i) === c))
    .filter(Boolean);
  const encendidas = dentro.filter((i) => i.visible).length;
  const plegado = plegados.has(nodo.clave);

  const cabecera = document.createElement('div');
  cabecera.className = 'grupo-cabecera' + (plegado ? ' plegado' : '');
  cabecera.innerHTML = `
    <button class="chevron" aria-expanded="${!plegado}"
            aria-label="${plegado ? 'Desplegar' : 'Plegar'} ${escapar(grupo.nombre)}">&#9662;</button>
    <input type="checkbox" ${encendidas ? 'checked' : ''}
           aria-label="Mostrar todo el grupo ${escapar(grupo.nombre)}">
    <span class="punto-grupo" style="background:${escapar(grupo.color)}"></span>
    <span class="titulo">${escapar(grupo.nombre)}</span>
    <span class="conteo ${encendidas ? 'vivo' : ''}">${encendidas}/${dentro.length}</span>
    <button class="icono" data-grupo="subir" ${pila.enElBorde(nodo.clave, 'subir') ? 'disabled' : ''}
            title="Traer al frente" aria-label="Traer al frente">&uarr;</button>
    <button class="icono" data-grupo="bajar" ${pila.enElBorde(nodo.clave, 'bajar') ? 'disabled' : ''}
            title="Enviar atrás" aria-label="Enviar atrás">&darr;</button>
    <button class="icono" data-grupo="opciones" title="Opciones del grupo"
            aria-label="Opciones del grupo">&#8943;</button>`;

  cabecera.querySelector('.chevron').onclick = () => {
    if (plegado) plegados.delete(nodo.clave); else plegados.add(nodo.clave);
    guardarPlegados();
    pintar();
  };
  cabecera.querySelector('input').onchange = async (evento) => {
    const visible = evento.target.checked;
    await Promise.all(dentro.map((i) => actualizar(i, { visible }, false)));
    pintar();
  };
  cabecera.querySelectorAll('[data-grupo]').forEach((control) => {
    control.onclick = () => manejarGrupo(control.dataset.grupo, grupo, nodo);
  });
  return cabecera;
}

async function manejarGrupo(accion, grupo, nodo) {
  try {
    if (accion === 'subir' || accion === 'bajar') {
      await pila.mover(nodo.clave, accion);
    } else if (accion === 'opciones') {
      const que = prompt(
        `Grupo "${grupo.nombre}".\n\n` +
        'Escribe un nombre nuevo para renombrarlo,\n' +
        'un color en formato #rrggbb para recolorearlo,\n' +
        'o la palabra DISOLVER para deshacer el grupo (las capas no se borran).',
        grupo.nombre);
      if (!que) return;
      if (que.trim().toUpperCase() === 'DISOLVER') {
        const salida = await pila.disolverGrupo(grupo.id);
        avisar(`Grupo deshecho. ${salida.sueltas} capa(s) quedaron sueltas.`);
      } else if (/^#[0-9a-f]{6}$/i.test(que.trim())) {
        await pila.editarGrupo(grupo.id, { color: que.trim() });
      } else {
        await pila.editarGrupo(grupo.id, { nombre: que.trim() });
      }
    }
    await cargar();
  } catch (error) { avisar(error.message, true); }
}
```

- [ ] **Step 3: Añadir el selector de grupo y los chips a las filas**

En `pintarFila` y en `pintarFilaExterna`, añadir dentro de `capa-detalle`, justo antes de la fila de `Ir a la capa`:

```javascript
        ${selectorDeGrupo(item)}
```

y definir junto a `bloqueDescarga`:

```javascript
/** Selector para meter o sacar la capa de un grupo. Es la unica via: mover
 *  con las flechas nunca cruza la frontera de un grupo. */
function selectorDeGrupo(item) {
  const actual = pila.grupoDe(claveDePila(item));
  return `
    <label style="margin-top:8px">Grupo</label>
    <select data-accion="grupo">
      <option value="" ${actual === null ? 'selected' : ''}>(sin grupo)</option>
      ${pila.grupos().map((g) => `
        <option value="${g.id}" ${actual === g.id ? 'selected' : ''}>${escapar(g.nombre)}</option>`).join('')}
      <option value="nuevo">+ Nuevo grupo…</option>
    </select>`;
}
```

En el cableado de controles de ambas funciones, añadir la rama:

```javascript
    } else if (accion === 'grupo') {
      control.onchange = async (e) => {
        try {
          let destino = e.target.value === '' ? null : e.target.value;
          if (destino === 'nuevo') {
            const nombre = prompt('Nombre del grupo nuevo:', 'Grupo');
            if (!nombre || !nombre.trim()) { pintar(); return; }
            destino = (await pila.crearGrupo(nombre.trim(), '#8d99ae')).id;
          }
          await pila.agrupar(claveDePila(item), destino === null ? null : Number(destino));
          await cargar();
        } catch (error) { avisar(error.message, true); pintar(); }
      };
```

Y en la cabecera de cada fila, añadir el chip después del nombre. En `pintarFilaExterna`:

```javascript
        <span class="estado tipo">ext</span>
```

En `pintarFila`, solo para rásters, justo antes del `<span class="conteo">`:

```javascript
        ${item.esRaster ? '<span class="estado tipo">img</span>' : ''}
```

- [ ] **Step 4: Estilos**

Añadir al final de `web/estilos.css`:

```css
/* --- Grupos de capas ------------------------------------------------------ */
/* El grupo lo define el equipo, no el visor: por eso su cabecera lleva color
   y opciones, cosa que las categorias fijas de antes no necesitaban. */
.punto-grupo {
  width: 9px;
  height: 9px;
  border-radius: 2px;
  flex-shrink: 0;
}
.grupo-cuerpo { padding-left: 9px; border-left: 1px solid var(--borde); margin-left: 5px; }

/* Chip de tipo. Con las capas intercaladas, el borde punteado de una externa
   se compara mal contra una vecina que ya no esta al lado. */
.estado.tipo {
  padding: 1px 4px;
  border: 1px solid var(--borde);
  border-radius: 3px;
  text-transform: uppercase;
  letter-spacing: .04em;
}
```

- [ ] **Step 5: Comprobar sintaxis**

```bash
node --check web/js/capas.js
```

Esperado: sin salida.

- [ ] **Step 6: Commit**

```bash
git add web/js/capas.js web/estilos.css
git commit -m "Agrupar capas de cualquier tipo en el panel

Un grupo puede llevar dentro un dibujo, una imagen y una fuente externa a
la vez, se pliega, se mueve en bloque y se apaga de un clic. Sustituye a
las categorias fijas, con la diferencia de que estos los define el equipo
y por eso se renombran, se colorean y se disuelven.

Disolver no borra: las capas quedan sueltas donde estaba el grupo.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 9: Retirar `orden` de los PATCH

**Files:**
- Modify: `backend/app/routers/capas.py:33-38` (`CapaParche`)
- Modify: `backend/app/routers/rasters.py:82-87` (`RasterParche`)

**Interfaces:**
- Consumes: nada.
- Produces: nada.

> Va al final a propósito: hasta que el panel no dejó de enviarlo (Tarea 7), retirarlo habría roto el reordenamiento en producción.

- [ ] **Step 1: Quitar el campo de los dos modelos**

En `CapaParche` y en `RasterParche`, borrar la línea `orden: int | None = None` y añadir encima de la clase:

```python
# Sin `orden`: el orden lo manda la tabla `pila`, no esta. Dejarlo aqui
# aceptando escrituras dejaria dos fuentes de verdad sobre lo mismo.
```

Comprobar antes que las columnas siguen existiendo en la base: se conservan como semilla de la primera materialización y no se tocan.

- [ ] **Step 2: Comprobar que nadie lo envía ya**

```bash
grep -rn "orden" web/js/ | grep -v "pila.js" | grep -vi "reorden"
```

Esperado: ninguna línea que construya un `body` con `orden`.

- [ ] **Step 3: Comprobar que la aplicación importa**

```bash
docker compose build api
docker run --rm --network none -e DATABASE_URL=postgresql://x/x -e CLAVE_ACCESO=x -e SECRET_KEY=x \
  geovisor-api python -c "
from app.routers.capas import CapaParche
from app.routers.rasters import RasterParche
assert 'orden' not in CapaParche.model_fields
assert 'orden' not in RasterParche.model_fields
print('orden retirado de los dos parches')"
```

- [ ] **Step 4: Commit**

```bash
git add backend/app/routers/capas.py backend/app/routers/rasters.py
git commit -m "Retirar orden de los parches de capa y raster

La pila es la unica fuente de verdad del orden. Dejar estas columnas
aceptando escrituras dejaba dos sitios donde mirar para responder a la
misma pregunta. Se conservan en la base como semilla del primer arranque.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 10: Despliegue y verificación

**Files:** ninguno.

- [ ] **Step 1: Capturar el orden actual ANTES de nada**

```bash
ssh root@5.161.176.32 'cd /opt/geovisor && set -a && . ./.env && set +a && C=$(mktemp) && \
curl -s -c "$C" -X POST "https://${DOMINIO}/api/login" -H "Content-Type: application/json" \
  -d "{\"clave\":\"$CLAVE_ACCESO\"}" >/dev/null && \
echo "== CAPAS ==" && curl -s -b "$C" "https://${DOMINIO}/api/capas" | python3 -c "
import json,sys; [print(c[\"orden\"], c[\"id\"], c[\"nombre\"]) for c in json.load(sys.stdin)]" && \
echo "== RASTERS ==" && curl -s -b "$C" "https://${DOMINIO}/api/rasters" | python3 -c "
import json,sys; [print(r[\"orden\"], r[\"id\"], r[\"nombre\"]) for r in json.load(sys.stdin)]"' \
  | tee /tmp/orden-antes.txt
```

Guardar la salida. Es la referencia del punto 3.

- [ ] **Step 2: Avisar al equipo**

Las fuentes externas que cada quien tenga encendidas viven en su `localStorage` y **se pierden**. Nacen apagadas para todos y se encienden una vez desde el catálogo. Confirmar con Andrés que el equipo está avisado **antes** de seguir.

- [ ] **Step 3: Fusionar, validar la imagen y desplegar**

```bash
cd backend && python -m unittest discover -s tests -v && cd ..
git checkout main && git merge --ff-only grupos-de-capas && git push origin main
ssh root@5.161.176.32 'cd /opt/geovisor && git pull --ff-only -q && docker compose build api && \
  docker run --rm --network none -e DATABASE_URL=postgresql://x/x -e CLAVE_ACCESO=x -e SECRET_KEY=x \
    geovisor-api python -c "from app.main import app; print(len(app.routes), \"rutas\")"'
ssh root@5.161.176.32 'cd /opt/geovisor && SKIP_PULL=1 ./deploy.sh'
```

- [ ] **Step 4: Comprobar la continuidad del orden**

Pedir `/api/pila` y comprobar que el aplanado coincide **capa por capa** con `/tmp/orden-antes.txt`: los rásters por debajo y en su orden, y encima las capas de dibujo en el suyo. Si no coincide, **revertir el despliegue** (`git revert`, `deploy.sh`) antes de tocar nada más.

- [ ] **Step 5: Recorrer el resto de la verificación de la especificación**

Puntos 2 a 8 de la sección *Verificación* del documento de diseño. En particular, el caso que originó el rediseño: **dejar una externa suelta, sin agrupar, por debajo de un grupo, y comprobar que ahí sigue tras recargar.**

- [ ] **Step 6: Comprobar que no se tumbó nada ajeno**

```bash
ssh root@5.161.176.32 'docker ps --format "{{.Names}} {{.Status}}" | sort'
```

Esperado: los seis `oar_*` en pie y los cinco `geo_*` arriba, `geo_api` y `geo_db` en `healthy`.
