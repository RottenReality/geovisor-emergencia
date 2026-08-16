/* Ajuste de imagen: que banda es cual, y como repartir el contraste.
 *
 * Una imagen satelital cruda no trae "colores": trae capas de medidas, una por
 * rango del espectro, apiladas en un orden que decide cada mision. Para verla
 * hay que elegir tres y mandarlas a la pantalla como rojo, verde y azul.
 *
 * El problema es que muchos GeoTIFF no dicen cual es cual: ni interpretacion
 * de color, ni nombre de banda. Entonces el servidor supone, y cada mision
 * apila distinto:
 *
 *   PlanetScope, Sentinel-2 ...... Azul, Verde, Rojo, Infrarrojo
 *   Skysat, fotografia aerea ..... Rojo, Verde, Azul, Infrarrojo
 *
 * Suponer al reves intercambia el rojo con el azul y la escena sale azulada.
 * Aqui se corrige a mano, mirando: cada banda se muestra en gris, y en gris el
 * infrarrojo se reconoce porque la vegetacion sale clara y el asfalto oscuro.
 *
 * Se guarda en el servidor a proposito. Que banda es el rojo es un hecho del
 * archivo, no una preferencia: si cada quien lo ajustara por su cuenta, el
 * equipo compararia capturas de la misma escena con colores distintos.
 */

import { api, avisar, escapar, $ } from './util.js';

/** {item, alCambiar} del raster que se esta ajustando. */
let actual = null;

const VISIBLES = [
  ['rojo',  'Rojo'],
  ['verde', 'Verde'],
  ['azul',  'Azul'],
];
const EXTRA = [
  ['nir',  'Infrarrojo (NIR)', 'Habilita la vista en falso color.'],
  ['swir', 'SWIR',             'Habilita la vista de suelo y humedad.'],
];

/** Etiqueta corta del papel, para marcar cada miniatura. */
const SIGLA = { rojo: 'R', verde: 'V', azul: 'A', nir: 'IR', swir: 'SWIR' };

/** Los dos apilados que cubren casi todo lo que llega. */
const PRESETS = [
  { nombre: 'Azul, Verde, Rojo, IR', pista: 'PlanetScope · Sentinel-2',
    papeles: { azul: 1, verde: 2, rojo: 3, nir: 4 } },
  { nombre: 'Rojo, Verde, Azul, IR', pista: 'Skysat · fotografía aérea',
    papeles: { rojo: 1, verde: 2, azul: 3, nir: 4 } },
];

const BALANCES = [
  ['auto',  'Automático',
   'Comparte el rango solo si consta que las bandas están en la misma escala.'],
  ['comun', 'Igual para las tres',
   'Color fiel. Correcto cuando el producto es de reflectancia (Sentinel, PlanetScope).'],
  ['banda', 'Cada banda por separado',
   'Más contraste. Necesario cuando el archivo trae valores crudos del sensor.'],
];

const ORIGEN = {
  manual:         'Asignadas a mano por el equipo.',
  interpretacion: 'El archivo declara qué banda es cada color.',
  nombre:         'Deducidas del nombre de las bandas (B2, B3, B4…).',
  supuesto:       'SUPUESTAS: el archivo no dice qué banda es cuál.',
  unica:          'Una sola banda.',
};

// ---------------------------------------------------------------------------
// Apertura y cierre
// ---------------------------------------------------------------------------

/**
 * @param {object} item raster de la lista de capas
 * @param {Function} alCambiar recarga el mapa y devuelve el item ya refrescado
 */
export function abrir(item, alCambiar) {
  actual = { item, alCambiar };
  $('bandas-titulo').textContent = item.nombre;
  $('telon-bandas').classList.add('visible');
  pintar();
}

export function cerrar() {
  $('telon-bandas').classList.remove('visible');
  actual = null;
}

export const estaAbierto = () => $('telon-bandas').classList.contains('visible');

// ---------------------------------------------------------------------------
// Guardado
// ---------------------------------------------------------------------------

