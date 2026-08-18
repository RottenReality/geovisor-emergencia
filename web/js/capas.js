/* Panel de capas, en tres grupos: imagenes debajo, fuentes externas en medio,
 * dibujo encima.
 *
 * Los vectores propios van SIEMPRE por encima de las imagenes, porque se
 * dibuja sobre la ortofoto y nunca al reves. Fijarlo asi no quita libertad:
 * elimina la pregunta de si tal raster va antes o despues de tal capa de
 * puntos, y deja el reordenamiento donde de verdad importa, que es dentro de
 * cada grupo.
 *
 * Las fuentes externas quedan en medio y el grupo solo aparece cuando hay
 * alguna encendida: el catalogo son treinta y dos servicios y el panel no es
 * sitio para un indice.
 */

import { api, avisar, escapar, descargarArchivo, formatearPeso, $ } from './util.js';
import { sincronizarCapas, aplicarEstilos, encuadrar, refrescarDatos, olvidarRaster } from './mapa.js';
import * as simbologia from './simbologia.js';
import * as bandas from './bandas.js';
import * as externas from './externas.js';

/** Lista completa, del fondo al frente: primero imagenes, luego dibujo. */
export let items = [];

let expandida = null;
let sondeo = null;

const GRUPOS = [
  { clave: 'raster',  titulo: 'Imágenes', vacio: 'Sin imágenes cargadas.' },
  // Sin texto de vacio: cuando no hay ninguna encendida el grupo no se pinta.
  { clave: 'externa', titulo: 'Fuentes externas', vacio: '' },
  { clave: 'vector',  titulo: 'Dibujo',   vacio: 'Sin capas de dibujo.' },
];

const grupoDe = (item) =>
  (item.esExterna ? 'externa' : item.esRaster ? 'raster' : 'vector');

/** Grupos apagados enteros. Es una vista local, no se guarda en el servidor. */
const gruposOcultos = new Set();

const plegados = new Set(
  JSON.parse(localStorage.getItem('geovisor.plegados') || '[]'));
const guardarPlegados = () =>
  localStorage.setItem('geovisor.plegados', JSON.stringify([...plegados]));

/** Visibilidad real: la de la capa, apagada si su grupo esta apagado. */
const efectivo = (item) => ({
  ...item,
  visible: item.visible && !gruposOcultos.has(grupoDe(item)),
});

export async function cargar() {
  const [capas, rasters] = await Promise.all([
    api('/api/capas').catch(() => []),
    api('/api/rasters').catch(() => []),
  ]);

  const porOrden = (a, b) => (a.orden ?? 0) - (b.orden ?? 0);
  items = [
    ...rasters.map((r) => ({ ...r, esRaster: true })).sort(porOrden),
    ...externas.items(),
    ...capas.map((c) => ({ ...c, esRaster: false })).sort(porOrden),
  ];

  pintar();
  sincronizarCapas(
    items.filter((i) => i.esExterna || !i.esRaster || i.estado === 'listo').map(efectivo));
  simbologia.reaplicarFiltros(items);
  simbologia.pintarLeyenda(items.map(efectivo));
  vigilarConversiones();
  // Quien dependa de la lista de capas (el selector de destino al dibujar) se
  // entera por aqui, sin que este modulo tenga que conocerlo.
  document.dispatchEvent(new CustomEvent('capas:cambiadas'));
}

/** Devuelve el mapa a la visibilidad real de las capas.
 *  Lo usa la comparacion al cerrarse, tras haber ocultado el resto. */
export const reaplicarEstilos = () => {
  aplicarEstilos(items.map(efectivo));
  simbologia.pintarLeyenda(items.map(efectivo));
};

/**
 * Se asegura de que una capa vectorial este encendida, y la enciende si no.
 *
 * Dibujar sobre una capa apagada guarda el elemento pero no lo muestra, y eso
 * se lee como "no funciona". Encenderla al empezar a dibujar elimina el
 * malentendido de raiz.
 *
 * @returns {Promise<string|null>} nombre de la capa si hubo que encenderla
 */
