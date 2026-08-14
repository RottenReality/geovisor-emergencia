/* Mapa, mapas base, capas dinamicas y coordenadas del cursor. */

import { a9377 } from './proyeccion.js';
import { $, numero } from './util.js';
import { COLOMBIA } from './ciudades.js';

// Teselas de 256 px sin @2x: pesan la mitad, y en campo el ancho de banda
// importa mas que la nitidez.
const carto = (estilo) => ['a', 'b', 'c'].map(
  (s) => `https://${s}.basemaps.cartocdn.com/${estilo}/{z}/{x}/{y}.png`);

const BASES = {
  claro:    { fuente: 'base-claro',    etiqueta: 'Claro' },
  oscuro:   { fuente: 'base-oscuro',   etiqueta: 'Oscuro' },
  satelite: { fuente: 'base-satelite', etiqueta: 'Satélite' },
};

const estilo = {
  version: 8,
  sources: {
    claro:  { type: 'raster', tiles: carto('light_all'), tileSize: 256,
              attribution: '© OpenStreetMap · © CARTO' },
    oscuro: { type: 'raster', tiles: carto('dark_all'), tileSize: 256,
              attribution: '© OpenStreetMap · © CARTO' },
    satelite: { type: 'raster', tileSize: 256,
      tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
      attribution: 'Esri · Maxar · Earthstar Geographics' },
  },
  layers: [
    { id: 'fondo', type: 'background', paint: { 'background-color': '#0e1319' } },
    { id: 'base-claro', type: 'raster', source: 'claro' },
    { id: 'base-oscuro', type: 'raster', source: 'oscuro', layout: { visibility: 'none' } },
    { id: 'base-satelite', type: 'raster', source: 'satelite', layout: { visibility: 'none' } },
  ],
};

export const mapa = new maplibregl.Map({
  container: 'mapa',
  style: estilo,
  center: [COLOMBIA.lon, COLOMBIA.lat],
  zoom: COLOMBIA.zoom,
  attributionControl: { compact: true },
  // El equipo puede estar en portatiles modestos: sin inclinacion ni rotacion
  // se ahorra trabajo de GPU y se evitan gestos accidentales en campo.
  pitchWithRotate: false,
  dragRotate: false,
});

mapa.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
mapa.addControl(new maplibregl.ScaleControl({ maxWidth: 130, unit: 'metric' }), 'bottom-right');
mapa.addControl(new maplibregl.GeolocateControl({
  positionOptions: { enableHighAccuracy: true },
  trackUserLocation: true,
  showUserLocation: true,
}), 'top-right');

export const ES_POLIGONO = ['match', ['geometry-type'], ['Polygon', 'MultiPolygon'], true, false];
export const ES_LINEA = ['match', ['geometry-type'], ['LineString', 'MultiLineString'], true, false];
export const ES_PUNTO = ['match', ['geometry-type'], ['Point', 'MultiPoint'], true, false];

export const coleccionVacia = () => ({ type: 'FeatureCollection', features: [] });

/** Capas de datos actualmente montadas, para poder reordenar sin recrearlas. */
let montadas = [];

// ---------------------------------------------------------------------------
// Color tematico y filtro por atributo
// ---------------------------------------------------------------------------

/**
 * Color con el que se pinta una capa vectorial.
 *
 * Se calcula aqui y no en la tesela a proposito. Si el color viajara dentro
 * del MVT, cambiarlo obligaria a volver a descargar todas las teselas, y hasta
 * que eso ocurriera el mapa seguiria mostrando el color anterior. Calculandolo
 * en el estilo, recolorear es instantaneo y no cuesta ni un byte de red.
 *
 * Con simbologia tematica devuelve una expresion que lee `valor`, el unico
 * atributo que el servidor mete en la tesela para esta capa.
 */
