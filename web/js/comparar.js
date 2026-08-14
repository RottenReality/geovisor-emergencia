/* Comparacion de dos capas: cortinilla o fundido.
 *
 * Para un equipo de teledetencion este es el gesto central del analisis:
 * poner el antes y el despues sobre el mismo sitio y mover el divisor. Sin
 * esto, comparar significa prender y apagar capas a mano y confiar en la
 * memoria visual.
 *
 * La cortinilla usa un segundo mapa superpuesto y recortado por CSS, que es
 * la forma estandar de hacerlo en MapLibre. El detalle que lo abarata: ese
 * segundo mapa NO lleva mapa base, solo la capa comparada, de modo que las
 * teselas de fondo no se descargan dos veces.
 */

import { avisar, escapar, $ } from './util.js';
import { mapa, aplicarEstilos } from './mapa.js';
import { items, reaplicarEstilos } from './capas.js';

let activa = false;
let modo = 'cortinilla';         // cortinilla | fundido
let izquierda = null;            // item de capa
let derecha = null;
let mapaB = null;
let posicion = 0.5;              // fraccion del ancho, 0..1
let arrastrando = false;

const idDe = (item) => `${item.esRaster ? 'r' : 'c'}${item.id}`;
const buscar = (clave) => items.find((i) => idDe(i) === clave) || null;

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------
export function abrirPanel() {
  const comparables = items.filter((i) => !i.esRaster || i.estado === 'listo');
  if (comparables.length < 2) {
    avisar('Hacen falta al menos dos capas para comparar.', true);
    return;
  }

  const opciones = (seleccion) => comparables.map((i) =>
    `<option value="${idDe(i)}" ${idDe(i) === seleccion ? 'selected' : ''}>
       ${escapar(i.nombre)}</option>`).join('');

  // Por defecto, las dos primeras imagenes: es el caso habitual (antes/despues).
  const imagenes = comparables.filter((i) => i.esRaster);
  const porDefecto = imagenes.length >= 2 ? imagenes : comparables;

  $('comparar-cuerpo').innerHTML = `
    <div class="campo">
      <label for="cmp-izq">Izquierda</label>
      <select id="cmp-izq">${opciones(idDe(porDefecto[0]))}</select>
    </div>
    <div class="campo">
      <label for="cmp-der">Derecha</label>
      <select id="cmp-der">${opciones(idDe(porDefecto[1]))}</select>
    </div>
    <div class="campo">
      <label>Modo</label>
      <div class="fila">
        <button id="cmp-cortinilla" aria-pressed="${modo === 'cortinilla'}">Cortinilla</button>
        <button id="cmp-fundido"    aria-pressed="${modo === 'fundido'}">Fundido</button>
      </div>
    </div>
    <div class="fila">
      <button id="cmp-activar" class="principal">Comparar</button>
      <button id="cmp-cerrar">Cancelar</button>
    </div>`;

  $('cmp-cortinilla').onclick = () => { modo = 'cortinilla'; abrirPanel(); };
  $('cmp-fundido').onclick = () => { modo = 'fundido'; abrirPanel(); };
  $('cmp-cerrar').onclick = () => $('telon-comparar').classList.remove('visible');
  $('cmp-activar').onclick = () => {
    const a = buscar($('cmp-izq').value);
    const b = buscar($('cmp-der').value);
    if (!a || !b) return;
    if (a === b) { avisar('Elige dos capas distintas.', true); return; }
    $('telon-comparar').classList.remove('visible');
    activar(a, b);
  };

  $('telon-comparar').classList.add('visible');
}

// ---------------------------------------------------------------------------
// Activar y desactivar
// ---------------------------------------------------------------------------
export function activar(a, b) {
  desactivar({ silencioso: true });
  izquierda = a;
  derecha = b;
  activa = true;

  soloVisibles(modo === 'fundido' ? [a, b] : [a]);

  if (modo === 'cortinilla') montarSegundoMapa(b);
  else aplicarFundido(0.5);

  $('barra-comparar').hidden = false;
  $('cmp-nombre-izq').textContent = a.nombre;
  $('cmp-nombre-der').textContent = b.nombre;
  $('barra-comparar').classList.toggle('fundido', modo === 'fundido');
  if (modo === 'cortinilla') {
    posicion = 0.5;
    colocarDivisor();
    $('divisor').hidden = false;
  }
  avisar(modo === 'cortinilla'
    ? 'Arrastra el divisor para comparar.'
    : 'Mueve el deslizador para fundir una capa sobre la otra.');
}

export function desactivar({ silencioso = false } = {}) {
  if (!activa && !mapaB) return;
  activa = false;

  if (mapaB) { mapaB.remove(); mapaB = null; }
  $('mapa-b').innerHTML = '';
  $('mapa-b').hidden = true;
  $('divisor').hidden = true;
  $('barra-comparar').hidden = true;

  mapa.off('move', sincronizarVista);
  // Devolver a cada capa su visibilidad real.
  reaplicarEstilos();
  izquierda = derecha = null;
  if (!silencioso) avisar('Comparación cerrada.');
}

export const estaActiva = () => activa;

/** Deja visibles solo las capas comparadas, sin tocar su estado guardado.
 *  Si una estaba apagada, se enciende: elegirla para comparar es pedir verla. */
