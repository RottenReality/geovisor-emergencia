/* Tabla de atributos.
 *
 * Era lo unico que el equipo echaba de menos frente a otros visores: poder
 * mirar los datos como una tabla y no de uno en uno haciendo clic en el mapa.
 *
 * Va abajo y no en una ventana con telon como el resto de los cuadros del
 * visor, y es a proposito: una tabla de atributos se usa MIRANDO el mapa -se
 * busca una fila, se salta al sitio, se compara con la imagen-, asi que
 * taparlo la volveria inutil. Se puede estirar y se cierra con Escape.
 *
 * De donde salen los datos depende de la capa:
 *   - capa propia: el servidor pagina, busca y ordena (`/api/capas/{id}/tabla`),
 *     porque una capa de manzanas tiene cientos de miles de filas.
 *   - fuente externa: su GeoJSON ya esta descargado y tiene un tope de 8.000
 *     entidades, asi que se pagina aqui y no se le pide nada mas al servidor.
 */

import { api, avisar, escapar, $ } from './util.js';
import { encuadrar } from './mapa.js';
import * as ficha from './ficha.js';
import * as externas from './externas.js';

const POR_PAGINA = 100;

let item = null;          // capa que se esta mirando
let columnas = [];
let filas = [];           // pagina en pantalla, ya normalizada
let todas = null;         // solo externas: el GeoJSON entero
let total = 0;
let pagina = 0;
let buscar = '';
let orden = '';
let descendente = false;
let reloj = null;         // antirrebote del buscador

export const estaAbierta = () => item !== null;

export function cerrar() {
  item = null;
  todas = null;
  $('tabla').hidden = true;
  ajustarHueco();
}

/** Le dice al resto de la interfaz cuanto sitio ocupa la tabla.
 *  La leyenda y las coordenadas se suben encima en vez de quedar tapadas. */
function ajustarHueco() {
  const panel = $('tabla');
  const abierta = !panel.hidden;
  document.body.classList.toggle('con-tabla', abierta);
  document.body.style.setProperty('--tabla-alto',
    `${abierta ? Math.round(panel.getBoundingClientRect().height) : 0}px`);
}

export async function abrir(capa) {
  const nueva = !item || item.id !== capa.id || item.esExterna !== capa.esExterna;
  item = capa;
  if (nueva) {
    pagina = 0; buscar = ''; orden = ''; descendente = false; todas = null;
  }

  $('tabla').hidden = false;
  ajustarHueco();
  $('tabla-titulo').textContent = capa.nombre;
  $('tabla-buscar').value = buscar;
  await recargar();
}

// ---------------------------------------------------------------------------
// Datos
// ---------------------------------------------------------------------------
async function recargar() {
  const mirando = item;
  $('tabla-cuerpo').setAttribute('aria-busy', 'true');
  try {
    if (item.esExterna) await deLaFuenteExterna();
    else await delServidor();
  } catch (error) {
    avisar(error.message, true);
    columnas = []; filas = []; total = 0;
  }
  // Si mientras se pedia se abrio otra capa, esta respuesta ya no vale.
  if (item !== mirando) return;
  $('tabla-cuerpo').removeAttribute('aria-busy');
  pintar();
}

async function delServidor() {
  const parametros = new URLSearchParams({
    pagina, limite: POR_PAGINA, buscar, orden,
    descendente: descendente ? 'true' : 'false',
  });
  const datos = await api(`/api/capas/${item.id}/tabla?${parametros}`);
  columnas = ['id', 'nombre', ...datos.columnas];
  total = datos.total;
  filas = datos.filas.map((f) => ({
    id: f.id,
    caja: f.caja,
    valores: { id: f.id, nombre: f.nombre, ...f.propiedades },
  }));
}

/** La fuente externa se pagina aqui: su GeoJSON ya esta en la cache. */
async function deLaFuenteExterna() {
  if (!todas) {
    const datos = await api(`/api/externas/${item.id}.geojson`);
    columnas = item.fuente.campos.length
      ? [...item.fuente.campos]
      : [...new Set(datos.features.flatMap((f) => Object.keys(f.properties || {})))];
    todas = datos.features.map((elemento, i) => ({
      id: i,
      caja: cajaDe(elemento.geometry),
      valores: elemento.properties || {},
    }));
  }

  const texto = buscar.trim().toLowerCase();
  let vistas = !texto ? todas : todas.filter((f) => columnas.some(
    (c) => String(f.valores[c] ?? '').toLowerCase().includes(texto)));

  if (orden) {
    const signo = descendente ? -1 : 1;
    vistas = [...vistas].sort((a, b) => signo * comparar(a.valores[orden], b.valores[orden]));
  }
  total = vistas.length;
  filas = vistas.slice(pagina * POR_PAGINA, (pagina + 1) * POR_PAGINA);
}

/** Numeros como numeros y textos como textos; los vacios siempre al final. */
function comparar(a, b) {
  const vacioA = a === undefined || a === null || a === '';
  const vacioB = b === undefined || b === null || b === '';
  if (vacioA || vacioB) return vacioA && vacioB ? 0 : (vacioA ? 1 : -1);
  const na = Number(a);
  const nb = Number(b);
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
  return String(a).localeCompare(String(b), 'es');
}