export async function asegurarVisible(capaId) {
  const capa = items.find((i) => !i.esRaster && i.id === capaId);
  if (!capa) return null;

  const grupoApagado = gruposOcultos.has('vector');
  if (grupoApagado) gruposOcultos.delete('vector');

  if (!capa.visible) {
    await actualizar(capa, { visible: true });
    pintar();
    return capa.nombre;
  }
  if (grupoApagado) {
    aplicarEstilos(items.map(efectivo));
    pintar();
    return capa.nombre;
  }
  return null;
}

/** Mientras haya un raster convirtiendose, refrescar hasta que termine. */
function vigilarConversiones() {
  const enProceso = items.some((i) => i.esRaster && ['pendiente', 'procesando'].includes(i.estado));
  clearInterval(sondeo);
  if (enProceso) sondeo = setInterval(cargar, 5000);
}

const ESTADOS = {
  pendiente:  ['En cola', 'espera'],
  procesando: ['Convirtiendo a COG…', 'espera'],
  error:      ['Error', 'malo'],
};

function pintar() {
  const lista = $('lista-capas');
  lista.innerHTML = '';

  if (!items.length) {
    lista.innerHTML = '<p class="vacio">Aún no hay capas. Crea una o carga un archivo.</p>';
    return;
  }

  // Los grupos se pintan de arriba abajo igual que se ven en el mapa: el
  // dibujo encima de las imagenes.
  for (const grupo of [...GRUPOS].reverse()) {
    const delGrupo = items.filter((i) => grupoDe(i) === grupo.clave);
    // Un grupo sin texto de vacio desaparece cuando no tiene nada: es el caso
    // de las fuentes externas, que la mayor parte del tiempo no estorban.
    if (!delGrupo.length && !grupo.vacio) continue;
    const plegado = plegados.has(grupo.clave);
    const apagado = gruposOcultos.has(grupo.clave);
    const encendidas = apagado ? 0 : delGrupo.filter((i) => i.visible).length;

    const cabecera = document.createElement('div');
    cabecera.className = 'grupo-cabecera' + (plegado ? ' plegado' : '');
    cabecera.innerHTML = `
      <button class="chevron" aria-expanded="${!plegado}"
              aria-label="${plegado ? 'Desplegar' : 'Plegar'} ${grupo.titulo}">&#9662;</button>
      <input type="checkbox" ${apagado ? '' : 'checked'}
             aria-label="Mostrar todo el grupo ${grupo.titulo}">
      <span class="titulo">${grupo.titulo}</span>
      <span class="conteo ${encendidas ? 'vivo' : ''}">${encendidas}/${delGrupo.length}</span>`;

    cabecera.querySelector('.chevron').onclick = () => {
      if (plegado) plegados.delete(grupo.clave); else plegados.add(grupo.clave);
      guardarPlegados();
      pintar();
    };
    cabecera.querySelector('input').onchange = (evento) => {
      if (evento.target.checked) gruposOcultos.delete(grupo.clave);
      else gruposOcultos.add(grupo.clave);
      aplicarEstilos(items.map(efectivo));
      simbologia.pintarLeyenda(items.map(efectivo));
      pintar();
    };
    lista.appendChild(cabecera);

    if (plegado) continue;

    const cuerpo = document.createElement('div');
    cuerpo.className = 'grupo-cuerpo';
    if (!delGrupo.length) {
      cuerpo.innerHTML = `<p class="vacio">${grupo.vacio}</p>`;
    } else {
      // Dentro del grupo tambien se pinta de frente a fondo: arriba en la
      // lista = encima en el mapa, como en QGIS o ArcGIS.
      [...delGrupo].reverse().forEach((item, indice, arreglo) =>
        cuerpo.appendChild(item.esExterna
          ? pintarFilaExterna(item, indice, arreglo.length, apagado)
          : pintarFila(item, indice, arreglo.length, apagado)));
    }
    lista.appendChild(cuerpo);
  }
}