export function expresionColor(item) {
  const base = item.color || '#e63946';
  const estilo = item.estilo;
  if (!estilo || !estilo.campo) return base;

  if (estilo.modo === 'categorias') {
    const pares = Object.entries(estilo.colores || {});
    if (!pares.length) return base;
    // 'has' descarta los elementos sin ese atributo: sin el, `to-string` los
    // convertiria en cadena vacia y se pintarian todos como una categoria mas.
    return ['case', ['has', 'valor'],
      ['match', ['to-string', ['get', 'valor']],
        ...pares.flatMap(([valor, color]) => [valor, color]), base],
      base];
  }

  if (estilo.modo === 'rangos') {
    const cortes = estilo.cortes || [];
    const colores = estilo.colores || [];
    if (cortes.length < 2 || colores.length !== cortes.length - 1) return base;
    const paso = ['step', ['to-number', ['get', 'valor'], 0], colores[0]];
    for (let i = 1; i < colores.length; i++) paso.push(cortes[i], colores[i]);
    return ['case', ['has', 'valor'], paso, base];
  }

  return base;
}

/** Filtros por atributo, por capa. Locales al navegador: ver simbologia.js. */
const filtros = new Map();

const PARTES = [
  ['-relleno', ES_POLIGONO],
  ['-borde', ['any', ES_POLIGONO, ES_LINEA]],
  ['-punto', ES_PUNTO],
];

const filtroDe = (capaId, tipo) => {
  const base = ['all', ['==', ['get', 'capa_id'], capaId], tipo];
  const extra = filtros.get(capaId);
  return extra ? [...base, extra] : base;
};

/** Aplica (o quita, con expresion nula) el filtro por atributo de una capa. */
export function fijarFiltro(capaId, expresion) {
  if (expresion) filtros.set(capaId, expresion);
  else filtros.delete(capaId);

  const clave = `capa-${capaId}`;
  for (const [sufijo, tipo] of PARTES) {
    if (mapa.getLayer(clave + sufijo)) mapa.setFilter(clave + sufijo, filtroDe(capaId, tipo));
  }
}

export function inicializarFuentes() {
  mapa.addSource('datos', {
    type: 'vector',
    tiles: [`${location.origin}/api/tiles/{z}/{x}/{y}.pbf`],
    minzoom: 0,
    maxzoom: 22,
  });

  mapa.addSource('dibujo', { type: 'geojson', data: coleccionVacia() });

  // Resaltado del elemento seleccionado. Se filtra por id en vez de usar
  // feature-state porque asi funciona igual con teselas recien recargadas.
  const sinSeleccion = ['==', ['get', 'id'], -1];
  mapa.addLayer({
    id: 'seleccion-relleno', type: 'fill', source: 'datos', 'source-layer': 'elementos',
    filter: sinSeleccion,
    paint: { 'fill-color': '#ffd166', 'fill-opacity': 0.35 },
  });
  mapa.addLayer({
    id: 'seleccion-borde', type: 'line', source: 'datos', 'source-layer': 'elementos',
    filter: sinSeleccion,
    paint: { 'line-color': '#ffd166', 'line-width': 3.5, 'line-blur': 0.4 },
  });
  mapa.addLayer({
    id: 'seleccion-punto', type: 'circle', source: 'datos', 'source-layer': 'elementos',
    filter: sinSeleccion,
    paint: {
      'circle-color': 'rgba(0,0,0,0)',
      'circle-radius': 12,
      'circle-stroke-color': '#ffd166',
      'circle-stroke-width': 3,
    },
  });

  mapa.addLayer({
    id: 'dibujo-relleno', type: 'fill', source: 'dibujo', filter: ES_POLIGONO,
    paint: { 'fill-color': '#ff4d3d', 'fill-opacity': 0.2 },
  });
  mapa.addLayer({
    id: 'dibujo-linea', type: 'line', source: 'dibujo',
    filter: ['any', ES_LINEA, ES_POLIGONO],
    paint: { 'line-color': '#ff4d3d', 'line-width': 2.5, 'line-dasharray': [2, 1.4] },
  });
  mapa.addLayer({
    id: 'dibujo-vertice', type: 'circle', source: 'dibujo', filter: ES_PUNTO,
    paint: {
      'circle-color': '#ff4d3d', 'circle-radius': 5,
      'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2,
    },
  });
}

const ENCIMA = ['seleccion-relleno', 'seleccion-borde', 'seleccion-punto',
                'dibujo-relleno', 'dibujo-linea', 'dibujo-vertice'];

