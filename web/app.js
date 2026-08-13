/* Geovisor de emergencia sismica -- visor.
   Sin framework ni paso de compilacion: se edita y se despliega tal cual. */

'use strict';

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);

let temporizadorAviso;
function avisar(texto, esError = false) {
  const aviso = $('aviso');
  aviso.textContent = texto;
  aviso.classList.toggle('error', esError);
  aviso.classList.add('visible');
  clearTimeout(temporizadorAviso);
  temporizadorAviso = setTimeout(() => aviso.classList.remove('visible'), 4200);
}

/** fetch con manejo central del 401: si la sesion caduca, al login. */
async function api(ruta, opciones = {}) {
  const respuesta = await fetch(ruta, opciones);
  if (respuesta.status === 401) {
    location.href = '/login.html';
    throw new Error('Sesion expirada');
  }
  if (!respuesta.ok) {
    const cuerpo = await respuesta.json().catch(() => ({}));
    throw new Error(cuerpo.detail || `Error ${respuesta.status}`);
  }
  return respuesta.status === 204 ? null : respuesta.json();
}

// --- Medicion geodesica ----------------------------------------------------
// Solo para el rotulo en vivo mientras se dibuja. Las cifras oficiales las
// calcula PostGIS sobre EPSG:9377 al exportar; estas son una aproximacion
// esferica, suficiente para orientar a quien dibuja.
const RADIO_TIERRA = 6371008.8;  // radio medio IUGG, metros
const RAD = Math.PI / 180;

function distancia(a, b) {
  const dLat = (b[1] - a[1]) * RAD;
  const dLng = (b[0] - a[0]) * RAD;
  const h = Math.sin(dLat / 2) ** 2 +
            Math.cos(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * RADIO_TIERRA * Math.asin(Math.min(1, Math.sqrt(h)));
}

function longitudDe(coordenadas) {
  let total = 0;
  for (let i = 1; i < coordenadas.length; i++) total += distancia(coordenadas[i - 1], coordenadas[i]);
  return total;
}

function areaDe(anillo) {
  if (anillo.length < 3) return 0;
  let total = 0;
  for (let i = 0; i < anillo.length; i++) {
    const [x1, y1] = anillo[i];
    const [x2, y2] = anillo[(i + 1) % anillo.length];
    total += (x2 - x1) * RAD * (2 + Math.sin(y1 * RAD) + Math.sin(y2 * RAD));
  }
  return Math.abs(total * RADIO_TIERRA * RADIO_TIERRA / 2);
}

const numero = (valor, decimales = 1) =>
  valor.toLocaleString('es-CO', { minimumFractionDigits: decimales, maximumFractionDigits: decimales });

const formatearLongitud = (m) => m < 1000 ? `${numero(m, 0)} m` : `${numero(m / 1000, 2)} km`;
const formatearArea = (m2) => m2 < 10000 ? `${numero(m2, 0)} m²` : `${numero(m2 / 10000, 2)} ha`;

// ---------------------------------------------------------------------------
// Mapa
// ---------------------------------------------------------------------------
const estilo = {
  version: 8,
  sources: {
    calles: {
      type: 'raster',
      // Teselas de 256 px sin @2x: pesan la mitad, y en campo el ancho de
      // banda importa mas que la nitidez.
      tiles: ['https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
              'https://b.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
              'https://c.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png'],
      tileSize: 256,
      attribution: '© OpenStreetMap · © CARTO'
    },
    satelite: {
      type: 'raster',
      tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
      tileSize: 256,
      attribution: 'Esri · Maxar · Earthstar Geographics'
    }
  },
  layers: [
    { id: 'fondo', type: 'background', paint: { 'background-color': '#0e1319' } },
    { id: 'base-calles', type: 'raster', source: 'calles' },
    { id: 'base-satelite', type: 'raster', source: 'satelite', layout: { visibility: 'none' } }
  ]
};

const mapa = new maplibregl.Map({
  container: 'mapa',
  style: estilo,
  center: [-74.3, 4.6],   // centro aproximado de Colombia
  zoom: 5,
  attributionControl: { compact: true }
});

mapa.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), 'top-right');
mapa.addControl(new maplibregl.ScaleControl({ maxWidth: 120, unit: 'metric' }), 'bottom-right');
mapa.addControl(new maplibregl.GeolocateControl({
  positionOptions: { enableHighAccuracy: true },
  trackUserLocation: true,
  showUserLocation: true
}), 'top-right');

