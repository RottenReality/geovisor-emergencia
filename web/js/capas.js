/* Panel de capas.
 *
 * No hay categorias fijas. Cualquier capa -dibujo, imagen o fuente externa-
 * puede ir a cualquier altura, y el orden lo manda la pila, que es comun a
 * todo el equipo. Antes iban en tres estratos inamovibles, y eso hacia
 * imposible poner una externa entre dos capas propias, que resulto ser justo
 * lo que hacia falta.
 *
 * Agrupar es cosa aparte y la decide el equipo: un grupo puede llevar dentro
 * un dibujo, una ortofoto y un servicio externo a la vez. Se pliega, se mueve
 * en bloque y se apaga de un clic.
 *
 * Este archivo pinta; quien sabe de orden es pila.js.
 */

import { api, avisar, escapar, descargarArchivo, formatearPeso, $ } from './util.js';
import * as pila from './pila.js';
import { sincronizarCapas, aplicarEstilos, encuadrar, refrescarDatos, olvidarRaster,
         zoomQueFalta, fijarFiltroCatastro, inclinar, enderezar, mapa } from './mapa.js';
import * as filtroCatastro from './filtro-catastro.js';
import * as modelo3d from './modelo3d.js';
import * as simbologia from './simbologia.js';
import * as bandas from './bandas.js';
import * as externas from './externas.js';
import * as tabla from './tabla.js';

/** Lista completa, del fondo al frente: primero imagenes, luego dibujo. */
export let items = [];

let expandida = null;
let sondeo = null;

/** Clave de esta capa dentro de la pila. */
const claveDePila = (item) =>
  item.esExterna ? `ext-${item.id}` : `${item.esRaster ? 'raster' : 'capa'}-${item.id}`;

/** Plegado de grupos: es preferencia de vista y se queda en este navegador.
 *  Lo demas -orden, pertenencia, encendido- es del equipo y vive en la base. */
const plegados = new Set(
  JSON.parse(localStorage.getItem('geovisor.grupos-plegados') || '[]'));
const guardarPlegados = () =>
  localStorage.setItem('geovisor.grupos-plegados', JSON.stringify([...plegados]));

/** Antes atenuaba las capas de un grupo apagado. Ya no hay grupos fijos que
 *  apagar: la visibilidad de cada capa es la suya y nada mas. */
const efectivo = (item) => item;

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
  reaplicarFiltrosCatastro();
  simbologia.pintarLeyenda(items.map(efectivo));
  vigilarConversiones();
  // Quien dependa de la lista de capas (el selector de destino al dibujar) se
  // entera por aqui, sin que este modulo tenga que conocerlo.
  document.dispatchEvent(new CustomEvent('capas:cambiadas'));
}

// ---------------------------------------------------------------------------
// Capas que aparecen y desaparecen con el zoom
// ---------------------------------------------------------------------------
// Solo el catastro, por ahora. Al cruzar su zoom minimo la capa empieza o deja
// de dibujarse, y el panel y la leyenda tienen que decirlo: si no, cruzar el
// umbral hacia abajo vacia el mapa sin que nada cambie en la interfaz.
//
// Se repinta al CRUZAR, no en cada gesto de zoom: reconstruir el panel entero
// mientras alguien hace zoom con la rueda son decenas de reconstrucciones por
// segundo, y por debajo del umbral no habria cambiado nada en pantalla.
/** Vuelve a poner el filtro local del catastro. Hace falta tras cada
 *  sincronizacion, porque sincronizarCapas() recrea las capas de MapLibre y
 *  con ellas se va el filtro que tuvieran puesto. */
function reaplicarFiltrosCatastro() {
  for (const item of items) {
    if (item.fuente?.tipo !== 'catastro') continue;
    fijarFiltroCatastro(item.id, filtroCatastro.expresion(item.id));
  }
}

const clavesBajoMinimo = () => items
  .filter((i) => i.visible && zoomQueFalta(i))
  .map((i) => i.id).join(',');

