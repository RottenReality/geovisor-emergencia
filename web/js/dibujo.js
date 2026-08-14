/* Herramientas de dibujo y medicion en vivo.
 *
 * Implementadas directamente sobre MapLibre en lugar de usar Mapbox GL Draw:
 * esa libreria es de Mapbox y su compatibilidad con MapLibre depende de
 * parches fragiles. Aqui son unas pocas decenas de lineas y no hay dependencia
 * que se pueda romper en el peor momento.
 */

import { api, avisar, longitudDe, areaDe, formatearArea, formatearLongitud, escapar, $ } from './util.js';
import { mapa, coleccionVacia, refrescarDatos } from './mapa.js';
import { capasVectoriales, asegurarVisible } from './capas.js';

let modo = null;          // null | 'punto' | 'linea' | 'poligono'
let vertices = [];
let posicionCursor = null;
let geometriaPendiente = null;
let alGuardar = () => {};

// Memoria de la sesion de digitalizacion. Mapear 80 manzanas afectadas
// significa repetir la misma capa y casi los mismos atributos 80 veces; sin
// esto, cada elemento cuesta cinco clics de mas.
let ultimasPropiedades = null;
let ultimoNombre = '';
let enSesion = 0;

export function alGuardarElemento(fn) { alGuardar = fn; }
export const dibujando = () => modo !== null;

const BOTONES = {};

export function inicializar() {
  BOTONES.punto = $('dibujar-punto');
  BOTONES.linea = $('dibujar-linea');
  BOTONES.poligono = $('dibujar-poligono');

  BOTONES.punto.onclick = () => activar('punto');
  BOTONES.linea.onclick = () => activar('linea');
  BOTONES.poligono.onclick = () => activar('poligono');
  $('cancelar').onclick = () => { enSesion = 0; mostrarContador(); activar(null); };
  $('finalizar').onclick = () => finalizar();

  mapa.on('click', alHacerClic);
  mapa.on('mousemove', alMover);
  mapa.on('dblclick', alDobleClic);

  $('agregar-par').onclick = agregarPar;
  $('descartar-elemento').onclick = descartar;
  $('guardar-elemento').onclick = guardar;

  // Enter guarda: con el modal abierto no hace falta soltar el raton.
  $('telon-atributos').addEventListener('keydown', (evento) => {
    if (evento.key === 'Enter' && !evento.shiftKey) {
      evento.preventDefault();
      guardar();
    }
  });

  refrescarDestinos();
  document.addEventListener('capas:cambiadas', refrescarDestinos);
}

/** Rellena el selector de capa destino conservando la eleccion actual. */
export function refrescarDestinos() {
  const selector = $('capa-destino');
  if (!selector) return;
  const elegida = selector.value;
  const capas = capasVectoriales();

  selector.innerHTML = capas.length
    ? capas.map((c) => `<option value="${c.id}">${escapar(c.nombre)}</option>`).join('')
    : '<option value="">Crea una capa primero</option>';

  if (elegida && capas.some((c) => String(c.id) === elegida)) selector.value = elegida;
}

const capaDestino = () => {
  const selector = $('capa-destino');
  const capa = capasVectoriales().find((c) => String(c.id) === selector.value);
  return capa || null;
};

function mostrarContador() {
  const nodo = $('contador-sesion');
  nodo.hidden = enSesion === 0;
  nodo.innerHTML = enSesion
    ? `<strong>${enSesion}</strong> elemento${enSesion === 1 ? '' : 's'} en esta tanda.`
    : '';
}

export function activar(nuevo) {
  modo = modo === nuevo ? null : nuevo;
  vertices = [];
  posicionCursor = null;

  for (const [clave, boton] of Object.entries(BOTONES)) {
    boton.setAttribute('aria-pressed', String(clave === modo));
  }
  $('finalizar').disabled = true;
  $('cancelar').disabled = !modo;
  mapa.getCanvas().style.cursor = modo ? 'crosshair' : '';
  // Sin esto, el doble clic para cerrar la geometria haria zoom.
  if (modo) mapa.doubleClickZoom.disable(); else mapa.doubleClickZoom.enable();

  pintar();
  if (!modo) return;

  const destino = capaDestino();
  if (!destino) { avisar('Elige o crea una capa donde guardar.', true); return; }

  // Si la capa destino esta apagada, se enciende: dibujar en una capa
  // invisible guarda el elemento pero no lo muestra, y eso se lee como que
  // el visor no funciona.
  asegurarVisible(destino.id).then((encendida) => {
    if (encendida) avisar(`Se encendió «${encendida}» para que veas lo que dibujas.`);
    else avisar(modo === 'punto'
      ? `Toca el mapa para ubicar el punto en «${destino.nombre}».`
      : `Toca para agregar vértices en «${destino.nombre}». Doble toque para cerrar.`);
  });
}

