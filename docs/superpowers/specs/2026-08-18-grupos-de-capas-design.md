# Grupos de capas y orden compartido

Fecha: 2026-08-18 · Estado: propuesta, pendiente de revisión

## El problema

El panel agrupa las capas en tres categorías fijas —imágenes abajo, fuentes
externas en medio, dibujo encima— y solo se puede reordenar **dentro** de cada
una. Eso impide dos cosas que el equipo necesita:

1. Poner una fuente externa por encima de un dibujo propio, o al revés.
2. Manejar el panel cuando hay muchas capas. Ya son 6 de dibujo, 28 imágenes y
   23 fuentes externas disponibles, y siguen entrando.

## La regla

> **Toda capa —propia, imagen o externa, agrupada o suelta— es una fila de la
> pila, en una única escala de orden compartida por el equipo.**

No hay capas de segunda. Encender una fuente externa es ponerla en el mapa del
equipo, igual que crear una capa de dibujo. El orden importa siempre, esté o no
esté agrupada, y quitar algo se lo quita a todo el mundo.

Esa regla salió de un caso que el diseño anterior no cubría: **una externa
suelta que debe ir debajo de un grupo, sin meterla en él**. Cualquier modelo que
reserve un sitio especial —"lo que exploras va encima"— hace esa posición
imposible de expresar.

## Qué se decidió

| Decisión | Elección |
|---|---|
| Orden de las capas | Compartido, en el servidor |
| Categorías fijas | Desaparecen. Un solo montón ordenable |
| Imágenes | Sin estrato fijo; una imagen **nueva** entra al fondo |
| Grupos | Definidos por el equipo, mezclan cualquier tipo de capa |
| Encender / apagar / quitar una externa | Compartido, como todo lo demás |
| Confirmaciones | Ninguna. Encender, ordenar, apagar y quitar van directos |
| Capacidades del grupo | Plegar, mover en bloque, apagar/encender todo, renombrar, color |
| Opacidad de grupo | **Fuera de alcance** (no se pidió) |

### Cambio de filosofía, explícito

`externas.js` documenta hoy justo lo contrario:

> *Que esto esté encendido se guarda en ESTE navegador, no en el servidor.
> Encender una fuente externa es mirar, no decidir.*

Eso deja de ser cierto. **Hay que reescribir ese comentario en el mismo cambio**,
o el archivo pasa a mentir sobre sí mismo. La distinción entre mirar y decidir
desaparece: ahora todo es decidir.

A cambio, el visor gana coherencia. El ojo y la opacidad de una capa propia ya
eran compartidos —viven en Postgres—, así que unificar las externas elimina la
única excepción del modelo, no añade una nueva.

## Modelo de datos

Hoy el orden vive en tres sitios con escalas independientes: `capas.orden`,
`rasters.orden` y `localStorage` para las externas. Ahora **una sola tabla es
dueña de la pila**.

```sql
CREATE TABLE IF NOT EXISTS grupos (
  id     SERIAL PRIMARY KEY,
  nombre TEXT NOT NULL,
  color  TEXT NOT NULL DEFAULT '#8d99ae'
);

-- Estado de una fuente externa publicada en el mapa. Equivale a lo que
-- capas y rasters ya guardan en su propia tabla; el nombre y el color
-- los pone el catalogo, no la base.
CREATE TABLE IF NOT EXISTS externas (
  clave    TEXT PRIMARY KEY,
  visible  BOOLEAN NOT NULL DEFAULT true,
  opacidad REAL    NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS pila (
  clave    TEXT PRIMARY KEY,   -- capa-13 | raster-6 | ext-ungrd-ede | grupo-2
  grupo_id INTEGER REFERENCES grupos(id) ON DELETE SET NULL,
  orden    INTEGER NOT NULL
);
```

Un grupo es **también una entrada de la pila**, con clave `grupo-N`. Con eso:

- **Nivel superior** = filas con `grupo_id IS NULL`, ordenadas por `orden`.
  Grupos y capas sueltas, mezclados, en la misma escala.
- **Dentro de un grupo** = filas con `grupo_id = N`, ordenadas por `orden`.

Dos escalas separadas limpiamente por una columna, en una tabla. Mover es
intercambiar dos `orden` entre hermanos, que es exactamente lo que ya hace el
código actual. Sin decimales y sin renumerar nada globalmente.

Estar en `pila` es lo que significa *estar en el mapa*. Encender una externa
inserta su fila; quitarla la borra, junto con su fila de `externas`.

El plegado de un grupo **no** va aquí: es preferencia de vista y se queda en
`localStorage`, como el plegado de categorías de hoy. Es lo único que queda
siendo local.

### Materialización y continuidad

`GET /api/pila` se autorrepara en cada lectura:

- Toda `capas.id` y todo `rasters.id` sin fila en `pila` recibe una, suelta
  (`grupo_id = NULL`). Una **capa de dibujo** nueva entra por arriba —se acaba
  de crear para dibujar en ella— y una **imagen** nueva entra por abajo, que es
  la regla acordada.
- Filas que apuntan a una capa o ráster borrado se eliminan.
- Filas `ext-*` cuya clave ya no exista en `fuentes.POR_CLAVE` se eliminan
  también: una fuente retirada del catálogo no puede dejar la pila coja.

