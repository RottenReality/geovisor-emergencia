/* Herramientas de dibujo y medicion en vivo.
 *
 * Implementadas directamente sobre MapLibre en lugar de usar Mapbox GL Draw:
 * esa libreria es de Mapbox y su compatibilidad con MapLibre depende de
 * parches fragiles. Aqui son unas pocas decenas de lineas y no hay dependencia
 * que se pueda romper en el peor momento.
 */

import { api, avisar, longitudDe, areaDe, formatearArea, formatearLongitud, escapar, $ } from './util.js';
import { mapa, coleccionVacia, refrescarDatos } from './mapa.js';
import { capasVectoriales } from './capas.js';

let modo = null;          // null | 'punto' | 'linea' | 'poligono'
let vertices = [];
let posicionCursor = null;
let geometriaPendiente = null;
let alGuardar = () => {};

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
  $('cancelar').onclick = () => activar(null);
  $('finalizar').onclick = () => finalizar();

  mapa.on('click', alHacerClic);
  mapa.on('mousemove', alMover);
  mapa.on('dblclick', alDobleClic);

  $('agregar-par').onclick = agregarPar;
  $('descartar-elemento').onclick = descartar;
  $('guardar-elemento').onclick = guardar;
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
  if (modo) {
    avisar(modo === 'punto'
      ? 'Toca el mapa para ubicar el punto.'
      : 'Toca para agregar vértices. Doble toque o «Finalizar» para cerrar.');
  }
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

  posicionCursor = null;
  geometriaPendiente = geometriaActual(false);
  if (!geometriaPendiente) { avisar('No se pudo construir la geometría.', true); return; }

  const selector = $('attr-capa');
  selector.innerHTML = capasVectoriales()
    .map((c) => `<option value="${c.id}">${escapar(c.nombre)}</option>`).join('');

  $('pares').innerHTML = '';
  $('attr-nombre').value = '';
  $('telon-atributos').classList.add('visible');
  $('attr-nombre').focus();
}

function agregarPar() {
  const fila = document.createElement('div');
  fila.className = 'par';
  fila.innerHTML = '<input type="text" placeholder="Atributo"><input type="text" placeholder="Valor">' +
                   '<button type="button" aria-label="Quitar atributo">&times;</button>';
  fila.querySelector('button').onclick = () => fila.remove();
  $('pares').appendChild(fila);
  fila.querySelector('input').focus();
}

function descartar() {
  $('telon-atributos').classList.remove('visible');
  geometriaPendiente = null;
  activar(null);
}

async function guardar() {
  if (!geometriaPendiente) return;

  const propiedades = {};
  for (const fila of $('pares').querySelectorAll('.par')) {
    const [clave, valor] = fila.querySelectorAll('input');
    if (clave.value.trim()) propiedades[clave.value.trim()] = valor.value;
  }

  try {
    await api('/api/features', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nombre: $('attr-nombre').value.trim() || null,
        capa_id: Number($('attr-capa').value) || null,
        propiedades,
        geometria: geometriaPendiente,
      }),
    });
    avisar('Elemento guardado.');
    $('telon-atributos').classList.remove('visible');
    geometriaPendiente = null;
    activar(null);
    refrescarDatos();
    alGuardar();
  } catch (error) {
    avisar(error.message, true);
  }
}

export function hayModal() {
  return $('telon-atributos').classList.contains('visible');
}
export { descartar as cerrarModal };