function alHacerClic(evento) {
  if (!modo) return;
  vertices.push([evento.lngLat.lng, evento.lngLat.lat]);
  if (modo === 'punto') { finalizar(); return; }
  $('finalizar').disabled = vertices.length < (modo === 'poligono' ? 3 : 2);
  pintar();
}

function alMover(evento) {
  if (!modo || modo === 'punto' || vertices.length === 0) return;
  posicionCursor = [evento.lngLat.lng, evento.lngLat.lat];
  pintar();
}

function alDobleClic(evento) {
  if (!modo || modo === 'punto') return;
  evento.preventDefault();
  finalizar();
}

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

function pintar() {
  const fuente = mapa.getSource('dibujo');
  if (!fuente) return;

  const coleccion = coleccionVacia();
  const geometria = geometriaActual(true);
  if (geometria) coleccion.features.push({ type: 'Feature', geometry: geometria, properties: {} });
  for (const v of vertices) {
    coleccion.features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: v }, properties: {} });
  }
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

function finalizar() {
  const minimo = modo === 'punto' ? 1 : modo === 'linea' ? 2 : 3;
  if (vertices.length < minimo) { avisar(`Faltan vértices (mínimo ${minimo}).`, true); return; }

  const destino = capaDestino();
  if (!destino) { avisar('Elige o crea una capa donde guardar.', true); return; }

  posicionCursor = null;
  geometriaPendiente = geometriaActual(false);
  if (!geometriaPendiente) { avisar('No se pudo construir la geometría.', true); return; }

  // Sin preguntar solo tiene sentido cuando ya hay algo que repetir: la
  // primera vez siempre se abre el modal para que haya que repetir.
  if ($('sin-preguntar').checked && ultimasPropiedades) {
    guardar({ directo: true });
    return;
  }

  $('attr-destino').textContent = destino.nombre;
  $('pares').innerHTML = '';

  const mantener = $('mantener-atributos').checked && ultimasPropiedades;
  $('attr-nombre').value = mantener ? ultimoNombre : '';
  if (mantener) {
    for (const [clave, valor] of Object.entries(ultimasPropiedades)) agregarPar(clave, valor);
  }

  $('telon-atributos').classList.add('visible');
  $('attr-nombre').focus();
  $('attr-nombre').select();
}

function agregarPar(clave = '', valor = '') {
  const fila = document.createElement('div');
  fila.className = 'par';
  fila.innerHTML = '<input type="text" placeholder="Atributo"><input type="text" placeholder="Valor">' +
                   '<button type="button" aria-label="Quitar atributo">&times;</button>';
  const [campoClave, campoValor] = fila.querySelectorAll('input');
  campoClave.value = clave;
  campoValor.value = valor;
  fila.querySelector('button').onclick = () => fila.remove();
  $('pares').appendChild(fila);
  if (!clave) campoClave.focus();
  return fila;
}

function descartar() {
  $('telon-atributos').classList.remove('visible');
  geometriaPendiente = null;
  activar(null);
}

async function guardar({ directo = false } = {}) {
  if (!geometriaPendiente) return;

  const destino = capaDestino();
  if (!destino) { avisar('Elige una capa donde guardar.', true); return; }

  let propiedades;
  let nombre;
  if (directo) {
    propiedades = ultimasPropiedades || {};
    nombre = ultimoNombre || null;
  } else {
    propiedades = {};
    for (const fila of $('pares').querySelectorAll('.par')) {
      const [clave, valor] = fila.querySelectorAll('input');
      if (clave.value.trim()) propiedades[clave.value.trim()] = valor.value;
    }
    nombre = $('attr-nombre').value.trim() || null;
  }

  // El modo que estaba activo, para volver a armarlo tras guardar.
  const modoPrevio = modo;

  try {
    await api('/api/features', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nombre,
        capa_id: destino.id,
        propiedades,
        geometria: geometriaPendiente,
      }),
    });
  } catch (error) {
    avisar(error.message, true);
    return;
  }

  ultimasPropiedades = propiedades;
  ultimoNombre = nombre || '';
  enSesion += 1;
  mostrarContador();

  $('telon-atributos').classList.remove('visible');
  geometriaPendiente = null;
  refrescarDatos();
  alGuardar();

  // Digitalizacion en cadena: la herramienta se rearma sola con la misma
  // capa, de modo que dibujar el siguiente elemento es dibujar y ya.
  activar(null);
  if (modoPrevio) {
    activar(modoPrevio);
    avisar(`Guardado (${enSesion}). Sigue dibujando.`);
  } else {
    avisar('Elemento guardado.');
  }
}

export function hayModal() {
  return $('telon-atributos').classList.contains('visible');
}
export { descartar as cerrarModal };