/** Cuadrito de color de la fila. Con simbologia tematica se parte en tantas
 *  franjas como clases quepan: asi la lista dice de un vistazo que capa esta
 *  clasificada y con que colores, sin tener que abrirla. */
function muestraDeColor(item, entradas) {
  if (item.esRaster || item.esImagen) {
    return '<span class="punto-color" style="background:transparent;border:1px solid var(--papel-2)"></span>';
  }
  if (!entradas.length) {
    return `<span class="punto-color" style="background:${escapar(item.color)}"></span>`;
  }
  const franjas = entradas.slice(0, 4).map((f) => escapar(f.color));
  const paso = 100 / franjas.length;
  const tramos = franjas.map((c, i) => `${c} ${i * paso}% ${(i + 1) * paso}%`).join(', ');
  return `<span class="punto-color tematica" style="background:linear-gradient(180deg, ${tramos})"></span>`;
}

/**
 * Botones para bajar ESTA capa, dentro de sus propias opciones.
 *
 * Antes lo unico que habia era "exportar todo el dibujo" en el panel lateral,
 * que obliga a entregar once capas cuando piden una. Aqui la descarga esta
 * donde ya se esta mirando la capa.
 *
 * El vector sale en las dos proyecciones porque la eleccion no es de gusto:
 * 9377 es lo que exige un informe oficial (metros, medidas de PostGIS) y 4326
 * lo que lee cualquier herramienta web. El raster sale tal cual: el COG ya
 * convertido, que abre en QGIS sin ningun paso previo.
 */
function bloqueDescarga(item) {
  if (item.esRaster) {
    const listo = item.estado === 'listo';
    const peso = formatearPeso(item.mb);
    return `
      <button data-accion="descargar-raster" style="width:100%;margin-top:8px"
              ${listo ? '' : 'disabled'}
              title="${listo ? 'Bajar el GeoTIFF (COG) de esta imagen'
                             : 'Estará disponible cuando termine de convertirse'}">
        &#10515; Descargar GeoTIFF${peso ? ` (${peso})` : ''}
      </button>`;
  }
  const vacia = !item.total;
  return `
    <label style="margin-top:8px">Descargar esta capa</label>
    <div class="fila">
      <button data-accion="descargar-9377" ${vacia ? 'disabled' : ''}
              title="${vacia ? 'Esta capa no tiene elementos'
                             : 'GeoJSON en EPSG:9377, con las medidas en metros. Para informe oficial.'}">
        &#10515; Oficial 9377
      </button>
      <button data-accion="descargar-4326" ${vacia ? 'disabled' : ''}
              title="${vacia ? 'Esta capa no tiene elementos'
                             : 'GeoJSON en EPSG:4326 (WGS84). Para herramientas web.'}">
        &#10515; WGS84
      </button>
    </div>`;
}