/**
 * Sincroniza las capas de MapLibre con las capas del servidor.
 *
 * No destruye y recrea todo: anade lo que falta, quita lo que sobra y reordena
 * el resto con moveLayer. Recrear las fuentes obligaria al navegador a volver
 * a descargar cada tesela y cada raster en cada cambio de orden, que en campo
 * es exactamente lo que no se puede permitir.
 *
 * @param {Array} items lista mixta de capas vectoriales y rasters, de fondo a frente
 */
export function sincronizarCapas(items) {
  const deseadas = items.map((i) => (i.esRaster ? `raster-${i.id}` : `capa-${i.id}`));

  // Quitar lo que ya no existe.
  for (const clave of montadas) {
    if (deseadas.includes(clave)) continue;
    for (const sufijo of ['', '-relleno', '-borde', '-punto']) {
      const id = clave + sufijo;
      if (mapa.getLayer(id)) mapa.removeLayer(id);
    }
    if (clave.startsWith('raster-') && mapa.getSource(clave)) mapa.removeSource(clave);
  }

  // Anadir lo que falta.
  for (const item of items) {
    const clave = item.esRaster ? `raster-${item.id}` : `capa-${item.id}`;
    if (montadas.includes(clave) && mapa.getLayer(item.esRaster ? clave : `${clave}-relleno`)) continue;

    if (item.esRaster) {
      if (!mapa.getSource(clave)) {
        mapa.addSource(clave, {
          type: 'raster',
          // 'r' es la huella del plan de pintado que calcula el servidor:
          // cualquier cambio en como se pinta el raster cambia la URL y el
          // navegador deja de servir lo que tenia guardado.
          tiles: [`${location.origin}/api/rasters/${item.id}/tiles/{z}/{x}/{y}.png` +
                  `?c=${item.combinacion || 'natural'}&r=${item.render || 0}`],
          tileSize: 256,
          bounds: item.bounds || undefined,
        });
      }
      mapa.addLayer({ id: clave, type: 'raster', source: clave, paint: { 'raster-opacity': 1 } });
    } else {
      const color = expresionColor(item);
      mapa.addLayer({
        id: `${clave}-relleno`, type: 'fill', source: 'datos', 'source-layer': 'elementos',
        filter: filtroDe(item.id, ES_POLIGONO),
        paint: { 'fill-color': color, 'fill-opacity': 0.32 },
      });
      mapa.addLayer({
        id: `${clave}-borde`, type: 'line', source: 'datos', 'source-layer': 'elementos',
        filter: filtroDe(item.id, ['any', ES_POLIGONO, ES_LINEA]),
        paint: {
          'line-color': color,
          'line-width': ['case', ES_LINEA, 3.5, 2],
        },
      });
      mapa.addLayer({
        id: `${clave}-punto`, type: 'circle', source: 'datos', 'source-layer': 'elementos',
        filter: filtroDe(item.id, ES_PUNTO),
        paint: {
          'circle-color': color,
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, 4, 12, 7, 18, 10],
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 1.6,
        },
      });
    }
  }

  // Reordenar: mover cada una al tope en orden ascendente deja la ultima
  // (la de mayor orden) al frente.
  for (const item of items) {
    const clave = item.esRaster ? `raster-${item.id}` : `capa-${item.id}`;
    for (const sufijo of item.esRaster ? [''] : ['-relleno', '-borde', '-punto']) {
      if (mapa.getLayer(clave + sufijo)) mapa.moveLayer(clave + sufijo);
    }
  }
  // El resaltado y el dibujo siempre por encima de los datos.
  for (const id of ENCIMA) if (mapa.getLayer(id)) mapa.moveLayer(id);

  montadas = deseadas;
  aplicarEstilos(items);
}