/** Estado completo, no un parche: el servidor necesita poder distinguir
 *  "quita la asignacion manual" de "dejala como esta". */
async function guardar(papeles, balance) {
  const { item, alCambiar } = actual;
  try {
    await api(`/api/rasters/${item.id}/bandas`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ papeles, balance }),
    });
  } catch (error) { avisar(error.message, true); return; }

  // El item de la lista queda obsoleto: al recargar se crean objetos nuevos.
  const fresco = await alCambiar();
  if (fresco) actual.item = fresco;
  pintar();
}

/** Asignacion en vigor, lista para reenviar con un solo papel cambiado. */
function papelesActuales() {
  const { papeles } = actual.item;
  const salida = {};
  for (const papel of ['rojo', 'verde', 'azul', 'nir', 'swir']) {
    if (papeles?.[papel]) salida[papel] = papeles[papel];
  }
  return salida;
}

// ---------------------------------------------------------------------------
// Pintado
// ---------------------------------------------------------------------------

/** Nombre util de una banda: lo que declare el archivo, o solo su numero. */
function etiquetaBanda(item, indice) {
  const detalle = (item.detalle_bandas || []).find((b) => b.indice === indice);
  const nombre = detalle?.nombre || (detalle?.interp && detalle.interp !== 'undefined'
    && detalle.interp !== 'gray' ? detalle.interp : '');
  return nombre ? `Banda ${indice} · ${nombre}` : `Banda ${indice}`;
}

function pintar() {
  const { item } = actual;
  const cuerpo = $('bandas-cuerpo');

  if (!item.num_bandas) {
    cuerpo.innerHTML = '<p class="vacio">Esta imagen todavía no está medida. ' +
      'Si acaba de cargarse, espera a que termine de convertirse.</p>';
    return;
  }
  if (item.num_bandas === 1) {
    cuerpo.innerHTML = '<p class="vacio">Esta imagen tiene una sola banda: ' +
      'no hay nada que asignar, se dibuja en gris.</p>';
    return;
  }

  const papeles = item.papeles || {};
  // Papel que desempena cada indice, para marcar las miniaturas.
  const marcaDe = (indice) => Object.entries(SIGLA)
    .filter(([papel]) => papeles[papel] === indice)
    .map(([, sigla]) => sigla).join(' ');

  const supuesto = papeles.origen === 'supuesto';
  const indices = (item.detalle_bandas || []).map((b) => b.indice);

  const opciones = (seleccionado, conNinguna) => `
    ${conNinguna ? `<option value="">— ninguna —</option>` : ''}
    ${indices.map((i) => `<option value="${i}" ${seleccionado === i ? 'selected' : ''}>
        ${escapar(etiquetaBanda(item, i))}</option>`).join('')}`;

  cuerpo.innerHTML = `
    ${supuesto ? `
      <p class="aviso-tema" style="margin-bottom:12px">
        Este archivo no dice qué banda es cuál, así que el orden de abajo es una
        <strong>suposición</strong>. Si la imagen se ve azulada o verdosa,
        casi siempre es que el rojo y el azul están cambiados.
      </p>` : ''}

    <div class="campo">
      <label>Cómo se ve ahora</label>
      <img class="vista-compuesta" alt="Vista previa de la imagen completa"
           src="/api/rasters/${item.id}/vista.png?c=${encodeURIComponent(item.combinacion || 'natural')}&v=${item.render || 0}">
      <p class="nota">${escapar(ORIGEN[papeles.origen] || '')}</p>
    </div>

    <div class="campo">
      <label>Cada banda por separado, en gris</label>
      <p class="nota" style="margin:-2px 0 6px">
        El infrarrojo es aquel donde la vegetación sale <em>clara</em> y el
        asfalto oscuro. El azul es el de menos contraste, por la neblina.
      </p>
      <div class="tira-bandas">
        ${indices.map((i) => `
          <figure>
            <img loading="lazy" alt="Banda ${i} en gris"
                 src="/api/rasters/${item.id}/vista.png?banda=${i}">
            <figcaption>
              ${escapar(etiquetaBanda(item, i))}
              ${marcaDe(i) ? `<span class="marca">${marcaDe(i)}</span>` : ''}
            </figcaption>
          </figure>`).join('')}
      </div>
    </div>

    <div class="campo">
      <label>Qué banda va en cada color</label>
      ${VISIBLES.map(([papel, texto]) => `
        <div class="par-banda">
          <span class="etiqueta">${texto}</span>
          <select data-papel="${papel}">${opciones(papeles[papel], false)}</select>
        </div>`).join('')}
      ${EXTRA.map(([papel, texto, pista]) => `
        <div class="par-banda">
          <span class="etiqueta" title="${escapar(pista)}">${texto}</span>
          <select data-papel="${papel}">${opciones(papeles[papel], true)}</select>
        </div>`).join('')}
    </div>

    <div class="campo">
      <label>Órdenes habituales</label>
      <div class="fila">
        ${PRESETS.map((p, i) => `
          <button data-preset="${i}" class="tenue" title="${escapar(p.pista)}"
                  ${item.num_bandas < 3 ? 'disabled' : ''}>${escapar(
                    item.num_bandas < 4 ? p.nombre.replace(', IR', '') : p.nombre)}</button>`).join('')}
      </div>
    </div>

    ${item.estirable ? `
      <div class="campo">
        <label>Reparto del contraste</label>
        <select id="bandas-balance">
          ${BALANCES.map(([valor, texto, pista]) => `
            <option value="${valor}" ${item.balance === valor ? 'selected' : ''}
                    title="${escapar(pista)}">${texto}</option>`).join('')}
        </select>
        <p class="nota">${escapar(pistaBalance(item))}</p>
      </div>` : ''}

    <button data-accion="auto" class="tenue" style="width:100%"
            ${papeles.origen === 'manual' || item.balance !== 'auto' ? '' : 'disabled'}>
      Volver a lo automático
    </button>`;

  cablear();
}