function cajaDe(geometria) {
  if (!geometria?.coordinates) return null;
  let x1 = 180;
  let y1 = 90;
  let x2 = -180;
  let y2 = -90;
  const mirar = (c) => {
    if (typeof c[0] === 'number') {
      x1 = Math.min(x1, c[0]); x2 = Math.max(x2, c[0]);
      y1 = Math.min(y1, c[1]); y2 = Math.max(y2, c[1]);
      return;
    }
    c.forEach(mirar);
  };
  mirar(geometria.coordinates);
  return x1 <= x2 ? [x1, y1, x2, y2] : null;
}

// ---------------------------------------------------------------------------
// Pintado
// ---------------------------------------------------------------------------
/** Un valor de celda, recortado: una observacion larga no puede romper la fila. */
function celda(valor) {
  if (valor === undefined || valor === null || valor === '') return '<td class="vacia">—</td>';
  const texto = typeof valor === 'object' ? JSON.stringify(valor) : String(valor);
  const corto = texto.length > 120 ? `${texto.slice(0, 120)}…` : texto;
  return `<td title="${escapar(texto)}">${escapar(corto)}</td>`;
}

function pintar() {
  const paginas = Math.max(1, Math.ceil(total / POR_PAGINA));
  $('tabla-conteo').textContent = `${total.toLocaleString('es-CO')}${
    buscar.trim() ? ' encontrados' : ' elementos'}`;
  $('tabla-pagina').textContent = `${pagina + 1} / ${paginas}`;
  $('tabla-anterior').disabled = pagina === 0;
  $('tabla-siguiente').disabled = pagina + 1 >= paginas;

  if (!filas.length) {
    $('tabla-cuerpo').innerHTML = `<p class="vacio">${buscar.trim()
      ? 'Ningún elemento coincide con la búsqueda.'
      : 'Esta capa no tiene elementos.'}</p>`;
    return;
  }

  const flecha = (c) => (orden === c ? (descendente ? ' ↓' : ' ↑') : '');
  $('tabla-cuerpo').innerHTML = `
    <table>
      <thead><tr>${columnas.map((c) => `
        <th data-columna="${escapar(c)}" title="Ordenar por ${escapar(c)}"
            class="${orden === c ? 'ordenada' : ''}">${escapar(c)}${flecha(c)}</th>`).join('')}
      </tr></thead>
      <tbody>${filas.map((f, i) => `
        <tr data-fila="${i}" tabindex="0" title="Ir a este elemento en el mapa">
          ${columnas.map((c) => celda(f.valores[c])).join('')}
        </tr>`).join('')}
      </tbody>
    </table>`;

  $('tabla-cuerpo').querySelectorAll('th[data-columna]').forEach((th) => {
    th.onclick = () => {
      const columna = th.dataset.columna;
      descendente = orden === columna ? !descendente : false;
      orden = columna;
      pagina = 0;
      recargar();
    };
  });
  $('tabla-cuerpo').querySelectorAll('tr[data-fila]').forEach((tr) => {
    const ir = () => irAlElemento(filas[Number(tr.dataset.fila)]);
    tr.onclick = ir;
    tr.onkeydown = (evento) => { if (evento.key === 'Enter') ir(); };
  });
}

/** Salta al elemento en el mapa y abre su ficha, que es para lo que se busca. */
function irAlElemento(fila) {
  if (!fila.caja) {
    avisar('Ese elemento no tiene posición en el mapa.');
    if (!item.esExterna) ficha.abrir(fila.id);
    return;
  }
  encuadrar(fila.caja);

  if (!item.esExterna) {
    ficha.abrir(fila.id);
    return;
  }
  externas.mostrar(
    { layer: { id: `ext-${item.id}-punto` }, properties: fila.valores },
    { lng: (fila.caja[0] + fila.caja[2]) / 2, lat: (fila.caja[1] + fila.caja[3]) / 2 });
}

// ---------------------------------------------------------------------------
// Controles
// ---------------------------------------------------------------------------
export function inicializar() {
  $('tabla-cerrar').onclick = cerrar;
  $('tabla-anterior').onclick = () => { pagina -= 1; recargar(); };
  $('tabla-siguiente').onclick = () => { pagina += 1; recargar(); };
  $('tabla-buscar').oninput = (evento) => {
    // Antirrebote: sin el, cada letra de "carrera 45" son diez consultas.
    clearTimeout(reloj);
    const texto = evento.target.value;
    reloj = setTimeout(() => { buscar = texto; pagina = 0; recargar(); }, 300);
  };
  estirable();
}

/** El asa de arriba estira la tabla. Mirar diez filas o cien es otra tarea. */
function estirable() {
  const panel = $('tabla');
  const asa = $('tabla-asa');
  const guardado = Number(localStorage.getItem('geovisor.tabla-alto'));
  if (guardado) panel.style.height = `${guardado}px`;

  asa.onpointerdown = (inicio) => {
    inicio.preventDefault();
    asa.setPointerCapture(inicio.pointerId);
    const alto0 = panel.getBoundingClientRect().height;
    asa.onpointermove = (evento) => {
      const alto = Math.max(140, Math.min(window.innerHeight - 160,
        alto0 + (inicio.clientY - evento.clientY)));
      panel.style.height = `${alto}px`;
      ajustarHueco();
    };
    asa.onpointerup = () => {
      asa.onpointermove = null;
      asa.onpointerup = null;
      localStorage.setItem('geovisor.tabla-alto',
        String(Math.round(panel.getBoundingClientRect().height)));
    };
  };
}