const ES_POLIGONO = ['match', ['geometry-type'], ['Polygon', 'MultiPolygon'], true, false];
const ES_LINEA    = ['match', ['geometry-type'], ['LineString', 'MultiLineString'], true, false];
const ES_PUNTO    = ['match', ['geometry-type'], ['Point', 'MultiPoint'], true, false];

const CAPAS_DATOS = ['datos-poligono', 'datos-poligono-borde', 'datos-linea', 'datos-punto'];

mapa.on('load', () => {
  mapa.addSource('datos', {
    type: 'vector',
    tiles: [`${location.origin}/api/tiles/{z}/{x}/{y}.pbf`],
    minzoom: 0,
    maxzoom: 22
  });

  mapa.addLayer({
    id: 'datos-poligono', type: 'fill', source: 'datos', 'source-layer': 'elementos',
    filter: ES_POLIGONO,
    paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.32 }
  });
  mapa.addLayer({
    id: 'datos-poligono-borde', type: 'line', source: 'datos', 'source-layer': 'elementos',
    filter: ES_POLIGONO,
    paint: { 'line-color': ['get', 'color'], 'line-width': 2 }
  });
  mapa.addLayer({
    id: 'datos-linea', type: 'line', source: 'datos', 'source-layer': 'elementos',
    filter: ES_LINEA,
    paint: { 'line-color': ['get', 'color'], 'line-width': 3.5 }
  });
  mapa.addLayer({
    id: 'datos-punto', type: 'circle', source: 'datos', 'source-layer': 'elementos',
    filter: ES_PUNTO,
    paint: {
      'circle-color': ['get', 'color'],
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, 4, 12, 7, 18, 10],
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': 1.6
    }
  });

  // Capa de trabajo: lo que se esta dibujando ahora mismo.
  mapa.addSource('dibujo', { type: 'geojson', data: coleccionVacia() });
  mapa.addLayer({
    id: 'dibujo-relleno', type: 'fill', source: 'dibujo',
    filter: ES_POLIGONO,
    paint: { 'fill-color': '#ff4d3d', 'fill-opacity': 0.2 }
  });
  mapa.addLayer({
    id: 'dibujo-linea', type: 'line', source: 'dibujo',
    filter: ['any', ES_LINEA, ES_POLIGONO],
    paint: { 'line-color': '#ff4d3d', 'line-width': 2.5, 'line-dasharray': [2, 1.4] }
  });
  mapa.addLayer({
    id: 'dibujo-vertice', type: 'circle', source: 'dibujo',
    filter: ES_PUNTO,
    paint: {
      'circle-color': '#ff4d3d', 'circle-radius': 5,
      'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2
    }
  });

  CAPAS_DATOS.forEach((capa) => {
    mapa.on('mouseenter', capa, () => { if (!modo) mapa.getCanvas().style.cursor = 'pointer'; });
    mapa.on('mouseleave', capa, () => { if (!modo) mapa.getCanvas().style.cursor = ''; });
    mapa.on('click', capa, mostrarFicha);
  });

  cargarCapas();
});

const coleccionVacia = () => ({ type: 'FeatureCollection', features: [] });

function refrescarDatos() {
  const fuente = mapa.getSource('datos');
  // Cambiar la URL obliga a MapLibre a volver a pedir las teselas; sin esto
  // seguiria mostrando las cacheadas y el equipo no veria los datos nuevos.
  if (fuente) fuente.setTiles([`${location.origin}/api/tiles/{z}/{x}/{y}.pbf?v=${Date.now()}`]);
}

// ---------------------------------------------------------------------------
// Dibujo
// ---------------------------------------------------------------------------
let modo = null;        // null | 'punto' | 'linea' | 'poligono'
let vertices = [];
let posicionCursor = null;

const BOTONES_MODO = {
  punto: $('dibujar-punto'),
  linea: $('dibujar-linea'),
  poligono: $('dibujar-poligono')
};

