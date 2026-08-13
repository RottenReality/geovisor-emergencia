/* Ficha del elemento seleccionado.
 *
 * Reemplaza al globo emergente sobre el mapa: las capas oficiales traen
 * decenas de atributos (CODIGO, OBJECTID, SHAPEAREA, IDENTIFICACION...) y en
 * un globo no caben ni se leen. Aqui van en una tabla desplazable, sobre el
 * mismo fondo oscuro del resto de la interfaz.
 */

import { api, avisar, escapar, numero, formatearArea, formatearLongitud, $ } from './util.js';
import { mapa, resaltar, refrescarDatos } from './mapa.js';

let seleccionado = null;
let alBorrar = () => {};

export function alBorrarElemento(fn) { alBorrar = fn; }

/** Claves que ya se muestran en la cabecera; no se repiten en la tabla. */
const YA_MOSTRADAS = new Set(['id', 'nombre', 'capa', 'capa_id', 'autor', 'creado_en']);

export async function abrir(id) {
  try {
    const dato = await api(`/api/features/${id}`);
    seleccionado = dato;
    resaltar(id);
    pintar(dato);
    $('ficha').classList.add('visible');
  } catch (error) {
    avisar(error.message, true);
  }
}

export function cerrar() {
  seleccionado = null;
  resaltar(null);
  $('ficha').classList.remove('visible');
}

function valorLegible(valor) {
  if (valor === null || valor === undefined || valor === '') return '<span class="nulo">sin dato</span>';
  if (typeof valor === 'number') return escapar(numero(valor, Number.isInteger(valor) ? 0 : 2));
  if (typeof valor === 'boolean') return valor ? 'sí' : 'no';
  if (typeof valor === 'object') return `<code>${escapar(JSON.stringify(valor))}</code>`;
  return escapar(String(valor));
}

function pintar(dato) {
  const esArea = dato.medidas.area_m2 > 0;
  const esLinea = dato.medidas.longitud_m > 0 && !esArea;

  const medidas = [];
  if (esArea) {
    medidas.push(['Área', formatearArea(dato.medidas.area_m2)]);
    medidas.push(['Perímetro', formatearLongitud(dato.medidas.perimetro_m)]);
  } else if (esLinea) {
    medidas.push(['Longitud', formatearLongitud(dato.medidas.longitud_m)]);
  }

  const extra = Object.entries(dato.propiedades).filter(([k]) => !YA_MOSTRADAS.has(k));

  $('ficha-cuerpo').innerHTML = `
    <div class="ficha-titulo">
      <h2>${escapar(dato.nombre || 'Sin nombre')}</h2>
      <p class="ficha-meta">
        <span class="etiqueta-capa">${escapar(dato.capa || 'sin capa')}</span>
        <span>${escapar(dato.tipo_geometria)}</span>
        <span>ID ${dato.id}</span>
      </p>
    </div>

    ${medidas.length ? `
      <section class="medidas">
        <div class="medidas-rotulo">
          Medidas oficiales <span class="insignia">EPSG:9377</span>
        </div>
        <dl>
          ${medidas.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}
        </dl>
        <p class="nota">Calculadas en PostGIS sobre MAGNA-SIRGAS / Origen-Nacional.</p>
      </section>` : ''}

    <section>
      <h3>Registro</h3>
      <table class="atributos">
        <tr><td>Autor</td><td>${valorLegible(dato.autor)}</td></tr>
        <tr><td>Creado</td><td>${escapar(new Date(dato.creado_en).toLocaleString('es-CO'))}</td></tr>
      </table>
    </section>

    ${extra.length ? `
      <section>
        <h3>Atributos <span class="conteo">${extra.length}</span></h3>
        <table class="atributos">
          ${extra.map(([k, v]) => `<tr><td>${escapar(k)}</td><td>${valorLegible(v)}</td></tr>`).join('')}
        </table>
      </section>` : '<section><p class="vacio">Sin atributos adicionales.</p></section>'}

    <div class="fila ficha-acciones">
      <button id="ficha-encuadrar">Centrar en el mapa</button>
      <button id="ficha-borrar" class="peligro">Eliminar</button>
    </div>`;

  $('ficha-encuadrar').onclick = () => encuadrarGeometria(dato.geometria);
  $('ficha-borrar').onclick = () => borrar(dato);
}

function encuadrarGeometria(geometria) {
  const puntos = [];
  const recolectar = (nodo) => {
    if (Array.isArray(nodo) && typeof nodo[0] === 'number') puntos.push(nodo);
    else if (Array.isArray(nodo)) nodo.forEach(recolectar);
  };
  recolectar(geometria.coordinates);
  if (!puntos.length) return;

  const lons = puntos.map((p) => p[0]);
  const lats = puntos.map((p) => p[1]);
  if (geometria.type === 'Point') {
    mapa.flyTo({ center: puntos[0], zoom: Math.max(mapa.getZoom(), 16) });
  } else {
    mapa.fitBounds([[Math.min(...lons), Math.min(...lats)],
                    [Math.max(...lons), Math.max(...lats)]], { padding: 80, maxZoom: 18 });
  }
}

async function borrar(dato) {
  if (!confirm(`¿Eliminar "${dato.nombre || 'este elemento'}"? No se puede deshacer.`)) return;
  try {
    await api(`/api/features/${dato.id}`, { method: 'DELETE' });
    avisar('Elemento eliminado.');
    cerrar();
    refrescarDatos();
    alBorrar();
  } catch (error) {
    avisar(error.message, true);
  }
}

export const haySeleccion = () => seleccionado !== null;