// Lo ultimo que se dibujo. Lo fija pintar(), no solo esta escucha: si solo lo
// llevara la escucha, arrancar ya por debajo del minimo -que es el caso
// normal, el visor abre sobre Colombia entera- no quedaria registrado, y el
// primer cruce hacia arriba se comparia contra el valor inicial, saldria
// igual, y los avisos se quedarian pegados con la capa ya visible.
let bajoMinimo = '';

mapa.on('zoomend', () => {
  if (clavesBajoMinimo() === bajoMinimo) return;
  pintar();
  simbologia.pintarLeyenda(items.map(efectivo));
});

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

  if (!capa.visible) {
    await actualizar(capa, { visible: true });
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
  // Se anota aqui, y no en la escucha del zoom, porque el panel tambien se
  // repinta al encender o apagar una capa: si no, encender una estando lejos
  // dejaria la anotacion sin actualizar.
  bajoMinimo = clavesBajoMinimo();

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
    const cabecera = cabeceraDeGrupo(nodo, porClave);
    if (!cabecera) continue;
    lista.appendChild(cabecera);
    if (expandida === nodo.clave) lista.appendChild(detalleDeGrupo(nodo));
    if (plegados.has(nodo.clave)) continue;

    const cuerpo = document.createElement('div');
    cuerpo.className = 'grupo-cuerpo';
    if (!nodo.hijos.length) {
      cuerpo.innerHTML = '<p class="vacio">Grupo vacío. Añade capas desde sus opciones.</p>';
    } else {
      for (const clave of [...nodo.hijos].reverse()) {
        const item = porClave.get(clave);
        if (item) cuerpo.appendChild(filaDe(item));
      }
    }
    lista.appendChild(cuerpo);
  }
}

const filaDe = (item) => (item.esExterna ? pintarFilaExterna(item) : pintarFila(item));

/** Cabecera de un grupo: plegar, encender todo, color, nombre y orden.
 *
 *  Sustituye a las cabeceras de categoria fijas que habia antes. La diferencia
 *  es que estas las define el equipo, y por eso llevan tambien renombrar,
 *  recolorear y disolver. */
function cabeceraDeGrupo(nodo, porClave) {
  const id = Number(nodo.clave.slice('grupo-'.length));
  const grupo = pila.grupos().find((g) => g.id === id);
  if (!grupo) return null;

  const dentro = nodo.hijos.map((c) => porClave.get(c)).filter(Boolean);
  const encendidas = dentro.filter((i) => i.visible).length;
  const plegado = plegados.has(nodo.clave);
  const abierto = expandida === nodo.clave;

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
    <button class="icono chevron ${abierto ? 'abierto' : ''}" data-grupo="opciones"
            title="${abierto ? 'Cerrar opciones' : 'Nombre, color o deshacer'}"
            aria-expanded="${abierto}" aria-label="Opciones del grupo">&#8943;</button>`;

  cabecera.querySelector('.chevron').onclick = () => {
    if (plegado) plegados.delete(nodo.clave); else plegados.add(nodo.clave);
    guardarPlegados();
    pintar();
  };
  cabecera.querySelector('input').onchange = async (evento) => {
    const visible = evento.target.checked;
    for (const item of dentro) await actualizar(item, { visible }, false);
    pintar();
  };
  cabecera.querySelectorAll('[data-grupo]').forEach((control) => {
    control.onclick = () => manejarGrupo(control.dataset.grupo, grupo, nodo);
  });
  return cabecera;
}

/**
 * Opciones del grupo, desplegadas bajo su cabecera.
 *
 * Antes todo esto era un `prompt` donde habia que escribir el nombre nuevo, o
 * un color en hexadecimal, o la palabra DISOLVER. Nadie se sabe un color de
 * memoria y escribir una palabra clave para deshacer algo es una trampa: se
 * teclea mal y no pasa nada, o se teclea bien por accidente. Aqui cada cosa
 * tiene su control, igual que en la ficha de una capa.
 *
 * Deshacer el grupo NO borra las capas: salen sueltas al nivel de arriba, en
 * el mismo sitio donde estaba el grupo.
 */