function activarModo(nuevo) {
  modo = modo === nuevo ? null : nuevo;
  vertices = [];
  posicionCursor = null;

  Object.entries(BOTONES_MODO).forEach(([clave, boton]) =>
    boton.setAttribute('aria-pressed', String(clave === modo)));

  $('finalizar').disabled = true;
  $('cancelar').disabled = !modo;
  mapa.getCanvas().style.cursor = modo ? 'crosshair' : '';
  // Sin esto, el doble clic para cerrar la geometria haria zoom.
  if (modo) mapa.doubleClickZoom.disable(); else mapa.doubleClickZoom.enable();

  pintarDibujo();
  if (modo) avisar(modo === 'punto'
    ? 'Toca el mapa para ubicar el punto.'
    : 'Toca para agregar vertices. Doble toque o "Finalizar" para cerrar.');
}

BOTONES_MODO.punto.onclick = () => activarModo('punto');
BOTONES_MODO.linea.onclick = () => activarModo('linea');
BOTONES_MODO.poligono.onclick = () => activarModo('poligono');
$('cancelar').onclick = () => { activarModo(null); };
$('finalizar').onclick = () => finalizarDibujo();

mapa.on('click', (evento) => {
  if (!modo) return;
  vertices.push([evento.lngLat.lng, evento.lngLat.lat]);

  if (modo === 'punto') { finalizarDibujo(); return; }

  $('finalizar').disabled = vertices.length < (modo === 'poligono' ? 3 : 2);
  pintarDibujo();
});

mapa.on('mousemove', (evento) => {
  if (!modo || modo === 'punto' || vertices.length === 0) return;
  posicionCursor = [evento.lngLat.lng, evento.lngLat.lat];
  pintarDibujo();
});

mapa.on('dblclick', (evento) => {
  if (!modo || modo === 'punto') return;
  evento.preventDefault();
  finalizarDibujo();
});

function geometriaActual(incluirCursor) {
  const puntos = incluirCursor && posicionCursor ? [...vertices, posicionCursor] : [...vertices];
  if (modo === 'punto' || puntos.length === 1) {
    return puntos.length ? { type: 'Point', coordinates: puntos[0] } : null;
  }
  if (modo === 'poligono' && puntos.length >= 3) {
    return { type: 'Polygon', coordinates: [[...puntos, puntos[0]]] };
  }
  if (puntos.length >= 2) return { type: 'LineString', coordinates: puntos };
  return null;
}

function pintarDibujo() {
  const fuente = mapa.getSource('dibujo');
  if (!fuente) return;

  const coleccion = coleccionVacia();
  const geometria = geometriaActual(true);
  if (geometria) coleccion.features.push({ type: 'Feature', geometry: geometria, properties: {} });
  vertices.forEach((v) =>
    coleccion.features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: v }, properties: {} }));
  fuente.setData(coleccion);

  actualizarMedicion();
}

function actualizarMedicion() {
  const panel = $('medicion');
  if (!modo || vertices.length === 0) { panel.classList.remove('visible'); return; }

  const puntos = posicionCursor ? [...vertices, posicionCursor] : vertices;
  const esPoligono = modo === 'poligono' && puntos.length >= 3;

  $('med-longitud').textContent = formatearLongitud(
    longitudDe(esPoligono ? [...puntos, puntos[0]] : puntos));
  $('med-area').textContent = formatearArea(esPoligono ? areaDe(puntos) : 0);
  $('med-vertices').textContent = String(vertices.length);
  panel.classList.add('visible');
}

// ---------------------------------------------------------------------------
// Modal de atributos
// ---------------------------------------------------------------------------
let geometriaPendiente = null;

function finalizarDibujo() {
  const minimo = modo === 'punto' ? 1 : modo === 'linea' ? 2 : 3;
  if (vertices.length < minimo) { avisar(`Faltan vertices (minimo ${minimo}).`, true); return; }

  posicionCursor = null;
  geometriaPendiente = geometriaActual(false);
  if (!geometriaPendiente) { avisar('No se pudo construir la geometria.', true); return; }

  $('pares').innerHTML = '';
  $('attr-nombre').value = '';
  $('telon-atributos').classList.add('visible');
  $('attr-nombre').focus();
}

$('agregar-par').onclick = () => {
  const fila = document.createElement('div');
  fila.className = 'par';
  fila.innerHTML = '<input type="text" placeholder="Atributo"><input type="text" placeholder="Valor">' +
                   '<button type="button" aria-label="Quitar atributo">&times;</button>';
  fila.querySelector('button').onclick = () => fila.remove();
  $('pares').appendChild(fila);
  fila.querySelector('input').focus();
};