function pintarFila(item, indice, total, grupoApagado) {
  const clave = `${item.esRaster ? 'r' : 'c'}${item.id}`;
  const estado = ESTADOS[item.estado];
  const fila = document.createElement('div');
  fila.className = 'capa-fila' + (expandida === clave ? ' abierta' : '')
                               + (grupoApagado ? ' atenuada' : '');

  const abierta = expandida === clave;
  fila.classList.toggle('encendida', !!item.visible);

  const filtrada = !item.esRaster && simbologia.tieneFiltro(item);
  const entradas = item.esRaster ? [] : simbologia.leyendaDe(item);

  fila.innerHTML = `
      <div class="capa-cabecera">
        <button class="ojo ${item.visible ? 'activo' : ''}" data-accion="ver"
                title="${item.visible ? 'Ocultar' : 'Mostrar'} esta capa"
                aria-pressed="${!!item.visible}"
                aria-label="${item.visible ? 'Ocultar' : 'Mostrar'} ${escapar(item.nombre)}">
          ${item.visible ? '&#9673;' : '&#9678;'}
        </button>
        ${muestraDeColor(item, entradas)}
        <button class="nombre" data-accion="expandir" title="${escapar(item.nombre)} — opciones">
          ${escapar(item.nombre)}
        </button>
        ${filtrada ? `<button class="estado filtro" data-accion="quitar-filtro"
                title="Estás viendo solo una parte de esta capa. Clic para ver todo.">filtro</button>` : ''}
        ${estado ? `<span class="estado ${estado[1]}">${estado[0]}</span>`
          : item.esRaster && item.tiene_visible === false
            ? `<span class="estado aviso" title="Sin bandas visibles: solo borde rojo, infrarrojo y SWIR.">sin color real</span>`
            : item.esRaster && item.papeles?.origen === 'supuesto'
              ? `<button class="estado aviso" data-accion="bandas"
                  title="El archivo no dice qué banda es cuál: orden supuesto.">bandas?</button>`
              : `<span class="conteo">${item.esRaster ? 'ráster' : item.total}</span>`}
        <button class="icono" data-accion="subir"    ${indice === 0 ? 'disabled' : ''}
                title="Traer al frente" aria-label="Traer al frente">&uarr;</button>
        <button class="icono" data-accion="bajar"    ${indice === total - 1 ? 'disabled' : ''}
                title="Enviar atrás" aria-label="Enviar atrás">&darr;</button>
        <button class="icono chevron ${abierta ? 'abierto' : ''}" data-accion="expandir"
                title="${abierta ? 'Cerrar opciones' : 'Abrir opciones'}"
                aria-expanded="${abierta}" aria-label="Opciones">&#9662;</button>
      </div>
      <div class="capa-detalle">
        ${item.estado === 'error' ? `<p class="error-texto">${escapar(item.mensaje || 'Falló la conversión')}</p>` : ''}
        <label>Opacidad <output>${Math.round((item.opacidad ?? 1) * 100)}%</output></label>
        <input type="range" min="0" max="100" value="${Math.round((item.opacidad ?? 1) * 100)}"
               data-accion="opacidad">
        ${item.esRaster ? (item.num_bandas > 1 ? `
          <label>Combinación de bandas (${item.num_bandas} bandas)</label>
          <select data-accion="combinacion">
            <option value="natural" ${item.combinacion === 'natural' ? 'selected' : ''}>
              ${item.tiene_visible ? 'Color natural' : 'SWIR / infrarrojo (única posible)'}</option>
            ${item.admite_infrarrojo ? `<option value="infrarrojo" ${item.combinacion === 'infrarrojo' ? 'selected' : ''}>Falso color (infrarrojo)</option>` : ''}
            ${item.admite_swir ? `<option value="swir" ${item.combinacion === 'swir' ? 'selected' : ''}>SWIR (suelo y humedad)</option>` : ''}
            <option value="gris" ${item.combinacion === 'gris' ? 'selected' : ''}>Una banda en gris</option>
          </select>
          <button data-accion="bandas" style="width:100%;margin-top:8px">
            Ajustar bandas y contraste…
          </button>
          ` : '') : `
          <label>Color${entradas.length ? ' de base' : ''}</label>
          <input type="color" value="${escapar(item.color)}" data-accion="color">
          <button data-accion="simbologia" style="width:100%;margin-top:8px">
            ${entradas.length ? `Colores y filtro · ${escapar(item.estilo.campo)}`
                              : 'Colores y filtro por atributo…'}
          </button>
          ${entradas.length ? `
            <div class="leyenda-mini">
              ${entradas.slice(0, 8).map((f) => `
                <span class="par-leyenda" title="${escapar(f.etiqueta)}">
                  <span class="muestra" style="background:${escapar(f.color)}"></span>
                  ${escapar(f.etiqueta)}
                </span>`).join('')}
              ${entradas.length > 8 ? `<span class="par-leyenda">y ${entradas.length - 8} más</span>` : ''}
            </div>` : ''}`}
        <div class="fila" style="margin-top:8px">
          <button data-accion="encuadrar">Ir a la capa</button>
          <button data-accion="renombrar">Renombrar</button>
        </div>
        ${bloqueDescarga(item)}
        <button data-accion="borrar" class="peligro">Eliminar capa</button>
        <button data-accion="expandir" class="tenue cerrar-detalle">Cerrar opciones</button>
      </div>`;

  fila.querySelectorAll('[data-accion]').forEach((control) => {
    const accion = control.dataset.accion;
    if (accion === 'opacidad') {
      control.oninput = (e) => {
        const valor = Number(e.target.value) / 100;
        item.opacidad = valor;
        fila.querySelector('output').textContent = `${e.target.value}%`;
        aplicarEstilos([efectivo(item)]);
      };
      control.onchange = (e) => actualizar(item, { opacidad: Number(e.target.value) / 100 }, false);
    } else if (accion === 'color') {
      // El color ya no viaja dentro de la tesela sino que se aplica en el
      // estilo, asi que se puede ver el cambio mientras se arrastra el
      // selector, sin pedir nada al servidor.
      control.oninput = (e) => {
        item.color = e.target.value;
        aplicarEstilos([efectivo(item)]);
        const muestra = fila.querySelector('.punto-color');
        if (muestra && !muestra.classList.contains('tematica')) {
          muestra.style.background = e.target.value;
        }
      };
      control.onchange = (e) => actualizar(item, { color: e.target.value }, false);
    } else if (accion === 'combinacion') {
      control.onchange = async (e) => {
        await actualizar(item, { combinacion: e.target.value }, false);
        // La URL de las teselas lleva la combinacion: hay que rehacer la fuente.
        olvidarRaster(item.id);
        await cargar();
        avisar(`Vista cambiada a ${e.target.selectedOptions[0].textContent.toLowerCase()}.`);
      };
    } else {
      control.onclick = () => manejar(accion, item, clave);
    }
  });

  return fila;
}