function detalleDeGrupo(nodo) {
  const id = Number(nodo.clave.slice('grupo-'.length));
  const grupo = pila.grupos().find((g) => g.id === id);
  if (!grupo) return document.createElement('div');

  const cuantas = nodo.hijos.length;
  const detalle = document.createElement('div');
  detalle.className = 'grupo-detalle';
  detalle.innerHTML = `
    <label>Nombre del grupo</label>
    <input type="text" maxlength="80" value="${escapar(grupo.nombre)}" data-grupo="nombre">
    <label>Color</label>
    <input type="color" value="${escapar(grupo.color)}" data-grupo="color">
    <button data-grupo="disolver" class="peligro">
      Deshacer grupo${cuantas ? ` (deja ${cuantas} capa${cuantas === 1 ? '' : 's'} suelta${cuantas === 1 ? '' : 's'})` : ''}
    </button>
    <button data-grupo="opciones" class="tenue cerrar-detalle">Cerrar opciones</button>`;

  detalle.querySelectorAll('[data-grupo]').forEach((control) => {
    const accion = control.dataset.grupo;
    if (accion === 'nombre') {
      // onchange y no oninput: guardar cada tecla seria una peticion por letra,
      // y repintar el panel a media palabra quita el foco de la casilla.
      control.onchange = () => guardarGrupo(grupo.id, { nombre: control.value.trim() });
    } else if (accion === 'color') {
      control.oninput = () => {
        const punto = detalle.previousElementSibling?.querySelector('.punto-grupo');
        if (punto) punto.style.background = control.value;
      };
      control.onchange = () => guardarGrupo(grupo.id, { color: control.value });
    } else {
      control.onclick = () => manejarGrupo(accion, grupo, nodo);
    }
  });
  return detalle;
}

async function guardarGrupo(id, cambios) {
  if (cambios.nombre === '') { pintar(); return; }
  try {
    await pila.editarGrupo(id, cambios);
    await cargar();
  } catch (error) { avisar(error.message, true); pintar(); }
}