$('descartar-elemento').onclick = () => {
  $('telon-atributos').classList.remove('visible');
  geometriaPendiente = null;
  activarModo(null);
};

$('guardar-elemento').onclick = async () => {
  if (!geometriaPendiente) return;

  const propiedades = {};
  $('pares').querySelectorAll('.par').forEach((fila) => {
    const [clave, valor] = fila.querySelectorAll('input');
    if (clave.value.trim()) propiedades[clave.value.trim()] = valor.value;
  });

  try {
    await api('/api/features', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nombre: $('attr-nombre').value.trim() || null,
        capa_id: Number($('attr-capa').value) || null,
        propiedades,
        geometria: geometriaPendiente
      })
    });
    avisar('Elemento guardado.');
    $('telon-atributos').classList.remove('visible');
    geometriaPendiente = null;
    activarModo(null);
    refrescarDatos();
    cargarCapas();
  } catch (error) {
    avisar(error.message, true);
  }
};

// ---------------------------------------------------------------------------
// Ficha de un elemento existente
// ---------------------------------------------------------------------------
function mostrarFicha(evento) {
  if (modo) return;
  const rasgo = evento.features && evento.features[0];
  if (!rasgo) return;

  const props = rasgo.properties || {};
  let extra = {};
  try { extra = JSON.parse(props.propiedades || '{}'); } catch { /* sin atributos */ }

  const filas = Object.entries(extra)
    .map(([clave, valor]) => `<tr><td style="color:#93a1b1;padding-right:10px">${escapar(clave)}</td>
                                  <td>${escapar(String(valor))}</td></tr>`)
    .join('');

  const html = `
    <div style="font-family:system-ui;font-size:13px;min-width:190px">
      <strong>${escapar(props.nombre || 'Sin nombre')}</strong>
      <div style="font-family:ui-monospace,monospace;font-size:10.5px;color:#93a1b1;margin:3px 0 8px">
        ID ${props.id}
      </div>
      ${filas ? `<table style="border-collapse:collapse;margin-bottom:9px">${filas}</table>` : ''}
      <button id="borrar-${props.id}"
        style="font:inherit;font-size:12px;background:#fff;color:#c0271a;border:1px solid #e5b4ae;
               border-radius:4px;padding:5px 9px;cursor:pointer">Eliminar</button>
    </div>`;

  const ficha = new maplibregl.Popup({ closeButton: true, maxWidth: '280px' })
    .setLngLat(evento.lngLat)
    .setHTML(html)
    .addTo(mapa);

  setTimeout(() => {
    const boton = document.getElementById(`borrar-${props.id}`);
    if (!boton) return;
    boton.onclick = async () => {
      if (!confirm('¿Eliminar este elemento? No se puede deshacer.')) return;
      try {
        await api(`/api/features/${props.id}`, { method: 'DELETE' });
        ficha.remove();
        avisar('Elemento eliminado.');
        refrescarDatos();
        cargarCapas();
      } catch (error) { avisar(error.message, true); }
    };
  }, 0);
}

function escapar(texto) {
  const div = document.createElement('div');
  div.textContent = texto;
  return div.innerHTML;
}

// ---------------------------------------------------------------------------
// Capas
// ---------------------------------------------------------------------------
let capas = [];
const capasOcultas = new Set();

async function cargarCapas() {
  try {
    capas = await api('/api/capas');
  } catch { return; }

  $('lista-capas').innerHTML = '';
  const selector = $('attr-capa');
  const seleccionada = selector.value;
  selector.innerHTML = '';

  capas.forEach((capa) => {
    const fila = document.createElement('label');
    fila.className = 'capa';
    fila.innerHTML = `
      <input type="checkbox" ${capasOcultas.has(capa.id) ? '' : 'checked'}>
      <span class="punto-color" style="background:${escapar(capa.color)}"></span>
      <span class="nombre">${escapar(capa.nombre)}</span>
      <span class="conteo">${capa.total}</span>`;
    fila.querySelector('input').onchange = (evento) => {
      if (evento.target.checked) capasOcultas.delete(capa.id); else capasOcultas.add(capa.id);
      aplicarVisibilidad();
    };
    $('lista-capas').appendChild(fila);

    const opcion = document.createElement('option');
    opcion.value = capa.id;
    opcion.textContent = capa.nombre;
    selector.appendChild(opcion);
  });

  if (seleccionada) selector.value = seleccionada;
}