/** Visibilidad, opacidad y color, sin tocar el orden. */
export function aplicarEstilos(items) {
  for (const item of items) {
    const clave = item.esRaster ? `raster-${item.id}` : `capa-${item.id}`;
    const visible = item.visible ? 'visible' : 'none';
    const opacidad = item.opacidad ?? 1;

    if (item.esRaster) {
      if (!mapa.getLayer(clave)) continue;
      mapa.setLayoutProperty(clave, 'visibility', visible);
      mapa.setPaintProperty(clave, 'raster-opacity', opacidad);
      continue;
    }
    for (const sufijo of ['-relleno', '-borde', '-punto']) {
      const id = clave + sufijo;
      if (!mapa.getLayer(id)) continue;
      mapa.setLayoutProperty(id, 'visibility', visible);
    }

    const color = expresionColor(item);
    if (mapa.getLayer(`${clave}-relleno`)) {
      mapa.setPaintProperty(`${clave}-relleno`, 'fill-color', color);
      mapa.setPaintProperty(`${clave}-relleno`, 'fill-opacity', 0.32 * opacidad);
    }
    if (mapa.getLayer(`${clave}-borde`)) {
      mapa.setPaintProperty(`${clave}-borde`, 'line-color', color);
      mapa.setPaintProperty(`${clave}-borde`, 'line-opacity', opacidad);
    }
    if (mapa.getLayer(`${clave}-punto`)) {
      mapa.setPaintProperty(`${clave}-punto`, 'circle-color', color);
      mapa.setPaintProperty(`${clave}-punto`, 'circle-opacity', opacidad);
    }
  }
}

/** Ids de las capas MapLibre que responden a clics de seleccion. */
export function capasConsultables() {
  return montadas
    .filter((c) => c.startsWith('capa-'))
    .flatMap((c) => ['-relleno', '-borde', '-punto'].map((s) => c + s))
    .filter((id) => mapa.getLayer(id));
}

/** Descarta un raster del mapa para que la proxima sincronizacion lo recree.
 *  Necesario al cambiar la combinacion de bandas, porque la URL de las
 *  teselas cambia y hay que rehacer la fuente. */
export function olvidarRaster(id) {
  const clave = `raster-${id}`;
  if (mapa.getLayer(clave)) mapa.removeLayer(clave);
  if (mapa.getSource(clave)) mapa.removeSource(clave);
}

export function resaltar(id) {
  const filtro = ['==', ['get', 'id'], id ?? -1];
  for (const capa of ['seleccion-relleno', 'seleccion-borde', 'seleccion-punto']) {
    if (mapa.getLayer(capa)) mapa.setFilter(capa, filtro);
  }
}

export function refrescarDatos() {
  const fuente = mapa.getSource('datos');
  // Cambiar la URL obliga a MapLibre a volver a pedir las teselas; sin esto
  // seguiria mostrando las cacheadas y el equipo no veria los datos nuevos.
  if (fuente) fuente.setTiles([`${location.origin}/api/tiles/{z}/{x}/{y}.pbf?v=${Date.now()}`]);
}

export function cambiarBase(cual) {
  for (const [clave, base] of Object.entries(BASES)) {
    mapa.setLayoutProperty(base.fuente, 'visibility', clave === cual ? 'visible' : 'none');
    const boton = $(`base-${clave}`);
    if (boton) boton.setAttribute('aria-pressed', String(clave === cual));
  }
  localStorage.setItem('geovisor.base', cual);
}

export function baseGuardada() {
  return localStorage.getItem('geovisor.base') || 'claro';
}

export function irA(lugar) {
  mapa.flyTo({ center: [lugar.lon, lugar.lat], zoom: lugar.zoom, speed: 1.6 });
}

export function encuadrar(extension) {
  if (!extension || extension.length !== 4) return;
  mapa.fitBounds([[extension[0], extension[1]], [extension[2], extension[3]]],
                 { padding: 60, maxZoom: 17 });
}

/** Lectura continua de la posicion del cursor, en 4326 y en 9377. */
export function seguirCursor() {
  const geo = $('coord-geo');
  const plana = $('coord-9377');
  if (!geo || !plana) return;

  const pintar = ({ lng, lat }) => {
    geo.textContent = `${lat.toFixed(5)}°, ${lng.toFixed(5)}°`;
    const { este, norte } = a9377(lng, lat);
    plana.textContent = `E ${numero(este, 1)}  N ${numero(norte, 1)}`;
  };

  mapa.on('mousemove', (evento) => pintar(evento.lngLat));
  // En pantalla tactil no hay cursor: se muestra el centro del mapa.
  mapa.on('move', () => {
    if (matchMedia('(hover: hover)').matches) return;
    pintar(mapa.getCenter());
  });
}
