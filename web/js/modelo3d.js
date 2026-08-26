/* Modelos 3D de vuelos de dron, sobre el mismo mapa.
 *
 * Por que deck.gl y no otra cosa
 * ------------------------------
 * MapLibre no sabe leer 3D Tiles y no hay forma de ensenarle. Las dos opciones
 * reales eran CesiumJS -un globo entero, con su propia camara y su propio
 * modelo de capas, que habria que mantener en paralelo al visor- o deck.gl,
 * que se superpone al mapa que ya existe y comparte camara con el. Se eligio
 * lo segundo: una capa mas en el mismo panel, con su ojo y su opacidad, en vez
 * de un segundo visor que aprender.
 *
 * Por que se carga a demanda
 * --------------------------
 * deck.min.js son 1,6 MB. Cargarlo siempre le costaria esa descarga a todo el
 * equipo por una capa que casi nadie enciende. Se inyecta la primera vez que
 * alguien enciende un modelo y no antes.
 *
 * Por que todo vendorizado
 * ------------------------
 * deck.gl descarga por su cuenta el descompresor Draco de gstatic.com y sus
 * workers de unpkg.com. Las mallas de Terra van comprimidas con Draco, asi
 * que sin esos archivos no se dibuja NADA. Depender de dos CDN ajenos para
 * mirar un modelo en una emergencia es exactamente el fallo que no se puede
 * permitir, y ademas el visor no carga nada de fuera por politica. Estan en
 * /vendor/draco y se le dice a la libreria que los busque ahi.
 *
 * El dibujo va aqui y no en MapLibre
 * ----------------------------------
 * La superposicion de deck tapa el lienzo de MapLibre donde el modelo es
 * opaco. La linea que dibuja `dibujo.js` se pinta en MapLibre, o sea DEBAJO
 * del modelo: quien marca una grieta no veria lo que esta marcando. Por eso
 * las marcas -la que se esta dibujando y las ya guardadas- se pintan aqui.
 */

import { api, avisar } from './util.js';
import { mapa } from './mapa.js';

const VENDOR = '/vendor';

/** Modelos encendidos ahora mismo, por clave de fuente. */
const encendidos = new Map();

let deck = null;             // el namespace de la libreria, una vez cargada
let cargando = null;         // promesa de carga, para no inyectar dos veces
let overlay = null;          // la superposicion sobre el mapa

/** Marcas ya guardadas que tienen geometria 3D. */
let anotaciones = [];
/** Lo que se esta dibujando ahora: {vertices: [[lon,lat,z],...], cerrado} */
let borrador = null;

// Estado del mapa antes de encender el primer modelo, para devolverlo.
let camaraPrevia = null;

const COLOR_BORRADOR = [255, 209, 102];
const COLOR_VERTICE = [255, 255, 255];

/** Un modelo 3D no es una capa de MapLibre: lo pinta deck.gl aparte. */
export const esModelo3D = (item) => item.fuente?.tipo === 'modelo3d';

// ---------------------------------------------------------------------------
// Carga de la libreria
// ---------------------------------------------------------------------------
function cargarLibreria() {
  if (deck) return Promise.resolve(deck);
  if (cargando) return cargando;

  cargando = new Promise((listo, fallar) => {
    const etiqueta = document.createElement('script');
    etiqueta.src = `${VENDOR}/deck.min.js`;
    etiqueta.onload = () => {
      deck = window.deck;
      if (!deck) { fallar(new Error('La librería 3D cargó pero no se registró')); return; }
      listo(deck);
    };
    etiqueta.onerror = () => fallar(new Error('No se pudo cargar la librería 3D'));
    document.head.appendChild(etiqueta);
  });
  return cargando;
}

/**
 * Donde buscar el descompresor Draco y su worker.
 *
 * Sin esto la libreria los pide a gstatic.com y a unpkg.com. `libraryPath`
 * termina en barra a proposito: la libreria le concatena el nombre del
 * archivo sin anadir separador.
 */
const OPCIONES_CARGA = {
  draco: {
    workerUrl: `${VENDOR}/draco/draco-worker.js`,
    libraryPath: `${VENDOR}/draco/`,
    decoderType: 'wasm',
  },
};

// ---------------------------------------------------------------------------
// Camara
// ---------------------------------------------------------------------------
/**
 * Un modelo 3D visto en planta no sirve de nada: hay que poder inclinar y
 * girar. El visor arranca con ambas cosas apagadas a proposito -en campo son
 * gestos accidentales y trabajo de GPU de mas-, asi que se encienden mientras
 * haya un modelo y se devuelven a como estaban al apagar el ultimo.
 */