function aplicarVisibilidad() {
  // El filtro se aplica en el cliente sobre las teselas ya descargadas, asi
  // que ocultar y mostrar capas es instantaneo y no pide nada al servidor.
  const ocultas = [...capasOcultas];
  const visible = ocultas.length
    ? ['!', ['in', ['get', 'capa_id'], ['literal', ocultas]]]
    : true;

  const combinar = (base) => ocultas.length ? ['all', base, visible] : base;
  mapa.setFilter('datos-poligono', combinar(ES_POLIGONO));
  mapa.setFilter('datos-poligono-borde', combinar(ES_POLIGONO));
  mapa.setFilter('datos-linea', combinar(ES_LINEA));
  mapa.setFilter('datos-punto', combinar(ES_PUNTO));
}

$('refrescar').onclick = () => { refrescarDatos(); cargarCapas(); avisar('Datos actualizados.'); };

// ---------------------------------------------------------------------------
// Mapa base
// ---------------------------------------------------------------------------
function cambiarBase(cual) {
  mapa.setLayoutProperty('base-calles', 'visibility', cual === 'calles' ? 'visible' : 'none');
  mapa.setLayoutProperty('base-satelite', 'visibility', cual === 'satelite' ? 'visible' : 'none');
  $('base-calles').setAttribute('aria-pressed', String(cual === 'calles'));
  $('base-satelite').setAttribute('aria-pressed', String(cual === 'satelite'));
}
$('base-calles').onclick = () => cambiarBase('calles');
$('base-satelite').onclick = () => cambiarBase('satelite');

// ---------------------------------------------------------------------------
// Cargar y descargar
// ---------------------------------------------------------------------------
$('subir').onclick = async () => {
  const archivo = $('archivo').files[0];
  const nombre = $('nombre-capa').value.trim();
  if (!archivo) { avisar('Elige un archivo GeoJSON.', true); return; }
  if (!nombre) { avisar('Ponle nombre a la capa.', true); return; }

  const boton = $('subir');
  boton.disabled = true;
  boton.textContent = 'Cargando…';

  const cuerpo = new FormData();
  cuerpo.append('archivo', archivo);
  cuerpo.append('nombre_capa', nombre);
  cuerpo.append('color', '#457b9d');

  try {
    const resultado = await api('/api/upload/vector', { method: 'POST', body: cuerpo });
    avisar(`Cargadas ${resultado.insertados} entidades` +
           (resultado.omitidos ? ` · ${resultado.omitidos} omitidas` : '') + '.');
    $('archivo').value = '';
    $('nombre-capa').value = '';
    refrescarDatos();
    cargarCapas();
  } catch (error) {
    avisar(error.message, true);
  }

  boton.disabled = false;
  boton.textContent = 'Cargar al visor';
};

function descargar(srid) {
  const enlace = document.createElement('a');
  enlace.href = `/api/export/geojson?srid=${srid}`;
  enlace.download = '';
  document.body.appendChild(enlace);
  enlace.click();
  enlace.remove();
  avisar(srid === 9377 ? 'Descargando GeoJSON oficial (EPSG:9377).' : 'Descargando GeoJSON WGS84.');
}
$('exportar-9377').onclick = () => descargar(9377);
$('exportar-4326').onclick = () => descargar(4326);

// ---------------------------------------------------------------------------
// Rail y sesion
// ---------------------------------------------------------------------------
$('alternar').onclick = () => $('rail').classList.toggle('oculto');

$('salir').onclick = async () => {
  await fetch('/api/logout', { method: 'POST' });
  location.href = '/login.html';
};

document.addEventListener('keydown', (evento) => {
  if (evento.key !== 'Escape') return;
  if ($('telon-atributos').classList.contains('visible')) $('descartar-elemento').click();
  else if (modo) activarModo(null);
});

// Comprobacion de sesion antes de mostrar nada.
(async () => {
  try {
    const sesion = await api('/api/session');
    $('quien').textContent = sesion.autor || 'sin identificar';
    if (window.innerWidth <= 720) $('rail').classList.add('oculto');
  } catch { /* api() ya redirigio al login */ }
})();
