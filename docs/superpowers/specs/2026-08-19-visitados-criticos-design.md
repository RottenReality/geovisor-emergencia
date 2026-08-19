# Visitados críticos (Alcaldía de Cali) como fuente externa

Fecha: 2026-08-19

## Qué es

La Alcaldía de Cali publica una API con los casos **Visitado Crítico**: inmuebles
donde un ingeniero o arquitecto fue, evaluó y confirmó colapso total (A) o riesgo
de colapso (B). Hoy el equipo no los ve en el visor; están en un sistema aparte.

Medido contra la API real el 2026-08-19, con las credenciales ya en producción:

| | |
|---|---|
| Casos disponibles | 413 |
| Rango | 2026-08-11 a 2026-08-19 (el histórico completo) |
| Con coordenadas | 413 de 413 |
| Tipo de colapso | B 372 · A 41 |
| Habitabilidad | no habitable 370 · parcial 37 · habitable 4 · sin dato 2 |
| Comunas | 12 |
| Peso | 1,6 MB en 2,2 s |
| Sin técnico de verificación | 83 |
| Sin operario de ingreso | 51 |

Cabe entero en una llamada. No hace falta paginar.

## Por qué no encaja en lo que ya hay

Ninguna fuente del catálogo actual necesita las tres cosas que esta necesita:

1. **Autenticación.** Basic Auth con credenciales que no pueden estar en el repo.
2. **Parámetros obligatorios calculados al vuelo.** `desde_utc` y `hasta_utc` en
   milisegundos; sin ellos la API responde 400. La URL del catálogo es estática.
3. **Datos anidados a tres niveles.** El mecanismo de recorte actual (`campos`)
   filtra solo claves de primer nivel; aquí lo que interesa vive en
   `evaluacion.victimas.fallecidos` o en `evaluacion.danos[].valorEtiqueta`.

## Decisiones tomadas

**Enfoque: lector propio.** Un tipo `visitados` en el despacho `_LECTORES` de
`externas.py`, igual que ya existe `_de_gdacs` para el Feature suelto de GDACS.

Descartados:

- *Generalizar `Fuente`* con autenticación, parámetros calculables y lista blanca
  con rutas anidadas. Es la solución bonita si llegan más APIs así; hoy es una,
  y la máquina habría que mantenerla durante una emergencia.
- *Copiar a la base con un sincronizador.* Rompe el principio del módulo —las
  externas se consultan en vivo y no se sincronizan— y añade un proceso más que
  vigilar. Quien quiera una foto fija ya tiene el botón de copiar a capa.

Un beneficio del lector propio que pesa más que la elegancia: el aplanado es una
**lista de asignaciones explícitas**. No hay forma de que se filtre un campo que
nadie revisó, porque cada campo se escribe a mano.

**Datos personales: salen todos.** Decisión del equipo, tomada con la advertencia
sobre la mesa. Van el contacto de la persona afectada (nombre, teléfono, cédula),
el técnico de verificación completo (nombre, correo, cédula, teléfono, matrícula
profesional) y el operario de ingreso.

Esto es una **excepción explícita** a la política que el propio módulo documenta
—lista blanca estricta, Ley 1581 de 2012— así que la nota de cabecera de
`fuentes.py` hay que actualizarla para que lo diga. Un módulo cuya documentación
contradice a su código es peor que un módulo sin documentación.

Lo que sí queda fuera es la **conversación** (`mensajes[]`, presente en 207 de los
413 casos): entra como número de mensajes y fecha del último, no como el hilo. Es
texto libre de longitud impredecible que multiplicaría el peso de cada punto y
que la ficha no sabe pintar. Añadirlo entero después es una línea.

**Simbología: tipo de colapso.** Es el criterio que define la capa. Dos
categorías, reutilizando los rojos de las capas Copernicus para que «lo más
grave» sea siempre el mismo color en todo el visor.

**Ventana: todo desde el sismo.** Desde el 2026-08-01 (margen sobre el caso más
antiguo, del día 11) hasta el momento de la llamada.

## Arquitectura

```
config.py            VISITADOS_USUARIO, VISITADOS_CLAVE del entorno
   |
fuentes.py           Fuente(clave="cali-visitados-criticos", tipo="visitados")
   |                 + paleta COLAPSO_CALI
   |
visitados.py  <---- PURO. Sin red, sin base, sin dependencias.
   |                 aplanar(respuesta) -> list[Feature]
   |
externas.py          _de_visitados(): Basic Auth + ventana + llama a aplanar()
```

