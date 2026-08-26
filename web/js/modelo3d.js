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
import { mapa, cambiarBase, baseGuardada, apagarBase, mostrarBrujula } from './mapa.js';

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
let basePrevia = null;

// Mapa base bajo un modelo 3D. Es una decision de aspecto, no de gusto: el
// modelo es una fotografia aerea con relieve, y dejarlo sobre un callejero
// plano lo hace parecer un recorte pegado encima. Sobre ortoimagen, el borde
// del vuelo se funde con lo que hay alrededor y se lee como lo que es, un
// trozo de terreno mejor levantado que el resto.
const BASE_PARA_3D = 'satelite';

/* Relieve del terreno alrededor del modelo
 * ----------------------------------------
 * El vuelo cubre 545 x 478 m y se corta en seco: fuera de ahi el mapa es
 * plano, asi que el cerro parece una isla recortada flotando. Con el relieve
 * encendido, la ladera continua mas alla del borde del vuelo.
 *
 * Lo dibuja deck.gl y NO MapLibre, aunque MapLibre sabe hacer terreno. La
 * razon es que la superposicion de deck mantiene su propia camara y no sigue
 * al terreno de MapLibre -comprobado con setCenterElevation-, asi que un
 * terreno de MapLibre quedaria desalineado del modelo. Estando los dos en
 * deck comparten camara y buffer de profundidad, y encajan por construccion.
 *
 * Va apagado por defecto: son teselas de altura y de imagen que no todo el
 * mundo necesita, y en campo el ancho de banda es el recurso escaso.
 */
// Modelo digital del terreno de Mapzen/AWS. Publico, sin clave y sin cuota.
const DEM = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
// Y encima, la misma ortoimagen que ya usa el mapa base «Satelite».
const IMAGEN_TERRENO =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';

// El DEM de Mapzen no pasa de aqui. Por encima, deck reescala el ultimo.
const DEM_ZOOM_MAX = 15;

/**
 * Alturas entre las que se mueve el terreno, en metros y ya apoyado.
 *
 * Sin esto, la libreria no sabe a que altura esta el suelo y para elegir que
 * teselas pedir se pone en lo peor: como el formato Terrarium puede codificar
 * desde -32.768 m, calculaba una huella de miles de kilometros y traia el
 * terreno en ZOOM 5 -unos 5 km por pixel- en vez del 15. Por eso lo de
 * alrededor se veia oscuro y emborronado cuanto mas se acercaba uno: no era
 * sombreado, era un mapa de altura mil veces mas basto de lo que tocaba.
 *
 * Los numeros son del sitio: el fondo del valle de Cali queda unos 500 m por
 * debajo de la explanada del monumento, y los cerros de alrededor unos 600
 * por encima.
 */
const RANGO_ALTURAS = [-600, 600];
/**
 * Cuanto se hunde el relieve por debajo de su altura medida, en metros.
 *
 * El DEM publico tiene una celda de unos 30 m y el vuelo, 2 cm: son la misma
 * ladera contada con detalles muy distintos, y donde el DEM suaviza una arista
 * queda por encima de la malla y la corta. Medido sobre 22 puntos del vuelo:
 * las dos superficies concuerdan con una mediana de -1,7 m -o sea que la
 * correccion del geoide es correcta- pero el DEM asoma hasta 9,6 m en las
 * vaguadas del flanco oeste.
 *
 * Hundiendolo doce metros, la malla del vuelo gana siempre. El precio es un
 * escaloncito de esa altura en el borde del vuelo, que sobre un cerro de 172 m
 * de desnivel apenas se nota y ademas deja claro hasta donde llego el dron.
 * Que el terreno bastо corte el monumento es mucho peor.
 */
const HOLGURA_RELIEVE = 12;

const LLAVE_RELIEVE = 'geovisor.relieve3d';
let conRelieve = false;
try { conRelieve = localStorage.getItem(LLAVE_RELIEVE) === 'si'; } catch { conRelieve = false; }

export const hayRelieve = () => conRelieve;

export function fijarRelieve(encendido) {
  conRelieve = Boolean(encendido);
  try { localStorage.setItem(LLAVE_RELIEVE, conRelieve ? 'si' : 'no'); } catch { /* modo privado */ }
  apagarBase(conRelieve && encendidos.size > 0);
  repintar();
}

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
  // El que convierte las teselas de altura en malla. Mismo motivo: de serie
  // se lo pide a unpkg.com.
  terrain: { workerUrl: `${VENDOR}/terrain-worker.js` },
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

  mostrarBrujula(true);

  basePrevia = baseGuardada();
  if (basePrevia !== BASE_PARA_3D) {
    cambiarBase(BASE_PARA_3D);
    avisar('Se cambió a Satélite mientras miras el modelo 3D. '
           + 'Puedes elegir otro mapa base cuando quieras. '
           + 'La brújula de arriba a la derecha devuelve la vista.');
  } else {
    avisar('Arrastra con el botón derecho para inclinar y girar. '
           + 'La brújula de arriba a la derecha devuelve la vista.');
  }
}