/**
 * Fila de una fuente externa.
 *
 * Se parece a la de una capa propia pero no es la misma: no hay color a mano
 * (lo trae el catalogo), no hay renombrar ni eliminar -no es nuestro dato-, y
 * en su lugar aparece lo unico que si es una decision del equipo: congelar una
 * copia fechada.
 */
function pintarFilaExterna(item, indice, total, grupoApagado) {
  const clave = `x${item.id}`;
  const fila = document.createElement('div');
  fila.className = 'capa-fila externa' + (expandida === clave ? ' abierta' : '')
                                       + (grupoApagado ? ' atenuada' : '');
  const abierta = expandida === clave;
  fila.classList.toggle('encendida', !!item.visible);

  const entradas = simbologia.leyendaDe(item);
  const conteo = item.esImagen ? 'imagen'
    : item.total != null ? item.total.toLocaleString('es-CO') : '…';

  fila.innerHTML = `
      <div class="capa-cabecera">
        <button class="ojo ${item.visible ? 'activo' : ''}" data-accion="ver"
                title="${item.visible ? 'Ocultar' : 'Mostrar'} esta capa"
                aria-pressed="${!!item.visible}"
                aria-label="${item.visible ? 'Ocultar' : 'Mostrar'} ${escapar(item.nombre)}">
          ${item.visible ? '&#9673;' : '&#9678;'}
        </button>
        ${muestraDeColor(item, entradas)}
        <button class="nombre" data-accion="expandir"
                title="${escapar(item.fuente.organizacion)} — opciones">
          ${escapar(item.nombre)}
        </button>
        <span class="conteo">${escapar(conteo)}</span>
        <button class="icono" data-accion="subir" ${indice === 0 ? 'disabled' : ''}
                title="Traer al frente" aria-label="Traer al frente">&uarr;</button>
        <button class="icono" data-accion="bajar" ${indice === total - 1 ? 'disabled' : ''}
                title="Enviar atrás" aria-label="Enviar atrás">&darr;</button>
        <button class="icono chevron ${abierta ? 'abierto' : ''}" data-accion="expandir"
                title="${abierta ? 'Cerrar opciones' : 'Abrir opciones'}"
                aria-expanded="${abierta}" aria-label="Opciones">&#9662;</button>
      </div>
      <div class="capa-detalle">
        <p class="nota"><strong>${escapar(item.fuente.organizacion)}</strong>${
          item.fuente.nota ? ` · ${escapar(item.fuente.nota)}` : ''}</p>
        ${item.sinUbicacion ? `
          <p class="nota aviso-tema">
            ${item.sinUbicacion.toLocaleString('es-CO')} registros de esta fuente no traen
            coordenadas y no están en el mapa.
          </p>` : ''}
        <label>Opacidad <output>${Math.round((item.opacidad ?? 1) * 100)}%</output></label>
        <input type="range" min="0" max="100" value="${Math.round((item.opacidad ?? 1) * 100)}"
               data-accion="opacidad">
        ${entradas.length ? `
          <div class="leyenda-mini">
            ${entradas.map((f) => `
              <span class="par-leyenda" title="${escapar(f.etiqueta)}">
                <span class="muestra" style="background:${escapar(f.color)}"></span>
                ${escapar(f.etiqueta)}
              </span>`).join('')}
          </div>` : ''}
        <div class="fila" style="margin-top:8px">
          <button data-accion="encuadrar">Ir a la capa</button>
          <a class="boton-enlace" href="${escapar(item.fuente.url)}"
             target="_blank" rel="noopener">Ver el servicio</a>
        </div>
        ${item.fuente.formulario ? `
          <a class="boton-enlace" style="margin-top:8px"
             href="${escapar(item.fuente.formulario)}" target="_blank" rel="noopener"
             title="Abre el formulario de captura en una pestaña nueva">
            &#10010; Llenar el formulario
          </a>` : ''}
        ${item.esImagen ? '' : `
          <button data-accion="copiar" style="width:100%;margin-top:8px">
            Guardar copia fechada como capa
          </button>`}
        <button data-accion="quitar" class="tenue" style="margin-top:8px">Quitar del panel</button>
        <button data-accion="expandir" class="tenue cerrar-detalle">Cerrar opciones</button>
      </div>`;

  fila.querySelectorAll('[data-accion]').forEach((control) => {
    const accion = control.dataset.accion;
    if (accion === 'opacidad') {
      control.oninput = (e) => {
        item.opacidad = Number(e.target.value) / 100;
        fila.querySelector('output').textContent = `${e.target.value}%`;
        aplicarEstilos([efectivo(item)]);
      };
      control.onchange = (e) => externas.fijar(item.id, { opacidad: Number(e.target.value) / 100 });
    } else {
      control.onclick = () => manejarExterna(accion, item, clave);
    }
  });

  return fila;
}

