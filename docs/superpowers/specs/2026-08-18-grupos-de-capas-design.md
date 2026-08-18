# Grupos de capas y orden compartido

Fecha: 2026-08-18 · Estado: propuesta, pendiente de revisión

## El problema

El panel agrupa las capas en tres categorías fijas —imágenes abajo, fuentes
externas en medio, dibujo encima— y solo se puede reordenar **dentro** de cada
una. Eso impide dos cosas que el equipo necesita:

1. Poner una fuente externa por encima de un dibujo propio, o al revés.
2. Manejar el panel cuando hay muchas capas. Ya son 6 de dibujo, 28 imágenes y
   23 fuentes externas disponibles, y siguen entrando.

## Qué se decidió

| Decisión | Elección |
|---|---|
| Orden de las capas | Compartido, en el servidor |
| Categorías fijas | Desaparecen. Un solo montón ordenable |
| Imágenes | Sin estrato fijo; una imagen **nueva** entra al fondo |
| Grupos | Definidos por el equipo, mezclan cualquier tipo de capa |
| Grupo con una externa dentro | Compartido: se enciende para todo el equipo |
| Externa encendida sin agrupar | Flota **encima** de todo, solo para quien la encendió |
| Capacidades del grupo | Plegar, mover en bloque, apagar/encender todo, renombrar, color |
| Opacidad de grupo | **Fuera de alcance** (no se pidió) |

La regla que resume el modelo:

> **Lo que exploras va encima. Lo que el equipo decide, va en su sitio.**

Agrupar deja de ser solo un gesto de orden y pasa a significar *esto ya no es
exploración, es parte del mapa del equipo*.

## Modelo de datos

Hoy el orden vive en tres sitios con escalas independientes: `capas.orden`,
`rasters.orden` y `localStorage` para las externas. Mezclarlas en una sola
escala manteniendo tres almacenes lleva a que dos navegadores con distinto
juego de externas se pisen la numeración mutuamente en cada recarga. Por eso
**una sola tabla pasa a ser dueña de la pila**.

```sql
CREATE TABLE IF NOT EXISTS grupos (
  id     SERIAL PRIMARY KEY,
  nombre TEXT NOT NULL,
  color  TEXT NOT NULL DEFAULT '#8d99ae'
);

CREATE TABLE IF NOT EXISTS pila (
  clave    TEXT PRIMARY KEY,   -- capa-13 | raster-6 | ext-ungrd-ede | grupo-2
  grupo_id INTEGER REFERENCES grupos(id) ON DELETE SET NULL,
  orden    INTEGER NOT NULL
);
```

Un grupo es **también una entrada de la pila**, con clave `grupo-N`. Con eso:

- **Nivel superior** = filas con `grupo_id IS NULL`, ordenadas por `orden`.
  Incluye grupos y capas sueltas, mezclados.
- **Dentro de un grupo** = filas con `grupo_id = N`, ordenadas por `orden`.

Dos escalas de orden, separadas limpiamente por `grupo_id`, en una sola tabla.
No hacen falta decimales ni renumeraciones globales: mover es intercambiar dos
`orden` entre hermanos, que es exactamente lo que ya hace el código actual.

El plegado de un grupo **no** va aquí: es una preferencia de vista y sigue en
`localStorage`, como el plegado de categorías de hoy.

### Materialización y continuidad

`GET /api/pila` se autorrepara en cada lectura:

- Toda `capas.id` y todo `rasters.id` sin fila en `pila` recibe una, suelta
  (`grupo_id = NULL`). Una **capa de dibujo** nueva entra por arriba —se acaba
  de crear para dibujar en ella— y una **imagen** nueva entra por abajo, que es
  la regla acordada.
- Filas que apuntan a una capa o ráster borrado se eliminan.
- Filas `ext-*` cuya clave ya no exista en `fuentes.POR_CLAVE` se eliminan
  también: una fuente retirada del catálogo no puede dejar la pila coja.

La **primera** materialización siembra el orden reproduciendo exactamente lo
que el equipo ve hoy: primero los rásters por su `orden` actual, encima las
capas de dibujo por el suyo. Nadie encuentra el mapa cambiado al recargar. No
hace falta script de migración: la siembra es la propia lectura.

`capas.orden` y `rasters.orden` quedan solo como semilla. Para no dejar dos
fuentes de verdad, se retira `orden` de `CapaParche` y `RasterParche`: el panel
deja de enviarlo y el orden pasa a viajar únicamente por los endpoints nuevos.

## API

| Método | Ruta | Qué hace |
|---|---|---|
| `GET` | `/api/pila` | Grupos y entradas, ya materializados |
| `POST` | `/api/pila/mover` | `{clave, direccion}` — intercambia con el hermano vecino |
| `POST` | `/api/pila/agrupar` | `{clave, grupo_id}` — mete o saca del grupo (`null` = sacar) |
| `POST` | `/api/grupos` | `{nombre, color}` |
| `PATCH` | `/api/grupos/{id}` | `{nombre?, color?}` |
| `DELETE` | `/api/grupos/{id}` | Los miembros quedan sueltos, no se borran |

`mover` y `agrupar` son operaciones explícitas y no un `PUT` de la pila entera:
con varias personas trabajando a la vez, enviar el montón completo haría que el
último en guardar pisara el reordenamiento del otro. Cada operación se resuelve
en una transacción y toca dos filas como mucho.

Detalles que la implementación no debe decidir por su cuenta:

- `direccion` es `subir` o `bajar`, como el `data-accion` que ya usa el panel.
  Subir es acercarse al frente del mapa.
- `mover` intercambia **solo entre hermanos**: nunca saca una capa de su grupo
  ni la mete en uno. Al llegar al borde de su contenedor, no hace nada; el
  botón sale deshabilitado, como hoy en el borde de categoría.
- Un grupo recién creado entra **al frente** del nivel superior, para verlo sin
  buscarlo.
- Una capa que entra a un grupo se coloca **al frente** de ese grupo, por lo
  mismo.
- Al disolver un grupo, sus miembros quedan sueltos **en el sitio donde estaba
  el grupo** y conservando su orden relativo, no repartidos por el montón.

## Frontend

### Ensamblado de la lista

`capas.js cargar()` deja de concatenar tres bloques ordenados por separado y
pasa a construir la lista desde la pila:

```
items = [ ...pilaAplanada, ...externasLocalesSinAgrupar ]
```

`pilaAplanada` recorre el nivel superior en orden y expande cada grupo en su
sitio. Las externas locales van al final del arreglo, es decir **encima** en el
mapa, ordenadas entre sí por el `orden` de `localStorage` que ya usan hoy.

El arreglo va de abajo arriba, como hasta ahora; el panel lo pinta invertido,
porque arriba en la lista es encima en el mapa —la convención de QGIS que el
visor ya sigue.

**El mapa no se toca.** `sincronizarCapas` apila recorriendo el arreglo y
moviendo cada capa al tope; no sabe nada de categorías. Cambiar cómo se arma la
lista basta.

### Externas de un grupo

Una `ext-*` en la pila la ve todo el equipo, así que al cargar hay que
asegurarse de que sus datos estén pedidos aunque quien mira no la haya
encendido a mano. `externas.encender()` ya hace ese trabajo; se invoca para
cada `ext-*` de la pila.

Que esté encendida es del equipo; que esté **visible** sigue siendo de cada
quien —el ojo de la fila— y se guarda en `localStorage` como hasta ahora.

### Panel

```
── explorando (solo tú) ──────────  ← solo si hay externas locales
   ┆ Copernicus grading      ext
── mapa del equipo ───────────────
   ▼ ■ Comuna 19        4  ☑  ↑↓
       ┆ Matriz EDE          ext
       │ Bloques-Dron
       │ VueloDron Zona1     img
   │ EDAN                        ↑↓
   ▼ ■ Consolidado      2  ☑  ↑↓
       │ Edificios Afectados
   │ Ortofoto Cali 2023     img  ↑↓
```

- La cabecera de grupo lleva chevron (plegar, local), casilla (encender todo),
  cuadro de color, nombre, conteo y `↑↓`. Renombrar, recolorear y disolver
  cuelgan de ella.
- `↑↓` de una fila mueve **entre hermanos**: dentro del grupo si está en uno,
  en el nivel superior si está suelta.
- Para entrar o salir de un grupo, un `<select>` en el detalle desplegado de la
  capa: `(sin grupo) · Comuna 19 · Consolidado · + Nuevo grupo…`.
- La marca de externa se mantiene: borde izquierdo punteado, ya existente, más
  un chip `ext` junto al nombre, porque intercaladas el borde solo no basta.
  Las imágenes llevan `img` por el mismo motivo.
- La cabecera `explorando` lleva su casilla para apagarlas todas de un clic.

### Lo que se pierde

Las cabeceras de categoría daban un interruptor masivo por tipo. Con grupos
definidos por el equipo eso se sustituye por la casilla de cada grupo más la de
`explorando`. **Una capa suelta ya no tiene apagado masivo**: se apaga con su
ojo, o se mete en un grupo. Es una consecuencia deliberada de que las
categorías fijas desaparezcan.

## Verificación

El repo no tiene pruebas ni forma de levantarlas. Se verifica contra el
despliegue, como el resto del trabajo de hoy:

1. **Continuidad**: antes de desplegar, capturar el orden actual; después,
   comprobar que la pila materializada lo reproduce capa por capa.
2. Crear grupo, meter una capa de cada tipo, mover el grupo, comprobar el
   apilado real que devuelve `/api/pila`.
3. Disolver un grupo y comprobar que los miembros quedan sueltos y **no se
   borran**.
4. Borrar una capa con fila en `pila` y comprobar que la fila desaparece.
5. Simular dos navegadores: uno agrupa una externa y el otro la recibe al
   recargar; el que explora sin agrupar no le mueve nada al primero.
6. Regresión: las 23 fuentes vivas, export por capa, descarga de ráster,
   teselas y `/health`.
7. `oar_*` en pie.

## Riesgos

| Riesgo | Mitigación |
|---|---|
| La siembra no reproduce el orden actual y el equipo encuentra el mapa cambiado | Punto 1 de verificación, con captura previa |
| Agrupar una externa le enciende una capa a todo el mundo | Es lo decidido; el chip `ext` y el grupo lo hacen visible, y el ojo lo apaga |
| Sin estrato fijo, alguien sube una ortofoto opaca y se tapa el mapa | Las imágenes nuevas entran al fondo; subirla es deliberado y se deshace igual |
| Dos personas reordenan a la vez | Operaciones explícitas de dos filas, no envío del montón completo |

## Fuera de alcance

- Opacidad por grupo.
- Grupos anidados.
- Arrastrar y soltar; se mantiene `↑↓`, que funciona igual en tableta.
- Una capa en varios grupos a la vez.