function devolverVista2D() {
  if (!camaraPrevia) return;
  // El relieve no tiene sentido sin modelo, y dejarlo encendido con el mapa
  // plano apagado dejaria el visor sin fondo.
  apagarBase(false);
  mostrarBrujula(false);
  mapa.dragRotate.disable();
  mapa.touchZoomRotate.disableRotation();
  mapa.easeTo({ pitch: camaraPrevia.pitch, bearing: camaraPrevia.bearing, duration: 400 });
  camaraPrevia = null;

  // Solo se devuelve si nadie lo toco a mano por el camino: cambiar de mapa
  // base es una eleccion de quien mira, y deshacersela al apagar una capa
  // seria quitarle el mando.
  if (basePrevia && basePrevia !== BASE_PARA_3D && baseGuardada() === BASE_PARA_3D) {
    cambiarBase(basePrevia);
  }
  basePrevia = null;
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
    onTilesetLoad: (conjunto) => {
      estado.conjunto = conjunto;
      // Estas dos NO se pueden pasar como propiedades de la capa: deck.gl no
      // las reenvia al recorrido del arbol. Se ponen sobre el conjunto ya
      // construido, que es donde las lee. Ver modelos3d.py para el porque de
      // cada numero.
      const ajustes = item.fuente.modelo || {};
      if (Number.isFinite(ajustes.detalle)) {
        conjunto.options.viewDistanceScale = ajustes.detalle;
      }
      if (Number.isFinite(ajustes.memoria_mb)) {
        conjunto.options.maximumMemoryUsage = ajustes.memoria_mb;
      }
    },
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

/**
 * Altura que el DEM da bajo el modelo encendido, para alinearlos.
 *
 * Sin esto el terreno saldria a su altura sobre el nivel del mar y el modelo
 * a la suya sobre el elipsoide, con unos 25 m de diferencia en Cali: el cerro
 * atravesaria el vuelo por abajo o lo dejaria flotando.
 */
function alturaDemActiva() {
  for (const estado of encendidos.values()) {
    const dem = estado.item.fuente?.modelo?.altura_dem;
    if (Number.isFinite(dem) && dem !== 0) return dem;
  }
  return null;
}

function capasDeRelieve() {
  if (!conRelieve || !encendidos.size) return [];
  const dem = alturaDemActiva();
  if (dem === null) return [];      // modelo sin calibrar: mejor no dibujarlo

  // Sin recorte. Antes se traia solo un cuadro alrededor del vuelo, pero
  // como el relieve sustituye al mapa plano, fuera de ese cuadro quedaba el
  // vacio en cuanto alguien se alejaba o giraba. Se cargan solo las teselas
  // que caben en pantalla, asi que cubrir todo no cuesta mas.
  return [new deck.TerrainLayer({
    id: 'relieve',
    elevationData: DEM,
    texture: IMAGEN_TERRENO,
    maxZoom: DEM_ZOOM_MAX,
    zRange: RANGO_ALTURAS,
    // Formato Terrarium: la altura viene repartida en los tres canales. El
    // desplazamiento estandar es -32768; se le resta ademas la altura del
    // terreno bajo el modelo para que los dos queden al mismo nivel.
    elevationDecoder: {
      rScaler: 256, gScaler: 1, bScaler: 1 / 256,
      offset: -32768 - dem - HOLGURA_RELIEVE,
    },
    loadOptions: OPCIONES_CARGA,
    // Sin sombreado propio: la ortoimagen ya trae las sombras del dia que se
    // tomo, y anadirle otras encima ensucia el relieve en vez de aclararlo.
    material: false,
  })];
}

function repintar() {
  if (!overlay) return;
  const capas = [];
  // El relieve va PRIMERO para que quede debajo. Los dos escriben
  // profundidad, asi que donde el vuelo esta por encima, gana el vuelo.
  capas.push(...capasDeRelieve());
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
  if (conRelieve) apagarBase(true);
  if (!overlay) {
    // `interleaved: false` -la superposicion va por encima del mapa, con su
    // propio lienzo- y no true. Interleaved mete las capas de deck dentro de
    // la pila de MapLibre, que es mas bonito, pero hace que el orden y la
    // profundidad dependan de como MapLibre decida componer: con una malla
    // opaca de por medio eso es una fuente de fallos raros. Aqui el modelo
    // tapa lo que hay debajo, que es justo lo que se espera al mirarlo.
    overlay = new deck.MapboxOverlay({
      interleaved: false, layers: [],
      // El plano lejano de deck.gl se pega al suelo: de serie llega solo un
      // 1% mas alla de la altura de la camara. Todo lo que quede POR DEBAJO
      // del nivel cero se recorta, y el relieve queda por debajo casi
      // entero. Mirando de lado no se notaba -ahi la camara ve muy lejos-,
      // pero en vista cenital desaparecia el terreno y quedaba el modelo
      // flotando sobre el fondo negro. Ampliandolo un 30% cabe la ladera.
      //
      // Ni un poco mas: con 6 el terreno vuelve, pero la profundidad pierde
      // tanta precision que la malla del vuelo y el terreno se pelean pixel
      // a pixel y sale un mosaico. Probado.
      views: new deck.MapView({ farZMultiplier: 1.3 }),
    });
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