async function manejarExterna(accion, item, clave) {
  switch (accion) {
    case 'ver':
      item.visible = !item.visible;
      externas.fijar(item.id, { visible: item.visible });
      aplicarEstilos([efectivo(item)]);
      simbologia.pintarLeyenda(items.map(efectivo));
      pintar();
      break;

    case 'expandir':
      expandida = expandida === clave ? null : clave;
      pintar();
      break;

    case 'subir':
    case 'bajar':
      await externas.mover(item.id, accion === 'subir' ? 1 : -1);
      break;

    case 'encuadrar':
      await irAExterna(item);
      break;

    case 'copiar':
      await externas.copiar(item);
      break;

    case 'quitar':
      expandida = null;
      await externas.apagar(item.id);
      avisar(`"${item.nombre}" quitada del panel.`);
      break;
  }
}

/** Encuadra una fuente externa.
 *
 *  Las ortoimagenes ya traen su extension del catalogo. Los vectores no, asi
 *  que se calcula del propio GeoJSON: el navegador acaba de descargarlo para
 *  pintarlo, de modo que sale de su cache y no cuesta una peticion nueva. */
async function irAExterna(item) {
  if (item.bounds) { encuadrar(item.bounds); return; }
  try {
    const datos = await api(`/api/externas/${item.id}.geojson`);
    let x1 = 180, y1 = 90, x2 = -180, y2 = -90;
    const mirar = (coordenadas) => {
      if (typeof coordenadas[0] === 'number') {
        x1 = Math.min(x1, coordenadas[0]); x2 = Math.max(x2, coordenadas[0]);
        y1 = Math.min(y1, coordenadas[1]); y2 = Math.max(y2, coordenadas[1]);
        return;
      }
      coordenadas.forEach(mirar);
    };
    for (const elemento of datos.features) {
      if (elemento.geometry?.coordinates) mirar(elemento.geometry.coordinates);
    }
    if (x1 <= x2) encuadrar([x1, y1, x2, y2]);
    else avisar('Esa fuente no devolvió elementos con posición.');
  } catch (error) { avisar(error.message, true); }
}

