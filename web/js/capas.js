/* Panel de capas, en dos grupos: imagenes debajo, dibujo encima.
 *
 * Los vectores van SIEMPRE por encima de las imagenes, porque se dibuja sobre
 * la ortofoto y nunca al reves. Fijarlo asi no quita libertad: elimina la
 * pregunta de si tal raster va antes o despues de tal capa de puntos, y deja
 * el reordenamiento donde de verdad importa, que es dentro de cada grupo.
 */

import { api, avisar, escapar, $ } from './util.js';
import { sincronizarCapas, aplicarEstilos, encuadrar, refrescarDatos, olvidarRaster } from './mapa.js';

/** Lista completa, del fondo al frente: primero imagenes, luego dibujo. */
export let items = [];

let expandida = null;
let sondeo = null;

const GRUPOS = [
  { clave: 'raster', titulo: 'Imágenes', vacio: 'Sin imágenes cargadas.' },
  { clave: 'vector', titulo: 'Dibujo',   vacio: 'Sin capas de dibujo.' },
];

const grupoDe = (item) => (item.esRaster ? 'raster' : 'vector');

/** Grupos apagados enteros. Es una vista local, no se guarda en el servidor. */
const gruposOcultos = new Set();

const plegados = new Set(
  JSON.parse(localStorage.getItem('geovisor.plegados') || '[]'));
const guardarPlegados = () =>
  localStorage.setItem('geovisor.plegados', JSON.stringify([...plegados]));

/** Visibilidad real: la de la capa, apagada si su grupo esta apagado. */
const efectivo = (item) => ({
  ...item,
  visible: item.visible && !gruposOcultos.has(grupoDe(item)),
});

export async function cargar() {
  const [capas, rasters] = await Promise.all([
    api('/api/capas').catch(() => []),
    api('/api/rasters').catch(() => []),
  ]);

  const porOrden = (a, b) => (a.orden ?? 0) - (b.orden ?? 0);
  items = [
    ...rasters.map((r) => ({ ...r, esRaster: true })).sort(porOrden),
    ...capas.map((c) => ({ ...c, esRaster: false })).sort(porOrden),
  ];

  pintar();
  sincronizarCapas(
    items.filter((i) => !i.esRaster || i.estado === 'listo').map(efectivo));
  vigilarConversiones();
  // Quien dependa de la lista de capas (el selector de destino al dibujar) se
  // entera por aqui, sin que este modulo tenga que conocerlo.
  document.dispatchEvent(new CustomEvent('capas:cambiadas'));
}

/** Devuelve el mapa a la visibilidad real de las capas.
 *  Lo usa la comparacion al cerrarse, tras haber ocultado el resto. */
export const reaplicarEstilos = () => aplicarEstilos(items.map(efectivo));

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

  if (!items.length) {
    lista.innerHTML = '<p class="vacio">Aún no hay capas. Crea una o carga un archivo.</p>';
    return;
  }

  // Los grupos se pintan de arriba abajo igual que se ven en el mapa: el
  // dibujo encima de las imagenes.
  for (const grupo of [...GRUPOS].reverse()) {
    const delGrupo = items.filter((i) => grupoDe(i) === grupo.clave);
    const plegado = plegados.has(grupo.clave);
    const apagado = gruposOcultos.has(grupo.clave);

    const cabecera = document.createElement('div');
    cabecera.className = 'grupo-cabecera' + (plegado ? ' plegado' : '');
    cabecera.innerHTML = `
      <button class="chevron" aria-expanded="${!plegado}"
              aria-label="${plegado ? 'Desplegar' : 'Plegar'} ${grupo.titulo}">&#9662;</button>
      <input type="checkbox" ${apagado ? '' : 'checked'}
             aria-label="Mostrar todo el grupo ${grupo.titulo}">
      <span class="titulo">${grupo.titulo}</span>
      <span class="conteo">${delGrupo.length}</span>`;

    cabecera.querySelector('.chevron').onclick = () => {
      if (plegado) plegados.delete(grupo.clave); else plegados.add(grupo.clave);
      guardarPlegados();
      pintar();
    };
    cabecera.querySelector('input').onchange = (evento) => {
      if (evento.target.checked) gruposOcultos.delete(grupo.clave);
      else gruposOcultos.add(grupo.clave);
      aplicarEstilos(items.map(efectivo));
      pintar();
    };
    lista.appendChild(cabecera);

    if (plegado) continue;

    const cuerpo = document.createElement('div');
    cuerpo.className = 'grupo-cuerpo';
    if (!delGrupo.length) {
      cuerpo.innerHTML = `<p class="vacio">${grupo.vacio}</p>`;
    } else {
      // Dentro del grupo tambien se pinta de frente a fondo: arriba en la
      // lista = encima en el mapa, como en QGIS o ArcGIS.
      [...delGrupo].reverse().forEach((item, indice, arreglo) =>
        cuerpo.appendChild(pintarFila(item, indice, arreglo.length, apagado)));
    }
    lista.appendChild(cuerpo);
  }
}