La **primera** materialización siembra el orden reproduciendo exactamente lo que
el equipo ve hoy: primero los rásters por su `orden` actual, encima las capas de
dibujo por el suyo. Las externas que cada quien tuviera encendidas en su
navegador **no** se migran: nacen apagadas para todos y se encienden una vez,
desde el catálogo, ya como decisión de equipo. Conviene avisar al equipo de eso
antes de desplegar.

No hace falta script de migración: la siembra es la propia lectura.

`capas.orden` y `rasters.orden` quedan solo como semilla. Para no dejar dos
fuentes de verdad, se retira `orden` de `CapaParche` y `RasterParche`: el panel
deja de enviarlo y el orden viaja únicamente por los endpoints nuevos.

## API

| Método | Ruta | Qué hace |
|---|---|---|
| `GET` | `/api/pila` | Grupos y entradas, ya materializados |
| `POST` | `/api/pila/mover` | `{clave, direccion}` — intercambia con el hermano vecino |
| `POST` | `/api/pila/agrupar` | `{clave, grupo_id}` — mete o saca del grupo (`null` = sacar) |
| `POST` | `/api/externas/{clave}/encender` | Inserta en `pila` y en `externas` |
| `DELETE` | `/api/externas/{clave}` | Quita del mapa del equipo |
| `PATCH` | `/api/externas/{clave}` | `{visible?, opacidad?}` |
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
  ni la mete en uno. En el borde de su contenedor no hace nada y el botón sale
  deshabilitado, como hoy en el borde de categoría.
- Un grupo recién creado entra **al frente** del nivel superior.
- Una capa que entra a un grupo se coloca **al frente** de ese grupo.
- Una externa recién encendida entra **al frente** del nivel superior, suelta.
- Al disolver un grupo, sus miembros quedan sueltos **en el sitio donde estaba
  el grupo** y conservando su orden relativo, no repartidos por el montón.

## Frontend

### Ensamblado de la lista

`capas.js cargar()` deja de concatenar tres bloques ordenados por separado y
pasa a construir la lista desde la pila:

```
items = pilaAplanada    // y nada más
```

`pilaAplanada` recorre el nivel superior en orden y expande cada grupo en su
sitio. El arreglo va de abajo arriba, como hasta ahora; el panel lo pinta
invertido, porque arriba en la lista es encima en el mapa —la convención de
QGIS que el visor ya sigue.

**El mapa no se toca.** `sincronizarCapas` apila recorriendo el arreglo y
moviendo cada capa al tope; no sabe nada de categorías. Cambiar cómo se arma la
lista basta.

### Fuentes externas

`externas.js` pierde su estado en `localStorage` y pasa a leer del servidor.
Toda `ext-*` de la pila se carga al arrancar, la haya encendido quien la haya
encendido: sus datos se piden con `externas.encender()`, que ya hace ese
trabajo.

### Panel

```
▼ ■ Comuna 19        4  ☑  ↑↓
    ┆ Matriz EDE          ext
    │ Bloques-Dron
    │ VueloDron Zona1     img
│ EDAN                        ↑↓
┆ INVIAS red vial        ext  ↑↓   ← suelta, y debajo de un grupo
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

### Lo que se pierde

Las cabeceras de categoría daban un interruptor masivo por tipo. Con grupos
definidos por el equipo eso se sustituye por la casilla de cada grupo.
**Una capa suelta ya no tiene apagado masivo**: se apaga con su ojo, o se mete
en un grupo. Es consecuencia deliberada de que las categorías fijas
desaparezcan.

## Verificación

El repo no tiene pruebas ni forma de levantarlas. Se verifica contra el
despliegue, como el resto del trabajo de hoy:

1. **Continuidad**: antes de desplegar, capturar el orden actual; después,
   comprobar que la pila materializada lo reproduce capa por capa.
2. Crear grupo, meter una capa de cada tipo, mover el grupo, comprobar el
   apilado real que devuelve `/api/pila`.
3. **El caso que originó el rediseño**: dejar una externa suelta, sin agrupar,
   por debajo de un grupo, y comprobar que ahí se queda tras recargar.
4. Disolver un grupo y comprobar que los miembros quedan sueltos, en el sitio
   del grupo y **sin borrarse**.
5. Borrar una capa con fila en `pila` y comprobar que la fila desaparece.
6. Dos navegadores: uno enciende, ordena y quita; el otro lo ve todo al
   recargar.
7. Regresión: las 23 fuentes vivas, export por capa, descarga de ráster,
   teselas y `/health`.
8. `oar_*` en pie.

## Riesgos

| Riesgo | Mitigación |
|---|---|
| La siembra no reproduce el orden actual y el equipo encuentra el mapa cambiado | Punto 1 de verificación, con captura previa |
| Alguien quita una fuente que otro estaba usando, sin aviso | Aceptado a propósito: el panel es del equipo. Volver a encenderla son dos clics |
| Las externas encendidas hoy en cada navegador se pierden al desplegar | Avisar al equipo antes; se vuelven a encender una vez y ya quedan para todos |
| Sin estrato fijo, alguien sube una ortofoto opaca y se tapa el mapa | Las imágenes nuevas entran al fondo; subirla es deliberado y se deshace igual |
| Dos personas reordenan a la vez | Operaciones explícitas de dos filas, no envío del montón completo |

## Fuera de alcance

- Opacidad por grupo.
- Grupos anidados.
- Arrastrar y soltar; se mantiene `↑↓`, que funciona igual en tableta.
- Una capa en varios grupos a la vez.
- Previsualizar una fuente del catálogo sin publicarla al equipo.
