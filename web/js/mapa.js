/* Mapa, mapas base, capas dinamicas y coordenadas del cursor. */

import { a9377 } from './proyeccion.js';
import * as modelo3d from './modelo3d.js';
import { $, numero } from './util.js';
import { COLOMBIA } from './ciudades.js';

/* Mapas base
 * ----------
 * Los dos primeros salian de CARTO hasta que CARTO empezo a exigir clave: las
 * teselas seguian llegando con un 200 y con «API KEY REQUIRED» estampado
 * encima, asi que no fallaba nada y el mapa se veia mal igualmente.
 *
 * En su lugar van los estilos de OpenFreeMap. Son VECTORIALES, no teselas de
 * imagen, lo que ademas quita el techo de zoom: el texto y las calles salen
 * nitidos a cualquier escala en vez de pixelarse. Y son los mismos disenos de
 * antes -«positron» y «dark» son los originales abiertos de los que CARTO
 * hacia sus light_all y dark_all-, asi que nadie tiene que reaprender a leer
 * el mapa.
 *
 * Sin clave y sin cuota. La alternativa era pedirle una a CARTO y meterla en
 * el .env, con lo que el visor se rompe el dia que caduque o se pase de
 * volumen, que en una emergencia es exactamente cuando pasaria.
 *
 * Los dos estilos comparten fuente de datos, tipografias y sprite, y por eso
 * caben en un mismo estilo sin pisarse: se anaden las capas de los dos con
 * prefijo y se enciende el grupo que toque. Se mezclan en vez de cambiar el
 * estilo entero con setStyle porque eso tiraria todas las capas que el equipo
 * tenga puestas y habria que rehacerlas a mano.
 */
const OPENFREEMAP = {
  claro: 'https://tiles.openfreemap.org/styles/positron',
  oscuro: 'https://tiles.openfreemap.org/styles/dark',
};
const ATRIBUCION_OFM = '© OpenFreeMap · © OpenMapTiles · © OpenStreetMap';

// Callejero de reserva. Es de imagen y no pasa del zoom 19, pero no pide
// clave y viene del mismo sitio que el satelite. Existe para que un
// OpenFreeMap caido no deje el visor sin mapa base en mitad de una
// emergencia: en ese caso pasa a ser el «Claro».
const CALLES_RESERVA =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}';

/** Que capas del estilo enciende cada boton. Las vectoriales se rellenan
 *  al preparar, porque hay que ir a buscarlas. */
const BASES = {
  claro:    { etiqueta: 'Claro',    capas: [] },
  oscuro:   { etiqueta: 'Oscuro',   capas: [] },
  satelite: { etiqueta: 'Satélite', capas: ['base-satelite'] },
};