function pintarFila(item, indice, total, grupoApagado) {
  const clave = `${item.esRaster ? 'r' : 'c'}${item.id}`;
  const estado = ESTADOS[item.estado];
  const fila = document.createElement('div');
  fila.className = 'capa-fila' + (expandida === clave ? ' abierta' : '')
                               + (grupoApagado ? ' atenuada' : '');

  fila.innerHTML = `
      <div class="capa-cabecera">
        <input type="checkbox" ${item.visible ? 'checked' : ''}
               aria-label="Mostrar ${escapar(item.nombre)}">
        <span class="punto-color" style="background:${item.esRaster ? 'transparent' : escapar(item.color)};
              ${item.esRaster ? 'border:1px solid var(--papel-2)' : ''}"></span>
        <span class="nombre" title="${escapar(item.nombre)}">${escapar(item.nombre)}</span>
        ${estado ? `<span class="estado ${estado[1]}">${estado[0]}</span>`
                 : `<span class="conteo">${item.esRaster ? 'ráster' : item.total}</span>`}
        <button class="icono" data-accion="subir"    ${indice === 0 ? 'disabled' : ''}
                title="Traer al frente" aria-label="Traer al frente">&uarr;</button>
        <button class="icono" data-accion="bajar"    ${indice === total - 1 ? 'disabled' : ''}
                title="Enviar atrás" aria-label="Enviar atrás">&darr;</button>
        <button class="icono" data-accion="expandir" title="Opciones" aria-label="Opciones">&#8942;</button>
      </div>
      <div class="capa-detalle">
        ${item.estado === 'error' ? `<p class="error-texto">${escapar(item.mensaje || 'Falló la conversión')}</p>` : ''}
        <label>Opacidad <output>${Math.round((item.opacidad ?? 1) * 100)}%</output></label>
        <input type="range" min="0" max="100" value="${Math.round((item.opacidad ?? 1) * 100)}"
               data-accion="opacidad">
        ${item.esRaster ? (item.num_bandas > 1 ? `
          <label>Combinación de bandas (${item.num_bandas} bandas)</label>
          <select data-accion="combinacion">
            <option value="natural" ${item.combinacion === 'natural' ? 'selected' : ''}>
              ${item.tiene_visible ? 'Color natural' : 'Predeterminada'}</option>
            ${item.admite_infrarrojo ? `<option value="infrarrojo" ${item.combinacion === 'infrarrojo' ? 'selected' : ''}>Falso color (infrarrojo)</option>` : ''}
            ${item.admite_swir ? `<option value="swir" ${item.combinacion === 'swir' ? 'selected' : ''}>SWIR (suelo y humedad)</option>` : ''}
            <option value="gris" ${item.combinacion === 'gris' ? 'selected' : ''}>Una banda en gris</option>
          </select>
          ${item.tiene_visible ? '' :
            '<p class="nota">Sin bandas visibles: se muestra una composición SWIR/NIR, útil para suelo desnudo y humedad.</p>'}` : '') : `
          <label>Color</label>
          <input type="color" value="${escapar(item.color)}" data-accion="color">`}
        <div class="fila">
          <button data-accion="encuadrar">Ir a la capa</button>
          <button data-accion="renombrar">Renombrar</button>
        </div>
        <button data-accion="borrar" class="peligro">Eliminar capa</button>
      </div>`;

  fila.querySelector('input[type=checkbox]').onchange = (e) =>
    actualizar(item, { visible: e.target.checked });

  fila.querySelectorAll('[data-accion]').forEach((control) => {
    const accion = control.dataset.accion;
    if (accion === 'opacidad') {
      control.oninput = (e) => {
        const valor = Number(e.target.value) / 100;
        item.opacidad = valor;
        fila.querySelector('output').textContent = `${e.target.value}%`;
        aplicarEstilos([efectivo(item)]);
      };
      control.onchange = (e) => actualizar(item, { opacidad: Number(e.target.value) / 100 }, false);
    } else if (accion === 'color') {
      control.onchange = (e) => actualizar(item, { color: e.target.value });
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

async function manejar(accion, item, clave) {
  switch (accion) {
    case 'expandir':
      expandida = expandida === clave ? null : clave;
      pintar();
      break;

    case 'encuadrar':
      if (item.esRaster) encuadrar(item.bounds);
      else if (item.extension) encuadrar(item.extension);
      else avisar('Esa capa aún no tiene elementos.');
      break;

    case 'renombrar': {
      const nombre = prompt('Nuevo nombre de la capa:', item.nombre);
      if (nombre && nombre.trim()) await actualizar(item, { nombre: nombre.trim() });
      break;
    }

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

    case 'subir':
    case 'bajar':
      await intercambiar(item, accion === 'subir' ? 1 : -1);
      break;
  }
}

/** Intercambia el orden con la capa vecina DENTRO de su grupo.
 *  Solo dos peticiones, no toda la lista. */
async function intercambiar(item, direccion) {
  const hermanas = items.filter((i) => grupoDe(i) === grupoDe(item));
  const posicion = hermanas.findIndex((i) => i.id === item.id);
  const vecina = hermanas[posicion + direccion];
  if (!vecina) return;   // ya esta en el borde de su grupo

  const ordenItem = item.orden ?? posicion + 1;
  const ordenVecina = vecina.orden ?? posicion + 1 + direccion;

  try {
    await Promise.all([
      api(`/api/${item.esRaster ? 'rasters' : 'capas'}/${item.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orden: ordenVecina }),
      }),
      api(`/api/${vecina.esRaster ? 'rasters' : 'capas'}/${vecina.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orden: ordenItem }),
      }),
    ]);
    await cargar();
  } catch (error) { avisar(error.message, true); }
}

async function actualizar(item, cambios, recargar = true) {
  Object.assign(item, cambios);
  aplicarEstilos([efectivo(item)]);
  try {
    await api(`/api/${item.esRaster ? 'rasters' : 'capas'}/${item.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cambios),
    });
    if (recargar && ('nombre' in cambios || 'color' in cambios)) await cargar();
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