async function manejar(accion, item, clave) {
  switch (accion) {
    case 'ver':
      await actualizar(item, { visible: !item.visible });
      pintar();
      break;

    case 'expandir':
      expandida = expandida === clave ? null : clave;
      pintar();
      break;

    case 'simbologia':
      // El panel toca item.estilo en vivo; al cambiar algo hay que repintar la
      // fila (la muestra de color, el aviso de filtro) y la leyenda del mapa.
      simbologia.abrir(item, () => {
        aplicarEstilos([efectivo(item)]);
        simbologia.pintarLeyenda(items.map(efectivo));
        pintar();
      });
      break;

    case 'bandas':
      // Cambiar la asignacion cambia la URL de las teselas: hay que rehacer la
      // fuente y devolver el item ya refrescado, porque cargar() crea objetos
      // nuevos y el que tiene el panel abierto queda obsoleto.
      bandas.abrir(item, async () => {
        olvidarRaster(item.id);
        await cargar();
        return items.find((i) => i.esRaster && i.id === item.id);
      });
      break;

    case 'quitar-filtro':
      simbologia.limpiarFiltro(item.id);
      simbologia.reaplicarFiltros(items);
      simbologia.pintarLeyenda(items.map(efectivo));
      pintar();
      avisar(`Se muestran otra vez todos los elementos de "${item.nombre}".`);
      break;

    case 'encuadrar':
      if (item.esRaster) encuadrar(item.bounds);
      else if (item.extension) encuadrar(item.extension);
      else avisar('Esa capa aún no tiene elementos.');
      break;

    case 'renombrar': {
      const nombre = prompt('Nuevo nombre de la capa:', item.nombre);
      if (nombre && nombre.trim()) await actualizar(item, { nombre: nombre.trim() });
      break;
    }

    case 'borrar': {
      const cuantos = item.esRaster ? '' : ` y sus ${item.total} elemento(s)`;
      if (!confirm(`¿Eliminar "${item.nombre}"${cuantos}? No se puede deshacer.`)) return;
      try {
        await api(`/api/${item.esRaster ? 'rasters' : 'capas'}/${item.id}`, { method: 'DELETE' });
        avisar(`Capa "${item.nombre}" eliminada.`);
        expandida = null;
        await cargar();
        refrescarDatos();
      } catch (error) { avisar(error.message, true); }
      break;
    }

    case 'descargar-9377':
    case 'descargar-4326':
      await descargarCapa(item, accion.endsWith('9377') ? 9377 : 4326);
      break;

    case 'descargar-raster':
      await descargarRaster(item);
      break;

    case 'subir':
    case 'bajar':
      await intercambiar(item, accion === 'subir' ? 1 : -1);
      break;
  }
}

/**
 * Baja UNA capa vectorial como GeoJSON.
 *
 * Va por fetch y no por enlace directo para que un fallo del servidor llegue
 * al aviso de siempre, en vez de guardarse en el disco como un .geojson que
 * en realidad contiene {"detail": "..."} -y que solo se descubre al abrirlo
 * en QGIS, que es el peor momento posible. Se puede permitir porque una capa
 * de dibujo cabe de sobra en memoria; el raster no, y por eso va aparte.
 */