function permitirVista3D() {
  if (camaraPrevia) return;
  camaraPrevia = { pitch: mapa.getPitch(), bearing: mapa.getBearing() };
  mapa.dragRotate.enable();
  mapa.touchZoomRotate.enableRotation();
}

function devolverVista2D() {
  if (!camaraPrevia) return;
  mapa.dragRotate.disable();
  mapa.touchZoomRotate.disableRotation();
  mapa.easeTo({ pitch: camaraPrevia.pitch, bearing: camaraPrevia.bearing, duration: 400 });
  camaraPrevia = null;
}

// ---------------------------------------------------------------------------
// Capas
// ---------------------------------------------------------------------------
function capaDelModelo(clave, estado) {
  const { item } = estado;
  return new deck.Tile3DLayer({
    id: `modelo-${clave}`,
    data: item.fuente.modelo.tileset,
    loadOptions: OPCIONES_CARGA,
    opacity: item.opacidad ?? 1,
    visible: item.visible !== false,
    pickable: true,
    // Sin esto la malla se dibuja sombreada por deck y las texturas del vuelo
    // salen apagadas. El material ya viene marcado como 'unlit' en el glTF.
    onTilesetLoad: (conjunto) => { estado.conjunto = conjunto; },
    onTileError: (tesela, error) => {
      // Una tesela suelta que falla no es noticia; que fallen todas si.
      estado.fallos = (estado.fallos || 0) + 1;
      if (estado.fallos === 12) {
        avisar(`El modelo «${item.nombre}» está fallando al cargar: ${error?.message || error}`,
               true);
      }
    },
  });
}

/** Convierte una geometria GeoJSON 3D en los caminos que dibuja deck. */
function caminosDe(geometria) {
  if (!geometria) return [];
  const { type, coordinates } = geometria;
  if (type === 'LineString') return [coordinates];
  if (type === 'MultiLineString') return coordinates;
  if (type === 'Polygon') return coordinates;
  if (type === 'MultiPolygon') return coordinates.flat();
  return [];
}