function soloVisibles(permitidas) {
  const claves = new Set(permitidas.map(idDe));
  aplicarEstilos(items.map((i) => ({ ...i, visible: claves.has(idDe(i)) })));
}

// ---------------------------------------------------------------------------
// Cortinilla
// ---------------------------------------------------------------------------
function montarSegundoMapa(item) {
  const contenedor = $('mapa-b');
  contenedor.hidden = false;

  // Sin mapa base ni controles: solo la capa comparada. Asi el fondo no se
  // descarga dos veces y el segundo mapa pesa lo minimo.
  mapaB = new maplibregl.Map({
    container: 'mapa-b',
    style: { version: 8, sources: {}, layers: [] },
    center: mapa.getCenter(),
    zoom: mapa.getZoom(),
    bearing: mapa.getBearing(),
    pitch: mapa.getPitch(),
    attributionControl: false,
    interactive: false,          // se maneja desde el mapa de abajo
  });

  mapaB.on('load', () => anadirCapa(mapaB, item));
  mapa.on('move', sincronizarVista);
  sincronizarVista();
}

function sincronizarVista() {
  if (!mapaB) return;
  mapaB.jumpTo({
    center: mapa.getCenter(),
    zoom: mapa.getZoom(),
    bearing: mapa.getBearing(),
    pitch: mapa.getPitch(),
  });
}

/** Replica una capa del visor dentro del segundo mapa. */
function anadirCapa(destino, item) {
  if (item.esRaster) {
    destino.addSource('cmp', {
      type: 'raster',
      tiles: [`${location.origin}/api/rasters/${item.id}/tiles/{z}/{x}/{y}.png` +
              `?c=${item.combinacion || 'natural'}`],
      tileSize: 256,
      bounds: item.bounds || undefined,
    });
    destino.addLayer({ id: 'cmp', type: 'raster', source: 'cmp' });
    return;
  }

  destino.addSource('cmp', {
    type: 'vector',
    tiles: [`${location.origin}/api/tiles/{z}/{x}/{y}.pbf`],
    minzoom: 0,
    maxzoom: 22,
  });
  const soloCapa = ['==', ['get', 'capa_id'], item.id];
  const esPoligono = ['match', ['geometry-type'], ['Polygon', 'MultiPolygon'], true, false];
  const esLinea = ['match', ['geometry-type'], ['LineString', 'MultiLineString'], true, false];
  const esPunto = ['match', ['geometry-type'], ['Point', 'MultiPoint'], true, false];

  destino.addLayer({
    id: 'cmp-relleno', type: 'fill', source: 'cmp', 'source-layer': 'elementos',
    filter: ['all', soloCapa, esPoligono],
    paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.32 },
  });
  destino.addLayer({
    id: 'cmp-borde', type: 'line', source: 'cmp', 'source-layer': 'elementos',
    filter: ['all', soloCapa, ['any', esPoligono, esLinea]],
    paint: { 'line-color': ['get', 'color'], 'line-width': 2 },
  });
  destino.addLayer({
    id: 'cmp-punto', type: 'circle', source: 'cmp', 'source-layer': 'elementos',
    filter: ['all', soloCapa, esPunto],
    paint: {
      'circle-color': ['get', 'color'], 'circle-radius': 6,
      'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1.6,
    },
  });
}

function colocarDivisor() {
  const ancho = $('mapa').clientWidth;
  const x = Math.round(posicion * ancho);
  $('divisor').style.left = `${x}px`;
  // El mapa de arriba solo se ve a la derecha del divisor.
  $('mapa-b').style.clipPath = `inset(0 0 0 ${x}px)`;
}

// ---------------------------------------------------------------------------
// Fundido
// ---------------------------------------------------------------------------
function aplicarFundido(mezcla) {
  if (!derecha) return;
  aplicarEstilos([
    { ...izquierda, visible: true, opacidad: 1 },
    { ...derecha, visible: true, opacidad: mezcla },
  ]);
}

// ---------------------------------------------------------------------------
// Interaccion
// ---------------------------------------------------------------------------
export function inicializar() {
  $('comparar').onclick = abrirPanel;
  $('cmp-salir').onclick = () => desactivar();

  $('cmp-mezcla').oninput = (evento) => {
    const valor = Number(evento.target.value) / 100;
    $('cmp-mezcla-valor').textContent = `${evento.target.value}%`;
    aplicarFundido(valor);
  };

  const divisor = $('divisor');
  const empezar = (evento) => { arrastrando = true; evento.preventDefault(); };
  const mover = (evento) => {
    if (!arrastrando) return;
    const x = (evento.touches ? evento.touches[0].clientX : evento.clientX);
    const caja = $('mapa').getBoundingClientRect();
    posicion = Math.min(1, Math.max(0, (x - caja.left) / caja.width));
    colocarDivisor();
  };
  const soltar = () => { arrastrando = false; };

  divisor.addEventListener('mousedown', empezar);
  divisor.addEventListener('touchstart', empezar, { passive: false });
  window.addEventListener('mousemove', mover);
  window.addEventListener('touchmove', mover, { passive: false });
  window.addEventListener('mouseup', soltar);
  window.addEventListener('touchend', soltar);

  // Si cambia el tamano de la ventana, el divisor debe seguir donde estaba.
  window.addEventListener('resize', () => { if (activa && mapaB) colocarDivisor(); });
}
