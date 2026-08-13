/* Panel de capas: vectoriales y rasters en una sola lista ordenable. */

import { api, avisar, escapar, $ } from './util.js';
import { sincronizarCapas, aplicarEstilos, encuadrar, refrescarDatos } from './mapa.js';

/** Lista mixta, del fondo al frente. */
export let items = [];

let expandida = null;
let sondeo = null;

export async function cargar() {
  const [capas, rasters] = await Promise.all([
    api('/api/capas').catch(() => []),
    api('/api/rasters').catch(() => []),
  ]);

  items = [
    ...capas.map((c) => ({ ...c, esRaster: false })),
    ...rasters.map((r) => ({ ...r, esRaster: true })),
  ].sort((a, b) => (a.orden ?? 0) - (b.orden ?? 0));

  pintar();
  sincronizarCapas(items.filter((i) => !i.esRaster || i.estado === 'listo'));
  vigilarConversiones();
}

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

  // Se pinta de frente a fondo: arriba en la lista = encima en el mapa, que es
  // como lo esperan quienes vienen de QGIS o ArcGIS.
  [...items].reverse().forEach((item, indice, arreglo) => {
    const clave = `${item.esRaster ? 'r' : 'c'}${item.id}`;
    const estado = ESTADOS[item.estado];
    const fila = document.createElement('div');
    fila.className = 'capa-fila' + (expandida === clave ? ' abierta' : '');

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
        <button class="icono" data-accion="bajar"    ${indice === arreglo.length - 1 ? 'disabled' : ''}
                title="Enviar atrás" aria-label="Enviar atrás">&darr;</button>
        <button class="icono" data-accion="expandir" title="Opciones" aria-label="Opciones">&#8942;</button>
      </div>
      <div class="capa-detalle">
        ${item.estado === 'error' ? `<p class="error-texto">${escapar(item.mensaje || 'Falló la conversión')}</p>` : ''}
        <label>Opacidad <output>${Math.round((item.opacidad ?? 1) * 100)}%</output></label>
        <input type="range" min="0" max="100" value="${Math.round((item.opacidad ?? 1) * 100)}"
               data-accion="opacidad">
        ${item.esRaster ? '' : `
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
          aplicarEstilos([item]);
        };
        control.onchange = (e) => actualizar(item, { opacidad: Number(e.target.value) / 100 }, false);
      } else if (accion === 'color') {
        control.onchange = (e) => actualizar(item, { color: e.target.value });
      } else {
        control.onclick = () => manejar(accion, item, clave);
      }
    });

    lista.appendChild(fila);
  });
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

/** Intercambia el orden con la capa vecina. Solo dos peticiones, no toda la lista. */
async function intercambiar(item, direccion) {
  const posicion = items.findIndex((i) => i.id === item.id && i.esRaster === item.esRaster);
  const vecina = items[posicion + direccion];
  if (!vecina) return;

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
  aplicarEstilos([item]);
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