const estilo = {
  version: 8,
  // Van en el estilo desde el principio aunque las capas que los usan lleguen
  // despues: MapLibre solo los pide cuando tiene que dibujar una etiqueta, y
  // ponerlos mas tarde obligaria a recargar el estilo entero.
  glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
  sprite: 'https://tiles.openfreemap.org/sprites/ofm_f384/ofm',
  sources: {
    // maxzoom 19 NO es hasta donde se ve, sino hasta donde hay foto. Sobre
    // Cali, Esri no pasa de ahi: a partir del 20 devuelve un 200 con una
    // tesela gris que pone «Map data not yet available», y el mapa entero se
    // llena de ese cartel justo al acercarse a mirar una grieta. Con el
    // techo puesto, MapLibre estira la ultima foto buena, que se ve borrosa
    // pero es la imagen que hay.
    satelite: { type: 'raster', tileSize: 256, maxzoom: 19,
      tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
      attribution: 'Esri · Maxar · Earthstar Geographics' },
    calles: { type: 'raster', tileSize: 256, maxzoom: 19,
      tiles: [CALLES_RESERVA],
      attribution: 'Esri · HERE · Garmin · © OpenStreetMap' },
  },
  layers: [
    { id: 'fondo', type: 'background', paint: { 'background-color': '#0e1319' } },
    { id: 'base-calles', type: 'raster', source: 'calles', layout: { visibility: 'none' } },
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
 * atributo que el servidor mete en la tesela para esta capa. Las fuentes
 * externas no pasan por la tesela sino que llegan como GeoJSON completo, asi
 * que ahi el atributo se lee por su nombre real.
 */
export function expresionColor(item) {
  const base = item.color || '#e63946';
  const estilo = item.estilo;
  if (!estilo || !estilo.campo) return base;
  const atributo = item.esExterna ? estilo.campo : 'valor';

  if (estilo.modo === 'categorias') {
    const pares = Object.entries(estilo.colores || {});
    if (!pares.length) return base;
    // 'has' descarta los elementos sin ese atributo: sin el, `to-string` los
    // convertiria en cadena vacia y se pintarian todos como una categoria mas.
    return ['case', ['has', atributo],
      ['match', ['to-string', ['get', atributo]],
        ...pares.flatMap(([valor, color]) => [valor, color]), base],
      base];
  }

  if (estilo.modo === 'rangos') {
    const cortes = estilo.cortes || [];
    const colores = estilo.colores || [];
    if (cortes.length < 2 || colores.length !== cortes.length - 1) return base;
    const paso = ['step', ['to-number', ['get', atributo], 0], colores[0]];
    for (let i = 1; i < colores.length; i++) paso.push(cortes[i], colores[i]);
    return ['case', ['has', atributo], paso, base];
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

/**
 * Aplica el filtro local de una capa catastral.
 *
 * Aparte de fijarFiltro(), que solo toca las capas propias (`capa-*`) y
 * combina el filtro con el tipo de geometria. Las catastrales son todas
 * poligonos y viven en `ext-*`, asi que la expresion va tal cual.
 */
export function fijarFiltroCatastro(clave, expresion) {
  for (const sufijo of ['-relleno', '-borde']) {
    const id = `ext-${clave}${sufijo}`;
    if (mapa.getLayer(id)) mapa.setFilter(id, expresion);
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

/** Prefijo de las capas de MapLibre que corresponden a un item del panel. */
const claveDe = (item) =>
  item.esExterna ? `ext-${item.id}` : item.esRaster ? `raster-${item.id}` : `capa-${item.id}`;

/** Los rasters propios y las ortoimagenes externas se pintan igual: una sola
 *  capa de tipo raster, con opacidad, y sin partes de relleno ni borde. */
const esImagen = (item) => Boolean(item.esRaster || item.esImagen);

const PARTES_VECTOR = ['-relleno', '-borde', '-punto'];

/** Las capas catastrales no llegan como GeoJSON sino como teselas propias. */
const esCatastro = (item) => item.fuente?.tipo === 'catastro';

/**
 * Zoom que le falta a una capa para dibujarse, o null si ya se dibuja.
 *
 * El catastro no se pide por debajo de su zoom_min, porque a escala de ciudad
 * son cientos de miles de poligonos y lo que se veria seria una mancha. El
 * problema es que encender una capa y no ver NADA se lee como que esta rota:
 * el panel dice 650.975, la leyenda sale, y el mapa esta vacio. Con esto, la
 * leyenda y el panel pueden decir que falta acercarse en vez de callarse.
 */
export function zoomQueFalta(item) {
  // Un modelo 3D son 545 m de lado: a escala de ciudad es una mancha parda de
  // pocos pixeles que cuesta megabytes. Mismo trato que el catastro.
  if (!esCatastro(item) && !modelo3d.esModelo3D(item)) return null;
  const minimo = item.fuente.zoom_min ?? 15;
  return mapa.getZoom() < minimo ? minimo : null;
}

/**
 * Opacidad del relleno de una capa vectorial externa.
 *
 * El catastro va mas transparente que el resto A PROPOSITO. En una capa
 * normal los poligonos no se pisan, asi que 0,32 es un relleno legible. En el
 * catastro si se pisan -las plantas de un edificio se superponen casi por
 * completo- y MapLibre compone cada una sobre la anterior: a 0,32 una torre
 * de diez plantas sale negra y no se distingue nada. A 0,16 el apilamiento se
 * lee como lo que es, un degradado por altura, y el borde sigue marcando cada
 * planta.
 */
const opacidadRelleno = (item) => (esCatastro(item) ? 0.16 : 0.32);

/**
 * Monta una fuente externa.
 *
 * Las ortoimagenes salen por /api/externas/.../tiles: el navegador nunca habla
 * con el IGAC directamente. Los vectores llegan como un GeoJSON completo -no
 * como teselas- porque ninguna de estas fuentes pasa de unos pocos miles de
 * elementos y asi el servidor no tiene que trocear nada.
 */
/**
 * Radio de los puntos de una capa, en pixeles y por nivel de zoom.
 *
 * El multiplicador lo pone quien mira, desde el panel. Hace falta porque el
 * tamano bueno no es una propiedad del dato sino de la escala de trabajo: los
 * mismos puntos que a nivel de ciudad hay que agrandar para verlos, a nivel de
 * manzana se convierten en una mancha. Los de una fuente externa arrancan algo
 * mas pequenos que los propios, para que el dibujo del equipo mande.
 */
function radioDe(item) {
  const factor = item.radio ?? 1;
  const base = item.esExterna ? [3.5, 6, 9] : [4, 7, 10];
  return ['interpolate', ['linear'], ['zoom'],
          5, base[0] * factor, 12, base[1] * factor, 18, base[2] * factor];
}

function montarExterna(item, clave) {
  // No lo pinta MapLibre sino deck.gl, en su propia superposicion. No hay
  // fuente ni capa que anadir aqui: solo avisar al modulo que lo lleva.
  if (modelo3d.esModelo3D(item)) {
    modelo3d.encender(item);
    return;
  }

  if (esImagen(item)) {
    if (!mapa.getSource(clave)) {
      mapa.addSource(clave, {
        type: 'raster',
        tiles: [`${location.origin}/api/externas/${item.id}/tiles/{z}/{x}/{y}.png`],
        tileSize: 256,
        bounds: item.bounds || undefined,
        // Los vuelos no dan mas de si; pedir z20 solo multiplica peticiones.
        maxzoom: 19,
      });
    }
    mapa.addLayer({ id: clave, type: 'raster', source: clave, paint: { 'raster-opacity': 1 } });
    return;
  }

  // El catastro son 1,5 millones de poligonos: no cabe en un GeoJSON. Va como
  // teselas vectoriales generadas en PostGIS desde la copia local, igual que
  // las capas del equipo, y con los atributos ya dentro de la tesela.
  if (esCatastro(item)) {
    const fuente = item.fuente;
    if (!mapa.getSource(clave)) {
      mapa.addSource(clave, {
        type: 'vector',
        tiles: [`${location.origin}/api/externas/${item.id}/teselas/{z}/{x}/{y}.pbf`],
        // Por debajo de minzoom no se pide nada: una tesela z14 del centro de
        // Cali son 32.000 poligonos y lo que se veria seria una mancha.
        minzoom: fuente.zoom_min ?? 15,
        // maxzoom NO es hasta donde se ve, sino hasta donde se genera. Por
        // encima MapLibre reescala la ultima tesela, que dibuja exactamente
        // los mismos poligonos sin pedir 256 teselas mas.
        maxzoom: fuente.zoom_max ?? 16,
        bounds: item.bounds || undefined,
      });
    }
    const colorCatastro = expresionColor(item);
    const origen = { source: clave, 'source-layer': 'catastro' };
    mapa.addLayer({
      id: `${clave}-relleno`, type: 'fill', ...origen,
      paint: { 'fill-color': colorCatastro, 'fill-opacity': opacidadRelleno(item) },
    });
    mapa.addLayer({
      id: `${clave}-borde`, type: 'line', ...origen,
      // Fino y a media opacidad: con los linderos pegados unos a otros, una
      // linea de 1,6 px como la de las demas capas los funde en una retícula
      // solida en cuanto te alejas de la manzana.
      paint: { 'line-color': colorCatastro, 'line-width': 0.7, 'line-opacity': 0.9 },
    });
    return;
  }

  if (!mapa.getSource(clave)) {
    mapa.addSource(clave, {
      type: 'geojson',
      data: `${location.origin}/api/externas/${item.id}.geojson`,
    });
  }
  const color = expresionColor(item);
  mapa.addLayer({
    id: `${clave}-relleno`, type: 'fill', source: clave, filter: ES_POLIGONO,
    paint: { 'fill-color': color, 'fill-opacity': 0.32 },
  });
  mapa.addLayer({
    id: `${clave}-borde`, type: 'line', source: clave,
    filter: ['any', ES_POLIGONO, ES_LINEA],
    paint: { 'line-color': color, 'line-width': ['case', ES_LINEA, 3, 1.6] },
  });
  mapa.addLayer({
    id: `${clave}-punto`, type: 'circle', source: clave, filter: ES_PUNTO,
    paint: {
      'circle-color': color,
      'circle-radius': radioDe(item),
      // Borde oscuro en vez de blanco: distingue de un vistazo lo que viene de
      // fuera de lo que dibujo el equipo, sin gastar un color.
      'circle-stroke-color': '#11161d',
      'circle-stroke-width': 1.4,
    },
  });
}

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
  const deseadas = items.map(claveDe);

  // Quitar lo que ya no existe.
  for (const clave of montadas) {
    if (deseadas.includes(clave)) continue;
    // Los modelos 3D no tienen capas de MapLibre que quitar; se apagan en su
    // propio modulo. La clave del panel es `ext-<id>`, y ahi el id es la
    // clave de la fuente.
    if (clave.startsWith('ext-')) modelo3d.apagar(clave.slice(4));
    for (const sufijo of ['', ...PARTES_VECTOR]) {
      const id = clave + sufijo;
      if (mapa.getLayer(id)) mapa.removeLayer(id);
    }
    // Las capas propias comparten la fuente 'datos' y esa no se toca; cada
    // raster y cada fuente externa tienen la suya y se va con ellos.
    if (!clave.startsWith('capa-') && mapa.getSource(clave)) mapa.removeSource(clave);
  }

  // Anadir lo que falta.
  for (const item of items) {
    const clave = claveDe(item);
    // Un modelo 3D no deja rastro en MapLibre, asi que la comprobacion de mas
    // abajo -«ya existe su capa»- nunca se cumpliria y se remontaria en cada
    // sincronizacion. Se pregunta a quien lo sabe.
    if (modelo3d.esModelo3D(item)) {
      if (!montadas.includes(clave)) montarExterna(item, clave);
      continue;
    }
    if (montadas.includes(clave) && mapa.getLayer(esImagen(item) ? clave : `${clave}-relleno`)) continue;

    if (item.esExterna) {
      montarExterna(item, clave);
    } else if (item.esRaster) {
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
          'circle-radius': radioDe(item),
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 1.6,
        },
      });
    }
  }

  // Reordenar: mover cada una al tope en orden ascendente deja la ultima
  // (la de mayor orden) al frente.
  for (const item of items) {
    const clave = claveDe(item);
    for (const sufijo of esImagen(item) ? [''] : PARTES_VECTOR) {
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
    const clave = claveDe(item);
    const visible = item.visible ? 'visible' : 'none';
    const opacidad = item.opacidad ?? 1;

    if (modelo3d.esModelo3D(item)) {
      modelo3d.ajustar(item);
      continue;
    }

    if (esImagen(item)) {
      if (!mapa.getLayer(clave)) continue;
      mapa.setLayoutProperty(clave, 'visibility', visible);
      mapa.setPaintProperty(clave, 'raster-opacity', opacidad);
      continue;
    }
    for (const sufijo of PARTES_VECTOR) {
      const id = clave + sufijo;
      if (!mapa.getLayer(id)) continue;
      mapa.setLayoutProperty(id, 'visibility', visible);
    }

    const color = expresionColor(item);
    if (mapa.getLayer(`${clave}-relleno`)) {
      mapa.setPaintProperty(`${clave}-relleno`, 'fill-color', color);
      mapa.setPaintProperty(`${clave}-relleno`, 'fill-opacity', opacidadRelleno(item) * opacidad);
    }
    if (mapa.getLayer(`${clave}-borde`)) {
      mapa.setPaintProperty(`${clave}-borde`, 'line-color', color);
      mapa.setPaintProperty(`${clave}-borde`, 'line-opacity',
                            (esCatastro(item) ? 0.9 : 1) * opacidad);
    }
    if (mapa.getLayer(`${clave}-punto`)) {
      mapa.setPaintProperty(`${clave}-punto`, 'circle-color', color);
      mapa.setPaintProperty(`${clave}-punto`, 'circle-opacity', opacidad);
      mapa.setPaintProperty(`${clave}-punto`, 'circle-radius', radioDe(item));
    }
  }
}

/** Ids de las capas MapLibre que responden a clics de seleccion. */
export function capasConsultables() {
  return montadas
    .filter((c) => c.startsWith('capa-'))
    .flatMap((c) => PARTES_VECTOR.map((s) => c + s))
    .filter((id) => mapa.getLayer(id));
}

/** Lo mismo para las fuentes externas. Van por separado porque su ficha no
 *  sale de la base sino de los atributos que ya viajan en el GeoJSON. */
export function capasExternasConsultables() {
  return montadas
    .filter((c) => c.startsWith('ext-'))
    .flatMap((c) => PARTES_VECTOR.map((s) => c + s))
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

/** Vuelve a pedir las fuentes externas ya montadas.
 *
 *  Un GeoJSON se descarga una sola vez al montarlo, asi que sin esto una capa
 *  de reportes ciudadanos encendida en la manana seguiria mostrando los de la
 *  manana. El parametro de tiempo solo sirve para saltarse la cache del
 *  navegador; el servidor lo ignora y devuelve lo que tenga, que es lo que
 *  evita castigar a la fuente cuando varios refrescan a la vez. */
export function refrescarExternas() {
  for (const clave of montadas) {
    if (!clave.startsWith('ext-')) continue;
    const fuente = mapa.getSource(clave);
    if (!fuente?.setData) continue;
    fuente.setData(
      `${location.origin}/api/externas/${clave.slice(4)}.geojson?v=${Date.now()}`);
  }
}

export function refrescarDatos() {
  const fuente = mapa.getSource('datos');
  // Cambiar la URL obliga a MapLibre a volver a pedir las teselas; sin esto
  // seguiria mostrando las cacheadas y el equipo no veria los datos nuevos.
  if (fuente) fuente.setTiles([`${location.origin}/api/tiles/{z}/{x}/{y}.pbf?v=${Date.now()}`]);
}

export function cambiarBase(cual) {
  if (!BASES[cual]) return;
  for (const [clave, base] of Object.entries(BASES)) {
    const como = clave === cual ? 'visible' : 'none';
    for (const id of base.capas) {
      if (mapa.getLayer(id)) mapa.setLayoutProperty(id, 'visibility', como);
    }
    const boton = $(`base-${clave}`);
    if (boton) boton.setAttribute('aria-pressed', String(clave === cual));
  }
  localStorage.setItem('geovisor.base', cual);
}

/**
 * Brujula, solo mientras se mira algo en 3D.
 *
 * El visor arranca sin ella porque tampoco se puede girar el mapa. Al
 * encender un modelo si se puede, y entonces hace falta: quien inclina la
 * camara para mirar una fachada se queda sin forma evidente de volver a la
 * vista de arriba. Pulsando la brujula se enderezan de golpe el giro y la
 * inclinacion.
 */
let brujula = null;

export function mostrarBrujula(mostrar) {
  if (mostrar && !brujula) {
    brujula = new maplibregl.NavigationControl({
      showZoom: false, showCompass: true, visualizePitch: true,
    });
    mapa.addControl(brujula, 'top-right');
    // MapLibre rotula sus controles en ingles y el resto del visor esta en
    // espanol. Es el unico sitio donde se leeria «click to reset north».
    const boton = document.querySelector('.maplibregl-ctrl-compass');
    if (boton) {
      const texto = 'Arrastra para girar; pulsa para volver a la vista desde arriba';
      boton.title = texto;
      boton.setAttribute('aria-label', texto);
    }
  } else if (!mostrar && brujula) {
    mapa.removeControl(brujula);
    brujula = null;
  }
}

/** Devuelve la camara a la vertical, mirando al norte. */
export function enderezar() {
  mapa.easeTo({ pitch: 0, bearing: 0, duration: 600 });
}

export function baseGuardada() {
  return localStorage.getItem('geovisor.base') || 'claro';
}

/**
 * Mete los mapas base vectoriales dentro del estilo que ya esta cargado.
 *
 * No se espera a que termine para arrancar el visor: son dos peticiones a un
 * servidor de fuera y nada del arranque depende de ellas. Cuando llegan, se
 * vuelve a aplicar el mapa base elegido y aparecen solas.
 */
export async function prepararBases() {
  // Las capas de datos se anaden despues del arranque y tienen que quedar POR
  // ENCIMA del mapa base. Se inserta antes de la primera que no sea de base;
  // si todavia no hay ninguna, al final, que en ese momento es lo mismo.
  const tope = () => {
    const capas = mapa.getStyle().layers || [];
    const primera = capas.find((c) => c.id !== 'fondo'
      && !c.id.startsWith('base-') && !c.id.startsWith('ofm-'));
    return primera ? primera.id : undefined;
  };

  for (const [clave, url] of Object.entries(OPENFREEMAP)) {
    try {
      const respuesta = await fetch(url);
      if (!respuesta.ok) throw new Error(`HTTP ${respuesta.status}`);
      const suyo = await respuesta.json();

      // Los dos estilos comparten las fuentes: se anaden una sola vez.
      for (const [id, fuente] of Object.entries(suyo.sources || {})) {
        const idFuente = `ofm-${id}`;
        if (!mapa.getSource(idFuente)) {
          mapa.addSource(idFuente, { ...fuente, attribution: ATRIBUCION_OFM });
        }
      }
      const antes = tope();
      for (const capa of suyo.layers || []) {
        // El prefijo es obligatorio: los dos estilos traen una capa llamada
        // 'background', otra 'water'... y sin renombrar se pisarian.
        const nueva = { ...capa, id: `ofm-${clave}-${capa.id}` };
        if (nueva.source) nueva.source = `ofm-${nueva.source}`;
        nueva.layout = { ...(nueva.layout || {}), visibility: 'none' };
        mapa.addLayer(nueva, antes);
        BASES[clave].capas.push(nueva.id);
      }
    } catch (error) {
      console.warn(`No se pudo cargar el mapa base ${clave}:`, error.message);
    }
  }

  // Reserva. Sin el claro vectorial, el callejero de imagen ocupa su sitio.
  // Para el oscuro no hay reserva sin clave, asi que su boton se apaga: mejor
  // eso que un boton que no hace nada y parece averiado.
  if (!BASES.claro.capas.length) BASES.claro.capas.push('base-calles');
  const botonOscuro = $('base-oscuro');
  if (botonOscuro && !BASES.oscuro.capas.length) {
    botonOscuro.disabled = true;
    botonOscuro.title = 'El mapa base oscuro no se pudo cargar.';
  }

  const elegido = baseGuardada();
  cambiarBase(BASES[elegido] && BASES[elegido].capas.length ? elegido : 'claro');
}

export function irA(lugar) {
  mapa.flyTo({ center: [lugar.lon, lugar.lat], zoom: lugar.zoom, speed: 1.6 });
}

export function encuadrar(extension, zoomMinimo = null) {
  if (!extension || extension.length !== 4) return;
  // Encuadrar el catastro de Cali entero deja el mapa en zoom 12, por debajo
  // del zoom al que la capa se dibuja: el boton cumpliria al pie de la letra
  // y aun asi te dejaria mirando un mapa vacio. Cuando la capa tiene minimo,
  // se va al centro de su extension a ese zoom.
  if (zoomMinimo != null) {
    mapa.flyTo({
      center: [(extension[0] + extension[2]) / 2, (extension[1] + extension[3]) / 2],
      zoom: zoomMinimo,
      speed: 1.6,
    });
    return;
  }
  mapa.fitBounds([[extension[0], extension[1]], [extension[2], extension[3]]],
                 { padding: 60, maxZoom: 17 });
}

/**
 * Deja la camara en perspectiva.
 *
 * Un modelo 3D visto en planta se confunde con una ortofoto de mala calidad:
 * el relieve, que es todo lo que aporta, no se ve. Se inclina al llegar para
 * que la primera impresion sea la correcta. 55 grados y no mas: pasados los
 * 70 el horizonte se llena de nada y cuesta orientarse.
 */
export function inclinar(grados = 55) {
  if (mapa.getPitch() >= grados - 5) return;
  const aplicar = () => mapa.easeTo({ pitch: grados, duration: 900 });
  // Un easeTo lanzado mientras el flyTo de «Ir a la capa» esta en el aire lo
  // cancela y deja el mapa donde iba, no donde iba a llegar. Medido: el visor
  // se quedaba en zoom 5 sobre Colombia entera en vez de en el 16 del modelo.
  if (mapa.isMoving()) mapa.once('moveend', aplicar);
  else aplicar();
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