async function manejarGrupo(accion, grupo, nodo) {
  try {
    if (accion === 'subir' || accion === 'bajar') {
      await pila.mover(nodo.clave, accion);
    } else if (accion === 'opciones') {
      expandida = expandida === nodo.clave ? null : nodo.clave;
      pintar();
      return;
    } else if (accion === 'disolver') {
      if (!confirm(`¿Deshacer el grupo "${grupo.nombre}"? `
                   + 'Las capas no se borran: quedan sueltas en el panel.')) return;
      expandida = null;
      const salida = await pila.disolverGrupo(grupo.id);
      avisar(`Grupo deshecho. ${salida.sueltas} capa(s) quedaron sueltas.`);
    }
    await cargar();
  } catch (error) { avisar(error.message, true); }
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

/** Selector para meter o sacar la capa de un grupo. Es la unica via: las
 *  flechas mueven solo entre hermanas y nunca cruzan la frontera de un grupo,
 *  para que subir una capa no la saque del sitio donde alguien la puso. */
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

/**
 * Deslizador del tamano de los puntos, hermano del de opacidad.
 *
 * Solo aparece si la capa tiene puntos: en una de manzanas o de vias no pinta
 * nada y solo ocuparia sitio. Lo dice el servidor para las capas propias
 * (`tiene_puntos`) y el GeoJSON ya descargado para las externas.
 */
function bloqueTamano(item) {
  const conPuntos = item.esExterna ? item.tienePuntos : !item.esRaster && item.tiene_puntos;
  if (!conPuntos) return '';
  const valor = Math.round((item.radio ?? 1) * 100);
  return `
    <label>Tamaño de los puntos <output data-salida="radio">${valor}%</output></label>
    <input type="range" min="40" max="300" step="10" value="${valor}" data-accion="radio">`;
}

const COLOR_GRUPO = '#8d99ae';

/** "Grupo 1", "Grupo 2"... sin repetir ninguno de los que ya hay. */
function nombreLibreDeGrupo() {
  const usados = new Set(pila.grupos().map((g) => g.nombre));
  let n = pila.grupos().length + 1;
  while (usados.has(`Grupo ${n}`)) n += 1;
  return `Grupo ${n}`;
}

/**
 * Mete o saca la capa de un grupo.
 *
 * "+ Nuevo grupo" no pregunta nada: crea el grupo con un nombre libre y abre
 * sus opciones ya desplegadas, que es donde se le pone el nombre de verdad y
 * el color. Preguntar el nombre antes de que el grupo exista obliga a decidir
 * a ciegas y no deja ver el resultado.
 */
async function moverAGrupo(item, valor) {
  try {
    let destino = valor === '' ? null : valor;
    if (destino === 'nuevo') {
      const grupo = await pila.crearGrupo(nombreLibreDeGrupo(), COLOR_GRUPO);
      destino = grupo.id;
      expandida = `grupo-${grupo.id}`;
    }
    await pila.agrupar(claveDePila(item), destino === null ? null : Number(destino));
    await cargar();
  } catch (error) { avisar(error.message, true); pintar(); }
}

function pintarFila(item) {
  const clave = `${item.esRaster ? 'r' : 'c'}${item.id}`;
  const clave2 = claveDePila(item);
  const estado = ESTADOS[item.estado];
  const fila = document.createElement('div');
  fila.className = 'capa-fila' + (expandida === clave ? ' abierta' : '');

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
        ${item.esRaster ? '<span class="estado tipo">img</span>' : ''}
        <button class="icono" data-accion="subir" ${pila.enElBorde(clave2, 'subir') ? 'disabled' : ''}
                title="Traer al frente" aria-label="Traer al frente">&uarr;</button>
        <button class="icono" data-accion="bajar" ${pila.enElBorde(clave2, 'bajar') ? 'disabled' : ''}
                title="Enviar atrás" aria-label="Enviar atrás">&darr;</button>
        <button class="icono chevron ${abierta ? 'abierto' : ''}" data-accion="expandir"
                title="${abierta ? 'Cerrar opciones' : 'Abrir opciones'}"
                aria-expanded="${abierta}" aria-label="Opciones">&#9662;</button>
      </div>
      <div class="capa-detalle">
        ${item.estado === 'error' ? `<p class="error-texto">${escapar(item.mensaje || 'Falló la conversión')}</p>` : ''}
        <label>Opacidad <output data-salida="opacidad">${Math.round((item.opacidad ?? 1) * 100)}%</output></label>
        <input type="range" min="0" max="100" value="${Math.round((item.opacidad ?? 1) * 100)}"
               data-accion="opacidad">
        ${bloqueTamano(item)}
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
        <label style="margin-top:8px">Nombre</label>
        <input type="text" maxlength="120" value="${escapar(item.nombre)}" data-accion="nombre">
        ${selectorDeGrupo(item)}
        <div class="fila" style="margin-top:8px">
          <button data-accion="encuadrar">Ir a la capa</button>
          ${item.esRaster ? '' : `
            <button data-accion="tabla" ${item.total ? '' : 'disabled'}
                    title="${item.total ? 'Ver los atributos como tabla'
                                        : 'Esta capa no tiene elementos'}">
              Tabla de atributos
            </button>`}
        </div>
        ${bloqueDescarga(item)}
        <button data-accion="borrar" class="peligro">Eliminar capa</button>
        <button data-accion="expandir" class="tenue cerrar-detalle">Cerrar opciones</button>
      </div>`;

  fila.querySelectorAll('[data-accion]').forEach((control) => {
    const accion = control.dataset.accion;
    if (accion === 'grupo') {
      control.onchange = (e) => moverAGrupo(item, e.target.value);
    } else if (accion === 'opacidad') {
      control.oninput = (e) => {
        const valor = Number(e.target.value) / 100;
        item.opacidad = valor;
        fila.querySelector('[data-salida="opacidad"]').textContent = `${e.target.value}%`;
        aplicarEstilos([efectivo(item)]);
      };
      control.onchange = (e) => actualizar(item, { opacidad: Number(e.target.value) / 100 }, false);
    } else if (accion === 'radio') {
      control.oninput = (e) => {
        item.radio = Number(e.target.value) / 100;
        fila.querySelector('[data-salida="radio"]').textContent = `${e.target.value}%`;
        aplicarEstilos([efectivo(item)]);
      };
      control.onchange = (e) => actualizar(item, { radio: Number(e.target.value) / 100 }, false);
    } else if (accion === 'nombre') {
      // onchange: guardar por cada tecla seria una peticion por letra, y
      // repintar a media palabra dejaria la casilla sin foco.
      control.onchange = () => {
        const nombre = control.value.trim();
        if (nombre) actualizar(item, { nombre }); else pintar();
      };
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
/**
 * Que pone el distintivo de una fila del panel.
 *
 * Hasta ahora todas las capas de este panel eran servicios de fuera y ponia
 * «ext». Un modelo 3D es un archivo del propio servidor y se mira de otra
 * manera -inclinando la camara-, asi que se distingue de un vistazo. El
 * distintivo REEMPLAZA al de zoom cuando hace falta ese: son dos etiquetas
 * para el mismo hueco, y ponerlas juntas estruja el nombre de la capa.
 */
const distintivoDe = (item) => (item.fuente?.tipo === 'modelo3d' ? '3D' : 'ext');

const pistaDeTipo = (item) => (item.fuente?.tipo === 'modelo3d'
  ? 'Modelo 3D de un vuelo de dron, servido desde este servidor. Se mira inclinando la cámara: arrastra con el botón derecho.'
  : 'Fuente externa.');

function pintarFilaExterna(item) {
  const clave = `x${item.id}`;
  const clave2 = claveDePila(item);
  const fila = document.createElement('div');
  fila.className = 'capa-fila externa' + (expandida === clave ? ' abierta' : '');
  const abierta = expandida === clave;
  fila.classList.toggle('encendida', !!item.visible);

  const entradas = simbologia.leyendaDe(item);
  const conteo = item.esImagen ? 'imagen'
    : item.total != null ? item.total.toLocaleString('es-CO') : '…';
  // Encendida pero sin dibujar por falta de zoom. Sin decirlo, la fila se ve
  // exactamente igual que una capa que si esta pintada.
  const falta = item.visible ? zoomQueFalta(item) : null;
  // Si alguien esta viendo solo una parte de la capa tiene que saberlo sin
  // abrirla. Creer que faltan datos es el error caro en una emergencia.
  const acotada = filtroCatastro.cuantosFiltros(item.id);

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
        ${falta ? `
          <span class="estado sin-zoom" title="${escapar(pistaDeTipo(item))} Se dibuja desde el zoom ${falta}: acércate, o abre las opciones y pulsa «Ir a la capa».">z${falta}+</span>`
          : `<span class="estado tipo ${item.fuente?.tipo === 'modelo3d' ? 'tridi' : ''}"
                   title="${escapar(pistaDeTipo(item))}">${distintivoDe(item)}</span>`}
        ${acotada ? `
          <button class="estado filtro" data-accion="quitar-filtro"
                  title="Estás viendo solo una parte de esta capa (${acotada} filtro${
                    acotada === 1 ? '' : 's'}). Pulsa para quitarlo.">filtrada</button>` : ''}
        <span class="conteo">${escapar(conteo)}</span>
        <button class="icono" data-accion="subir" ${pila.enElBorde(clave2, 'subir') ? 'disabled' : ''}
                title="Traer al frente" aria-label="Traer al frente">&uarr;</button>
        <button class="icono" data-accion="bajar" ${pila.enElBorde(clave2, 'bajar') ? 'disabled' : ''}
                title="Enviar atrás" aria-label="Enviar atrás">&darr;</button>
        <button class="icono chevron ${abierta ? 'abierto' : ''}" data-accion="expandir"
                title="${abierta ? 'Cerrar opciones' : 'Abrir opciones'}"
                aria-expanded="${abierta}" aria-label="Opciones">&#9662;</button>
      </div>
      <div class="capa-detalle">
        <p class="nota"><strong>${escapar(item.fuente.organizacion)}</strong>${
          item.fuente.nota ? ` · ${escapar(item.fuente.nota)}` : ''}</p>
        ${falta ? `
          <p class="nota aviso-tema">
            Encendida, pero no se dibuja a este zoom: son cientos de miles de polígonos y a
            escala de ciudad serían una mancha. Pulsa «Ir a la capa» para saltar al zoom ${falta}.
          </p>` : ''}
        ${item.sinUbicacion ? `
          <p class="nota aviso-tema">
            ${item.sinUbicacion.toLocaleString('es-CO')} registros de esta fuente no traen
            coordenadas y no están en el mapa.
          </p>` : ''}
        <label>Opacidad <output data-salida="opacidad">${Math.round((item.opacidad ?? 1) * 100)}%</output></label>
        <input type="range" min="0" max="100" value="${Math.round((item.opacidad ?? 1) * 100)}"
               data-accion="opacidad">
        ${bloqueTamano(item)}
        ${item.fuente.tipo === 'modelo3d' ? `
          <label class="casilla" style="margin-top:10px">
            <input type="checkbox" data-accion="relieve"
                   ${modelo3d.hayRelieve() ? 'checked' : ''}>
            Relieve del terreno alrededor
          </label>
          <p class="nota" style="margin-top:0">
            El vuelo se corta en seco y el cerro queda como una isla recortada. Esto
            continúa la ladera más allá del borde con datos públicos de elevación.
            Se apaga solo cuando quitas el modelo, y cuesta descarga.
          </p>` : ''}
        ${entradas.length ? `
          <div class="leyenda-mini">
            ${entradas.map((f) => `
              <span class="par-leyenda" title="${escapar(f.etiqueta)}">
                <span class="muestra" style="background:${escapar(f.color)}"></span>
                ${escapar(f.etiqueta)}
              </span>`).join('')}
          </div>` : ''}
        <div class="fcat"></div>
        ${selectorDeGrupo(item)}
        <div class="fila" style="margin-top:8px">
          <button data-accion="encuadrar">Ir a la capa</button>
          ${item.fuente.tipo === 'modelo3d' ? `
            <button data-accion="enderezar"
                    title="Devuelve la cámara a la vertical, mirando al norte. También lo hace la brújula de arriba a la derecha.">
              Vista desde arriba
            </button>` : ''}
          ${item.fuente.url ? `
            <a class="boton-enlace" href="${escapar(item.fuente.url)}"
               target="_blank" rel="noopener">Ver el servicio</a>` : ''}
        </div>
        ${item.esImagen || item.fuente.tipo === 'modelo3d' ? '' : `
          <button data-accion="tabla" style="width:100%;margin-top:8px">
            Tabla de atributos
          </button>`}
        ${item.fuente.formulario ? `
          <a class="boton-enlace" style="margin-top:8px"
             href="${escapar(item.fuente.formulario)}" target="_blank" rel="noopener"
             title="Abre el formulario de captura en una pestaña nueva">
            &#10010; Llenar el formulario
          </a>` : ''}
        ${item.esImagen || ['catastro', 'modelo3d'].includes(item.fuente.tipo) ? '' : `
          <button data-accion="copiar" style="width:100%;margin-top:8px">
            Guardar copia fechada como capa
          </button>`}
        <button data-accion="quitar" class="tenue" style="margin-top:8px">Quitar del panel</button>
        <button data-accion="expandir" class="tenue cerrar-detalle">Cerrar opciones</button>
      </div>`;

  fila.querySelectorAll('[data-accion]').forEach((control) => {
    const accion = control.dataset.accion;
    if (accion === 'grupo') {
      control.onchange = (e) => moverAGrupo(item, e.target.value);
    } else if (accion === 'opacidad') {
      control.oninput = (e) => {
        item.opacidad = Number(e.target.value) / 100;
        fila.querySelector('[data-salida="opacidad"]').textContent = `${e.target.value}%`;
        aplicarEstilos([efectivo(item)]);
      };
      control.onchange = (e) => externas
        .fijar(item.id, { opacidad: Number(e.target.value) / 100 })
        .catch((error) => avisar(error.message, true));
    } else if (accion === 'radio') {
      control.oninput = (e) => {
        item.radio = Number(e.target.value) / 100;
        fila.querySelector('[data-salida="radio"]').textContent = `${e.target.value}%`;
        aplicarEstilos([efectivo(item)]);
      };
      control.onchange = (e) => externas
        .fijar(item.id, { radio: Number(e.target.value) / 100 })
        .catch((error) => avisar(error.message, true));
    } else if (accion === 'relieve') {
      // Es preferencia de quien mira y no estado de la capa: no se publica al
      // equipo, se guarda en este navegador como el filtro del catastro.
      control.onchange = (e) => modelo3d.fijarRelieve(e.target.checked);
    } else {
      control.onclick = () => manejarExterna(accion, item, clave);
    }
  });

  // El filtro se pinta aparte porque necesita preguntarle al servidor que
  // valores toma cada campo, y eso es asincrono. Solo cuando la fila esta
  // abierta: cada campo cuesta una consulta que recorre la capa entera.
  const hueco = fila.querySelector('.fcat');
  if (hueco && abierta && item.fuente?.tipo === 'catastro') {
    filtroCatastro.pintar(hueco, item, () => {
      fijarFiltroCatastro(item.id, filtroCatastro.expresion(item.id));
      // Repintar para que el distintivo "filtrada" cuadre con lo que se ve.
      pintar();
    }).catch((error) => avisar(error.message, true));
  }

  return fila;
}

async function manejarExterna(accion, item, clave) {
  switch (accion) {
    case 'ver':
      item.visible = !item.visible;
      externas.fijar(item.id, { visible: item.visible })
        .catch((error) => avisar(error.message, true));
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
      await pila.mover(claveDePila(item), accion);
      await cargar();
      break;

    case 'enderezar':
      enderezar();
      return;
    case 'encuadrar':
      await irAExterna(item);
      break;

    case 'quitar-filtro':
      filtroCatastro.limpiar(item.id);
      fijarFiltroCatastro(item.id, null);
      pintar();
      break;

    case 'copiar':
      await externas.copiar(item);
      break;

    case 'tabla':
      tabla.abrir(item);
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
  // El catastro y los modelos traen su extension del catalogo, pero encuadrar
  // la entera deja el mapa por debajo del zoom al que la capa se dibuja.
  const conMinimo = ['catastro', 'modelo3d'].includes(item.fuente?.tipo);
  // Un modelo se pide desde zoom_min, pero a ese zoom todavia se ve su nivel
  // mas basto. Se aterriza mas cerca, donde ya hay textura que mirar.
  const minimo = !conMinimo ? null
    : item.fuente.modelo?.zoom_llegada ?? item.fuente.zoom_min ?? 15;
  if (item.bounds) {
    encuadrar(item.bounds, minimo);
    // Un modelo mirado desde arriba parece una ortofoto mala. Se llega ya
    // inclinado para que se vea que es lo que es.
    if (item.fuente?.tipo === 'modelo3d') inclinar();
    return;
  }
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

    case 'tabla':
      tabla.abrir(item);
      break;

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
      await pila.mover(claveDePila(item), accion);
      await cargar();
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

async function actualizar(item, cambios, recargar = true) {
  Object.assign(item, cambios);
  aplicarEstilos([efectivo(item)]);
  if ('visible' in cambios) simbologia.pintarLeyenda(items.map(efectivo));
  try {
    // Una externa guarda su estado en otro sitio. Importa porque la casilla
    // de un grupo llama aqui para todo lo que tenga dentro, y un grupo puede
    // mezclar dibujo, imagen y fuente externa.
    if (item.esExterna) {
      await externas.fijar(item.id, cambios);
    } else {
      await api(`/api/${item.esRaster ? 'rasters' : 'capas'}/${item.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cambios),
      });
    }
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