`visitados.py` aparte y puro es la misma decisión que se tomó con `pila.py`: el
aplanado es donde un error pasa desapercibido —un campo que se queda en `null`
para siempre no rompe nada, solo desaparece— y al no tocar la red se prueba
entero en un segundo.

### Fuente en el catálogo

| | |
|---|---|
| clave | `cali-visitados-criticos` |
| nombre | Visitados críticos · colapso A/B (Cali) |
| organización | Alcaldía de Cali |
| tema | `dano` |
| tipo | `visitados` |
| url | `https://atencionsismo.cali.gov.co/api/operario/reports/visitados-criticos` |
| título de la ficha | `direccion` |
| naturaleza | `dinamica` |
| minutos de caché | 10 |

### Mapa de campos

Un punto por caso. Nombres en minúscula y sin acentos, siguiendo la convención
del repo. Las fechas se convierten de milisegundos UTC a `YYYY-MM-DD HH:MM` en
hora de Colombia (UTC−5), que es lo que la ficha muestra tal cual.

**Ubicación e identificación**

| Propiedad | Origen |
|---|---|
| `id` | `id` |
| `direccion` | `direccion` |
| `barrio` | `barrio` |
| `comuna` | `comunaEtiqueta` |
| `resumen_unidad` | `resumenUnidad` |
| `origen_coordenadas` | de `placeId`, ver abajo |

`placeId` dice de dónde salió la posición, que es lo único que aporta: `arcgis`
(migrado), `verified` (un administrador la certificó), `manual` (un operario la
fijó) o un identificador opaco de Google Places. Se guarda el prefijo cuando lo
hay y la palabra `google` cuando no, en vez del identificador entero, que no le
dice nada a nadie y ocupa 27 caracteres en cada punto.

`estado` y `estadoEtiqueta` de la raíz no se copian: valen siempre `critico` y
`Visitado Crítico` en todos los casos de esta API, así que serían una columna
con el mismo valor repetido 413 veces.

**Evaluación**

| Propiedad | Origen |
|---|---|
| `colapso` | `evaluacion.tipoColapso` (A o B; es el campo de la simbología) |
| `colapso_etiqueta` | `evaluacion.tipoColapsoEtiqueta` |
| `habitabilidad` | `evaluacion.habitabilidadEtiqueta` |
| `concepto_tecnico` | `evaluacion.conceptoTecnico` |
| `visita_especializada` | `evaluacion.aspectosVisitaEspecializada` |
| `alcance_inspeccion` | `evaluacion.alcanceInspeccionEtiqueta` |
| `evaluado` | `evaluacion.creado_utc` → fecha legible |

**Inmueble**

| Propiedad | Origen |
|---|---|
| `tipo_inmueble` | `inmueble.tipoInmuebleEtiqueta` |
| `edificio` | `inmueble.nombreEdificio` |
| `apartamento` | `inmueble.numeroApartamento` |
| `casa` | `inmueble.numeroCasa` |
| `edificio_completo` | `inmueble.edificioCompleto` |
| `pisos_sobre_nivel` | `evaluacion.pisosSobreNivel` |
| `sotanos` | `evaluacion.sotanos` |
| `anio_construccion` | `evaluacion.anioConstruccionEtiqueta` |

**Daños** — las seis claves aparecen en los 413 casos, así que son seis columnas
fijas. Se guarda la etiqueta (`Ninguno`/`Leve`/`Moderado`/`Severo`), que es
directamente legible.

| Propiedad | Clave de origen |
|---|---|
| `dano_muros_fachadas` | `damageWallsFacades` |
| `dano_divisiones` | `damagePartitions` |
| `dano_cielos` | `damageCeilings` |
| `dano_cubierta` | `damageRoof` |
| `dano_escaleras` | `damageStairs` |
| `dano_servicios` | `damagePublicServices` |

Una clave desconocida que aparezca en el futuro no se pierde en silencio: se
añade como `dano_<clave>` con su etiqueta.

**Víctimas** — `fallecidos`, `atrapados`, `rescatados`, `evacuados`,
`por_evacuar`, `necesita_evacuacion`, de `evaluacion.victimas`.