/** Explica que quedo en efecto, que en 'Automático' no es evidente. */
function pistaBalance(item) {
  if (item.balance === 'comun') return 'Las tres bandas comparten un mismo rango.';
  if (item.balance === 'banda') return 'Cada banda se estira a su propio rango.';
  return item.mismo_rango
    ? 'En efecto: un mismo rango para las tres (las bandas están en la misma escala).'
    : 'En efecto: cada banda por separado (las bandas no están en la misma escala).';
}

function cablear() {
  const cuerpo = $('bandas-cuerpo');

  cuerpo.querySelectorAll('select[data-papel]').forEach((control) => {
    control.onchange = (evento) => {
      const papeles = papelesActuales();
      const valor = Number(evento.target.value);
      if (valor) papeles[evento.target.dataset.papel] = valor;
      else delete papeles[evento.target.dataset.papel];
      guardar(papeles, actual.item.balance || 'auto');
    };
  });

  cuerpo.querySelectorAll('button[data-preset]').forEach((boton) => {
    boton.onclick = () => {
      const preset = PRESETS[Number(boton.dataset.preset)];
      // Un preset de 4 bandas aplicado a un archivo de 3 dejaria el
      // infrarrojo apuntando a una banda que no existe.
      const papeles = Object.fromEntries(
        Object.entries(preset.papeles).filter(([, i]) => i <= actual.item.num_bandas));
      guardar(papeles, actual.item.balance || 'auto');
    };
  });

  const balance = cuerpo.querySelector('#bandas-balance');
  if (balance) {
    balance.onchange = (evento) => {
      const papeles = actual.item.papeles?.origen === 'manual' ? papelesActuales() : null;
      guardar(papeles, evento.target.value);
    };
  }

  const auto = cuerpo.querySelector('[data-accion="auto"]');
  if (auto) auto.onclick = () => guardar(null, 'auto');
}