async function descargarCapa(item, srid) {
  try {
    const respuesta = await fetch(`/api/export/geojson?srid=${srid}&capa_id=${item.id}`);
    if (respuesta.status === 401) { location.href = '/login.html'; return; }
    if (!respuesta.ok) {
      const cuerpo = await respuesta.json().catch(() => ({}));
      throw new Error(cuerpo.detail || `Error ${respuesta.status}`);
    }
    // El servidor ya nombro el archivo (capa, proyeccion y fecha); se respeta.
    const cabecera = respuesta.headers.get('Content-Disposition') || '';
    const nombre = /filename="([^"]+)"/.exec(cabecera)?.[1] || `${item.id}.geojson`;

    const url = URL.createObjectURL(await respuesta.blob());
    descargarArchivo(url, `"${item.nombre}" descargada en ${
      srid === 9377 ? 'EPSG:9377 oficial' : 'WGS84'}.`, nombre);
    // Liberar el blob de inmediato puede cortar la escritura en algunos
    // navegadores; un minuto es de sobra y no deja el objeto colgado.
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (error) { avisar(error.message, true); }
}

/**
 * Baja el COG de un raster.
 *
 * Por enlace directo: una escena de Skysat ronda 1,8 GB y meterla en un blob
 * antes de guardarla se lleva por delante la pestana. El precio es que el
 * enlace se salta el manejo de errores de api(), asi que primero se comprueba
 * que la sesion siga viva -son 72 horas y en campo caducan-, porque si no el
 * navegador guardaria tan tranquilo la respuesta 401 como si fuera la imagen.
 */
async function descargarRaster(item) {
  try {
    await api('/api/session');
  } catch { return; }   // api() ya redirigio al login
  const peso = formatearPeso(item.mb);
  descargarArchivo(`/api/rasters/${item.id}/descargar`,
    `Descargando "${item.nombre}"${peso ? ` (${peso})` : ''}. Puede tardar un rato.`);
}

/** Intercambia el orden con la capa vecina DENTRO de su grupo.
 *  Solo dos peticiones, no toda la lista. */
async function intercambiar(item, direccion) {
  const hermanas = items.filter((i) => grupoDe(i) === grupoDe(item));
  const posicion = hermanas.findIndex((i) => i.id === item.id);
  const vecina = hermanas[posicion + direccion];
  if (!vecina) return;   // ya esta en el borde de su grupo

  const ordenItem = item.orden ?? posicion + 1;
  const ordenVecina = vecina.orden ?? posicion + 1 + direccion;

  try {
    await Promise.all([
      api(`/api/${item.esRaster ? 'rasters' : 'capas'}/${item.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orden: ordenVecina }),
      }),
      api(`/api/${vecina.esRaster ? 'rasters' : 'capas'}/${vecina.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orden: ordenItem }),
      }),
    ]);
    await cargar();
  } catch (error) { avisar(error.message, true); }
}

async function actualizar(item, cambios, recargar = true) {
  Object.assign(item, cambios);
  aplicarEstilos([efectivo(item)]);
  if ('visible' in cambios) simbologia.pintarLeyenda(items.map(efectivo));
  try {
    await api(`/api/${item.esRaster ? 'rasters' : 'capas'}/${item.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cambios),
    });
    // El color ya no obliga a recargar: se aplica en el estilo del mapa, no
    // viene dentro de la tesela.
    if (recargar && 'nombre' in cambios) await cargar();
  } catch (error) { avisar(error.message, true); }
}

export async function crearCapa(nombre, color) {
  const capa = await api('/api/capas', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nombre, color }),
  });
  await cargar();
  return capa;
}

/** Capas vectoriales, para los selectores de destino al dibujar o cargar. */
export const capasVectoriales = () => items.filter((i) => !i.esRaster);