**Ingreso** — `ingreso_descripcion`, `ingreso_colapso` (etiqueta),
`ingreso_estado` (etiqueta), `ingreso_creado` y `ingreso_enviado` (fechas).

**Personas** — por decisión explícita del equipo:

| Propiedad | Origen |
|---|---|
| `contacto_nombre`, `contacto_telefono`, `contacto_cedula` | `contacto` |
| `tecnico_nombre`, `tecnico_correo`, `tecnico_profesion`, `tecnico_cedula`, `tecnico_telefono`, `tecnico_matricula`, `tecnico_enfasis`, `tecnico_anos_experiencia` | `tecnicoVerificacion` |
| `operario_nombre`, `operario_correo` | `operarioIngreso` |
| `verificacion_asignada` | `verificacion_asignada_utc` → fecha legible |

83 casos no traen técnico y 51 no traen operario: los bloques anidados pueden ser
`null` enteros y el aplanado tiene que darlo por normal, no por error.

El contacto aparece tres veces en la respuesta —en la raíz, en `ingreso` y en
`evaluacion`— con el mismo contenido. Se toma **solo el de la raíz**, que es el
efectivo; copiar los tres daría nueve propiedades para tres datos.

**Conversación** — `mensajes_cantidad` y `mensajes_ultimo` (fecha).

### Simbología

```
campo: colapso     modo: categorias     orden: [A, B]
A  #8c0d10   COLAPSO TOTAL
B  #e63946   RIESGO COLAPSO
```

### Ventana de fechas

`desde_utc` fijo en el 2026-08-01 00:00 UTC; `hasta_utc` el instante de la
llamada. La constante vive en `fuentes.py` junto a la fuente, comentada, para que
se entienda de dónde sale el número sin tener que buscarlo.

### Errores

| Situación | Qué ve quien enciende la capa |
|---|---|
| Faltan las credenciales en el entorno | «Falta configurar VISITADOS_USUARIO y VISITADOS_CLAVE en el .env del servidor.» |
| 401 | «La Alcaldía de Cali rechazó las credenciales de Visitados críticos.» |
| 403 | «El correo está habilitado pero sin contraseña creada en el portal de operarios.» |
| 400 | Se trata como respuesta inesperada; solo puede venir de un error nuestro al calcular la ventana. |
| Red caída | El 502 genérico que ya da el módulo. |

La capa aparece en el catálogo aunque falten las credenciales. Esconderla haría
que el problema se descubriera cuando alguien la echa en falta, no cuando se
puede arreglar.

## Pruebas

`backend/tests/test_visitados.py`, con `python -m unittest`, sin red ni base:

- Un caso completo se aplana con todos sus campos.
- Un caso sin `tecnicoVerificacion` ni `operarioIngreso` no rompe y deja esas
  propiedades en `None`.
- Un caso sin coordenadas se marca sin geometría (para que el conteo de «sin
  ubicación» que ya existe lo recoja).
- Las seis claves de daño se mapean a sus seis propiedades.
- Una clave de daño desconocida se conserva en vez de perderse.
- Las fechas en milisegundos salen como fecha legible en hora de Colombia.
- Una fecha nula sale nula, no como 1970.
- La respuesta sin `casos` devuelve lista vacía en vez de reventar.

El fixture es **sintético**, escrito a mano. No se mete en el repo ni un caso
real: llevaría nombres, cédulas y teléfonos de personas al historial de git, de
donde ya no se sacan.

## Riesgos

**Las credenciales caducan o se revocan.** La capa deja de funcionar y el mensaje
lo dirá con claridad. Están solo en el `.env` de la VPS, respaldado antes de
tocarlo, y nunca en git.

**La API cambia de forma.** Es un sistema nuevo montado para esta emergencia. El
aplanado tolera nulos y claves ausentes en todas partes, así que un campo que
desaparezca se traduce en una propiedad vacía, no en una capa caída.

**El volumen crece.** 413 casos en 8 días. El tope de 8000 entidades del módulo
da margen para meses; cuando se acerque, la ventana móvil es el siguiente paso.

**Datos personales en un visor con clave compartida sobre IP pública.** Queda
dicho aquí y en el código. Revertirlo es quitar líneas del aplanado y volver a
desplegar; no hay nada que migrar.