const aColor = (hex) => {
  const limpio = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!limpio) return [230, 57, 70];
  const n = parseInt(limpio[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

/**
 * Baja una altura elipsoidal al plano del mapa.
 *
 * Las anotaciones se guardan con su altura de verdad, pero el modelo se dibuja
 * apoyado (ver modelos3d.py). Si no se restara lo mismo, las marcas quedarian
 * flotando 1.483 m por encima de la grieta que senalan.
 */
const aPlano = (z, base) => (Number.isFinite(z) ? z - base : 0);

function capasDeMarcas() {
  const base = alturaBaseActiva();
  const capas = [];

  const lineas = [];
  const puntos = [];
  for (const marca of anotaciones) {
    const color = aColor(marca.properties?.color);
    if (marca.geometry?.type === 'Point') {
      const [lon, lat, z] = marca.geometry.coordinates;
      puntos.push({ posicion: [lon, lat, aPlano(z, base)], color, id: marca.id });
      continue;
    }
    for (const camino of caminosDe(marca.geometry)) {
      lineas.push({
        camino: camino.map(([lon, lat, z]) => [lon, lat, aPlano(z, base)]),
        color,
        id: marca.id,
      });
    }
  }

  if (lineas.length) {
    capas.push(new deck.PathLayer({
      id: 'marcas-3d-lineas',
      data: lineas,
      getPath: (d) => d.camino,
      getColor: (d) => d.color,
      widthUnits: 'pixels',
      getWidth: 3,
      widthMinPixels: 2,
      // Sin esto la propia malla tapa la marca: una grieta se dibuja pegada a
      // la superficie y la mitad de sus puntos caen microscopicamente detras.
      parameters: { depthTest: false },
      pickable: true,
    }));
  }
  if (puntos.length) {
    capas.push(new deck.ScatterplotLayer({
      id: 'marcas-3d-puntos',
      data: puntos,
      getPosition: (d) => d.posicion,
      getFillColor: (d) => d.color,
      radiusUnits: 'pixels',
      getRadius: 5,
      stroked: true,
      getLineColor: [17, 22, 29],
      lineWidthUnits: 'pixels',
      getLineWidth: 1.5,
      parameters: { depthTest: false },
      pickable: true,
    }));
  }

  if (borrador && borrador.vertices.length) {
    const puestos = borrador.vertices.map(([lon, lat, z]) => [lon, lat, aPlano(z, base)]);
    const camino = borrador.cerrado && puestos.length >= 3
      ? [...puestos, puestos[0]]
      : puestos;
    if (camino.length >= 2) {
      capas.push(new deck.PathLayer({
        id: 'borrador-3d-linea',
        data: [{ camino }],
        getPath: (d) => d.camino,
        getColor: COLOR_BORRADOR,
        widthUnits: 'pixels',
        getWidth: 3,
        widthMinPixels: 2,
        parameters: { depthTest: false },
      }));
    }
    capas.push(new deck.ScatterplotLayer({
      id: 'borrador-3d-vertices',
      data: puestos.map((p) => ({ p })),
      getPosition: (d) => d.p,
      getFillColor: COLOR_VERTICE,
      radiusUnits: 'pixels',
      getRadius: 4,
      stroked: true,
      getLineColor: COLOR_BORRADOR,
      lineWidthUnits: 'pixels',
      getLineWidth: 2,
      parameters: { depthTest: false },
    }));
  }
  return capas;
}

function repintar() {
  if (!overlay) return;
  const capas = [];
  for (const [clave, estado] of encendidos) capas.push(capaDelModelo(clave, estado));
  capas.push(...capasDeMarcas());
  overlay.setProps({ layers: capas });
}

// ---------------------------------------------------------------------------
// Encendido y apagado
// ---------------------------------------------------------------------------
export async function encender(item) {
  if (!item.fuente?.modelo?.tileset) {
    avisar(`«${item.nombre}» está en el catálogo pero no tiene archivos en el servidor.`, true);
    return;
  }
  if (encendidos.has(item.id)) { ajustar(item); return; }

  try {
    await cargarLibreria();
  } catch (error) {
    avisar(error.message, true);
    return;
  }

  encendidos.set(item.id, { item });
  if (!overlay) {
    // `interleaved: false` -la superposicion va por encima del mapa, con su
    // propio lienzo- y no true. Interleaved mete las capas de deck dentro de
    // la pila de MapLibre, que es mas bonito, pero hace que el orden y la
    // profundidad dependan de como MapLibre decida componer: con una malla
    // opaca de por medio eso es una fuente de fallos raros. Aqui el modelo
    // tapa lo que hay debajo, que es justo lo que se espera al mirarlo.
    overlay = new deck.MapboxOverlay({ interleaved: false, layers: [] });
    mapa.addControl(overlay);
  }
  permitirVista3D();
  repintar();
  await refrescarAnotaciones();
}

export function apagar(clave) {
  if (!encendidos.delete(clave)) return;
  if (encendidos.size === 0) devolverVista2D();
  repintar();
}

/** Visibilidad y opacidad, sin rehacer nada. */
export function ajustar(item) {
  const estado = encendidos.get(item.id);
  if (!estado) return;
  estado.item = item;
  repintar();
}

export const hayModelo = () => encendidos.size > 0;

/** Altura elipsoidal que el modelo encendido usa como cero del mapa. */
function alturaBaseActiva() {
  for (const estado of encendidos.values()) {
    const base = estado.item.fuente?.modelo?.altura_base;
    if (Number.isFinite(base)) return base;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Marcar sobre la malla
// ---------------------------------------------------------------------------
/**
 * Punto de la superficie del modelo bajo un pixel de la pantalla.
 *
 * Devuelve [longitud, latitud, altura elipsoidal] o null si ahi no hay malla
 * -un hueco del vuelo, o el cielo-.
 *
 * La longitud y la latitud NO son las de `evento.lngLat` de MapLibre: esa es
 * donde el rayo corta el plano del suelo, que con la camara inclinada puede
 * estar a decenas de metros del punto de la ladera que se esta senalando. La
 * buena es esta.
 */
export function puntoEn(pixel) {
  if (!overlay || !encendidos.size) return null;
  let info = null;
  try {
    info = overlay.pickObject({
      x: pixel.x,
      y: pixel.y,
      // Dos pixeles de tolerancia: en una grieta se apunta al borde de la
      // malla y pedir precision exacta obliga a repetir el clic.
      radius: 2,
      layerIds: [...encendidos.keys()].map((c) => `modelo-${c}`),
      unproject3D: true,
    });
  } catch {
    return null;
  }
  if (!info || !info.coordinate) return null;
  const [lon, lat, z] = info.coordinate;
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  return [lon, lat, (z || 0) + alturaBaseActiva()];
}

/** Lo que se esta dibujando, para que se vea por encima del modelo. */
export function previsualizar(vertices, cerrado = false) {
  borrador = vertices && vertices.length ? { vertices, cerrado } : null;
  repintar();
}

export async function refrescarAnotaciones() {
  if (!encendidos.size) { anotaciones = []; return; }
  try {
    const coleccion = await api('/api/features/anotaciones-3d');
    anotaciones = coleccion.features || [];
  } catch {
    // Que no se puedan leer las marcas guardadas no impide mirar el modelo.
    anotaciones = [];
  }
  repintar();
}
