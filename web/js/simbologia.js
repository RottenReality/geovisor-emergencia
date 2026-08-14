/* Simbologia y filtro por atributo.
 *
 * Un shapefile de manzanas no es util pintado de un solo color: lo que hace
 * falta es ver donde esta el dano. Aqui se elige UN atributo de la capa y se
 * usa para dos cosas distintas, que conviene no confundir:
 *
 *   - COLOR: se guarda en el servidor. El codigo de colores de "nivel de
 *     afectacion" es un acuerdo del equipo; si cada quien lo viera distinto,
 *     los informes y las capturas de pantalla dejarian de ser comparables.
 *
 *   - FILTRO: se queda en este navegador. Que alguien esconda datos a todo el
 *     equipo sin que se entere es exactamente lo que no puede pasar en una
 *     emergencia. Ademas se avisa en la fila de la capa cuando hay filtro.
 *
 * El servidor mete en la tesela un solo atributo por capa, el elegido, bajo el
 * nombre 'valor'. Meterlos todos engordaria las teselas y en campo el ancho de
 * banda es el recurso escaso.
 */

import { api, avisar, escapar, numero, $ } from './util.js';
import { fijarFiltro, refrescarDatos } from './mapa.js';

// ---------------------------------------------------------------------------
// Paletas
// ---------------------------------------------------------------------------

/** Para categorias: valores sin orden natural (tipo de dano, barrio, uso). */
const PALETAS = {
  'Contraste': ['#e63946', '#2a9d8f', '#f4a261', '#457b9d', '#9d4edd', '#7cb518',
                '#00a5cf', '#f77f00', '#ef476f', '#3a86ff', '#ffbe0b', '#8338ec',
                '#06d6a0', '#c1121f', '#118ab2', '#fb5607', '#8d99ae', '#e9c46a'],
  'Verde a rojo': ['#1a9641', '#7fbc41', '#b8e186', '#ffffbf', '#fdae61',
                   '#e8703a', '#d7191c', '#8c0d10'],
};

/** Para rangos: escalas secuenciales, que es lo que exige un dato ordenado. */
const RAMPAS = {
  'Amarillo a rojo': ['#ffffb2', '#fed976', '#feb24c', '#fd8d3c', '#f03b20', '#bd0026'],
  'Verde a rojo':    ['#1a9641', '#a6d96a', '#ffffbf', '#fdae61', '#e8703a', '#d7191c'],
  'Azules':          ['#eff3ff', '#c6dbef', '#9ecae1', '#6baed6', '#3182bd', '#08519c'],
};

/** Reparte k colores a lo largo de una rampa de 6, sin repetir los extremos. */
const muestrear = (rampa, k) =>
  k <= 1
    ? [rampa[rampa.length - 1]]
    : Array.from({ length: k }, (_, i) =>
        rampa[Math.round((i * (rampa.length - 1)) / (k - 1))]);

const fmt = (n) => (Number.isInteger(n) ? numero(n, 0) : numero(n, 2));

// ---------------------------------------------------------------------------
// Filtros locales
// ---------------------------------------------------------------------------
const LLAVE = 'geovisor.filtros';

/** {capaId: {ocultos: string[], sinDato: bool, min: number|null, max: number|null}} */
let filtros = {};
try { filtros = JSON.parse(localStorage.getItem(LLAVE) || '{}'); } catch { filtros = {}; }

const guardarFiltros = () => localStorage.setItem(LLAVE, JSON.stringify(filtros));

const filtroDe = (capaId) => filtros[capaId] || null;

export const tieneFiltro = (item) => {
  const f = filtroDe(item.id);
  if (!f) return false;
  return !!(f.ocultos?.length || f.sinDato ||
            Number.isFinite(f.min) || Number.isFinite(f.max));
};

/** Traduce el filtro guardado a una expresion de MapLibre sobre 'valor'. */
function expresionFiltro(item) {
  const f = filtroDe(item.id);
  if (!f || !item.estilo?.campo) return null;

  const partes = [];
  if (f.ocultos?.length) {
    partes.push(['!', ['in', ['to-string', ['get', 'valor']], ['literal', f.ocultos]]]);
  }
  const hayRango = Number.isFinite(f.min) || Number.isFinite(f.max);
  if (hayRango) {
    // Sin 'has', los elementos que no traen el atributo valdrian 0 y se
    // colarian en cualquier rango que incluya el cero.
    partes.push(['has', 'valor']);
    if (Number.isFinite(f.min)) partes.push(['>=', ['to-number', ['get', 'valor'], 0], f.min]);
    if (Number.isFinite(f.max)) partes.push(['<=', ['to-number', ['get', 'valor'], 0], f.max]);
  }
  if (f.sinDato && !hayRango) partes.push(['has', 'valor']);

  return partes.length ? ['all', ...partes] : null;
}

/** Vuelve a poner en el mapa los filtros guardados. Se llama tras cada carga. */
export function reaplicarFiltros(items) {
  for (const item of items) {
    if (item.esRaster) continue;
    fijarFiltro(item.id, expresionFiltro(item));
  }
}

export function limpiarFiltro(capaId) {
  delete filtros[capaId];
  guardarFiltros();
}

// ---------------------------------------------------------------------------
// Leyenda
// ---------------------------------------------------------------------------

/** Entradas de leyenda de una capa: [{color, etiqueta}]. Vacio si no hay tema. */
export function leyendaDe(item) {
  const e = item.estilo;
  if (!e?.campo) return [];

  if (e.modo === 'categorias') {
    const orden = e.orden?.length ? e.orden : Object.keys(e.colores || {});
    return orden.map((valor) => ({
      valor,
      color: (e.colores || {})[valor] || item.color,
      etiqueta: valor,
    }));
  }

  if (e.modo === 'rangos' && e.cortes?.length >= 2) {
    return (e.colores || []).map((color, i) => ({
      valor: null,
      color,
      etiqueta: `${fmt(e.cortes[i])} – ${fmt(e.cortes[i + 1])}`,
    }));
  }

  return [];
}

/** Leyenda flotante sobre el mapa: sin ella los colores no significan nada. */
export function pintarLeyenda(items) {
  const caja = $('leyenda');
  if (!caja) return;

  const conTema = items.filter((i) => !i.esRaster && i.visible && leyendaDe(i).length);
  if (!conTema.length) { caja.hidden = true; return; }

  caja.hidden = false;
  $('leyenda-cuerpo').innerHTML = conTema.map((item) => {
    const ocultos = new Set(filtroDe(item.id)?.ocultos || []);
    return `
      <div class="leyenda-capa">
        <div class="leyenda-titulo">
          <span class="nombre">${escapar(item.nombre)}</span>
          <span class="campo">${escapar(item.estilo.campo)}</span>
        </div>
        ${leyendaDe(item).map((fila) => `
          <div class="leyenda-fila ${fila.valor !== null && ocultos.has(fila.valor) ? 'oculta' : ''}">
            <span class="muestra" style="background:${escapar(fila.color)}"></span>
            <span class="texto">${escapar(fila.etiqueta)}</span>
          </div>`).join('')}
      </div>`;
  }).join('');
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------
let actual = null;        // {item, alCambiar}
let campos = [];          // atributos de la capa
let datos = null;         // respuesta de /valores del campo elegido
let guardando = null;

async function guardarEstilo(item) {
  await api(`/api/capas/${item.id}/estilo`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ estilo: item.estilo || null }),
  });
}

/** Los retoques de color se guardan agrupados: nadie necesita una peticion
 *  por cada movimiento del selector. */
function guardarDiferido(item) {
  clearTimeout(guardando);
  guardando = setTimeout(
    () => guardarEstilo(item).catch((error) => avisar(error.message, true)), 600);
}

export async function abrir(item, alCambiar) {
  actual = { item, alCambiar };
  datos = null;
  $('simbologia-titulo').textContent = item.nombre;
  $('simbologia-cuerpo').innerHTML = '<p class="vacio">Leyendo atributos…</p>';
  $('telon-simbologia').classList.add('visible');

  try {
    campos = await api(`/api/capas/${item.id}/campos`);
  } catch (error) {
    $('simbologia-cuerpo').innerHTML = `<p class="error-texto">${escapar(error.message)}</p>`;
    return;
  }

  if (!campos.length) {
    $('simbologia-cuerpo').innerHTML =
      '<p class="vacio">Esta capa no tiene atributos para clasificar. ' +
      'Los shapefiles y GeoJSON los traen; los elementos dibujados a mano, ' +
      'solo si les pusiste atributos al guardarlos.</p>';
    return;
  }

  if (item.estilo?.campo) {
    // Si el campo guardado ya no existe (alguien recargo la capa con otros
    // atributos) esto falla; el panel sigue sirviendo para elegir otro.
    try { await cargarValores(item.estilo.campo, clasesDe(item)); }
    catch (error) { avisar(error.message, true); datos = null; }
  }
  pintarPanel();
}

export function cerrar() {
  $('telon-simbologia').classList.remove('visible');
  actual = null;
}

export const estaAbierto = () => $('telon-simbologia').classList.contains('visible');

const clasesDe = (item) =>
  item.estilo?.modo === 'rangos' && item.estilo.cortes?.length >= 2
    ? item.estilo.cortes.length - 1
    : 5;

let clasesPedidas = 5;

async function cargarValores(campo, clases) {
  const { item } = actual;
  datos = await api(`/api/capas/${item.id}/valores?campo=${encodeURIComponent(campo)}` +
                    `&clases=${clases}`);
  clasesPedidas = clases;
}

// ---------------------------------------------------------------------------
// Pintado del panel
// ---------------------------------------------------------------------------
function pintarPanel() {
  const { item } = actual;
  const estilo = item.estilo || {};
  const cuerpo = $('simbologia-cuerpo');

  const opcionCampo = (c) => `
    <option value="${escapar(c.campo)}" ${c.campo === estilo.campo ? 'selected' : ''}>
      ${escapar(c.campo)} — ${c.distintos} valor${c.distintos === 1 ? '' : 'es'}${c.numerico ? ', numérico' : ''}
    </option>`;

  cuerpo.innerHTML = `
    <div class="campo">
      <label for="sim-campo">Clasificar por</label>
      <select id="sim-campo">
        <option value="">— un solo color —</option>
        ${campos.map(opcionCampo).join('')}
      </select>
    </div>
    <div id="sim-detalle"></div>`;

  $('sim-campo').onchange = (e) => cambiarCampo(e.target.value);
  if (estilo.campo && datos) pintarDetalle();
}

function pintarDetalle() {
  const { item } = actual;
  const estilo = item.estilo;
  const filtro = filtroDe(item.id) || {};
  const entradas = leyendaDe(item);
  const ocultos = new Set(filtro.ocultos || []);
  const conteos = new Map((datos.valores || []).map((v) => [v.valor, v.total]));

  const paletas = estilo.modo === 'rangos' ? RAMPAS : PALETAS;
  const nombrePaleta = estilo.paleta && paletas[estilo.paleta]
    ? estilo.paleta : Object.keys(paletas)[0];

  // Lo que se pidio y lo que salio no siempre coinciden: si muchos elementos
  // comparten valor, los cortes se funden y quedan menos clases de las pedidas.
  const clases = clasesPedidas;
  const reales = estilo.modo === 'rangos' ? estilo.cortes.length - 1 : 0;

  $('sim-detalle').innerHTML = `
    ${datos.numerico ? `
      <div class="campo">
        <label>Cómo agrupar</label>
        <div class="fila">
          <button id="sim-categorias" aria-pressed="${estilo.modo === 'categorias'}">Un color por valor</button>
          <button id="sim-rangos"     aria-pressed="${estilo.modo === 'rangos'}">Rangos</button>
        </div>
      </div>` : ''}

    <div class="fila">
      <div class="campo" style="flex:1">
        <label for="sim-paleta">Paleta</label>
        <select id="sim-paleta">
          ${Object.keys(paletas).map((n) =>
            `<option ${n === nombrePaleta ? 'selected' : ''}>${n}</option>`).join('')}
        </select>
      </div>
      ${estilo.modo === 'rangos' ? `
        <div class="campo" style="flex:0 0 78px">
          <label for="sim-clases">Clases</label>
          <select id="sim-clases">
            ${[3, 4, 5, 6, 7].map((k) =>
              `<option ${k === clases ? 'selected' : ''}>${k}</option>`).join('')}
          </select>
        </div>` : ''}
    </div>

    ${estilo.modo === 'rangos' ? `
      <div class="campo">
        <label for="sim-criterio">Dónde cortar</label>
        <select id="sim-criterio">
          <option value="cuantiles" ${estilo.cortes_modo !== 'iguales' ? 'selected' : ''}>
            Por cuantiles — cada clase con parecida cantidad de elementos</option>
          <option value="iguales" ${estilo.cortes_modo === 'iguales' ? 'selected' : ''}>
            Intervalos iguales — cada clase del mismo ancho</option>
        </select>
      </div>
      ${reales < clases ? `
        <p class="nota aviso-tema">
          Pediste ${clases} clases y salieron ${reales}: hay demasiados
          elementos repitiendo el mismo valor como para separarlas. Prueba con
          intervalos iguales o con un color por valor.
        </p>` : ''}` : ''}

    ${estilo.modo === 'categorias' && datos.truncado ? `
      <p class="nota aviso-tema">
        Este campo tiene más de 200 valores distintos; se muestran los 200 más
        frecuentes. Un campo así suele ser un identificador y no un buen
        criterio para colorear.
      </p>` : ''}

    <label style="margin-top:12px">
      Leyenda y filtro
      <output>${entradas.length} clase${entradas.length === 1 ? '' : 's'}</output>
    </label>
    <p class="nota" style="margin-top:0">
      Los <strong>colores</strong> se guardan y los ve todo el equipo.
      Las <strong>casillas</strong> solo filtran lo que tú ves.
    </p>
    <div class="leyenda-edit">
      ${entradas.map((fila, i) => `
        <div class="leyenda-edit-fila">
          <input type="checkbox" data-oculta="${i}"
                 ${fila.valor === null || !ocultos.has(fila.valor) ? 'checked' : ''}
                 ${fila.valor === null ? 'disabled' : ''}
                 aria-label="Mostrar ${escapar(fila.etiqueta)}">
          <input type="color" data-color="${i}" value="${escapar(fila.color)}"
                 aria-label="Color de ${escapar(fila.etiqueta)}">
          <span class="texto" title="${escapar(fila.etiqueta)}">${escapar(fila.etiqueta)}</span>
          <span class="conteo">${fila.valor !== null && conteos.has(fila.valor)
            ? numero(conteos.get(fila.valor), 0) : ''}</span>
        </div>`).join('')}
    </div>

    ${estilo.modo === 'rangos' ? `
      <div class="campo" style="margin-top:10px">
        <label>Mostrar solo entre <span class="pista">${fmt(datos.minimo)} a ${fmt(datos.maximo)}</span></label>
        <div class="fila">
          <input type="number" id="sim-min" placeholder="desde"
                 value="${Number.isFinite(filtro.min) ? filtro.min : ''}">
          <input type="number" id="sim-max" placeholder="hasta"
                 value="${Number.isFinite(filtro.max) ? filtro.max : ''}">
        </div>
      </div>` : ''}

    ${datos.sin_dato ? `
      <label class="casilla" style="margin-top:10px">
        <input type="checkbox" id="sim-sin-dato" ${filtro.sinDato ? 'checked' : ''}>
        Ocultar los ${numero(datos.sin_dato, 0)} sin dato en este campo
      </label>` : ''}

    <div class="fila" style="margin-top:14px">
      <button id="sim-todo" class="tenue">Ver todo</button>
      <button id="sim-solo-visibles" class="tenue">Invertir</button>
    </div>`;

  conectarDetalle(entradas);
}

function conectarDetalle(entradas) {
  const { item } = actual;
  const estilo = item.estilo;

  $('sim-paleta').onchange = (e) => { estilo.paleta = e.target.value; recolorear(); };

  if ($('sim-categorias')) $('sim-categorias').onclick = () => cambiarModo('categorias');
  if ($('sim-rangos')) $('sim-rangos').onclick = () => cambiarModo('rangos');
  if ($('sim-clases')) $('sim-clases').onchange = (e) => cambiarClases(Number(e.target.value));
  if ($('sim-criterio')) $('sim-criterio').onchange = (e) => cambiarCriterio(e.target.value);

  for (const control of $('sim-detalle').querySelectorAll('[data-color]')) {
    const i = Number(control.dataset.color);
    control.oninput = (e) => {
      if (estilo.modo === 'rangos') estilo.colores[i] = e.target.value;
      else estilo.colores[entradas[i].valor] = e.target.value;
      estilo.paleta = null;   // ya no corresponde a ninguna paleta
      aplicar();
      guardarDiferido(item);
    };
  }

  for (const control of $('sim-detalle').querySelectorAll('[data-oculta]')) {
    const i = Number(control.dataset.oculta);
    control.onchange = (e) => {
      const filtro = filtros[item.id] || (filtros[item.id] = {});
      const ocultos = new Set(filtro.ocultos || []);
      if (e.target.checked) ocultos.delete(entradas[i].valor);
      else ocultos.add(entradas[i].valor);
      filtro.ocultos = [...ocultos];
      guardarFiltros();
      aplicar();
    };
  }

  const rango = (cual) => (e) => {
    const filtro = filtros[item.id] || (filtros[item.id] = {});
    const valor = e.target.value.trim();
    filtro[cual] = valor === '' ? null : Number(valor);
    guardarFiltros();
    aplicar();
  };
  if ($('sim-min')) $('sim-min').onchange = rango('min');
  if ($('sim-max')) $('sim-max').onchange = rango('max');

  if ($('sim-sin-dato')) $('sim-sin-dato').onchange = (e) => {
    const filtro = filtros[item.id] || (filtros[item.id] = {});
    filtro.sinDato = e.target.checked;
    guardarFiltros();
    aplicar();
  };

  $('sim-todo').onclick = () => { limpiarFiltro(item.id); aplicar(); pintarDetalle(); };
  $('sim-solo-visibles').onclick = () => {
    const filtro = filtros[item.id] || (filtros[item.id] = {});
    const ocultos = new Set(filtro.ocultos || []);
    filtro.ocultos = entradas
      .filter((f) => f.valor !== null && !ocultos.has(f.valor))
      .map((f) => f.valor);
    guardarFiltros();
    aplicar();
    pintarDetalle();
  };
}

// ---------------------------------------------------------------------------
// Cambios
// ---------------------------------------------------------------------------

/** Reparte la paleta activa sobre las clases actuales. */
function recolorear() {
  const { item } = actual;
  const estilo = item.estilo;

  if (estilo.modo === 'rangos') {
    const rampa = RAMPAS[estilo.paleta] || RAMPAS[Object.keys(RAMPAS)[0]];
    estilo.colores = muestrear(rampa, estilo.cortes.length - 1);
  } else {
    const paleta = PALETAS[estilo.paleta] || PALETAS[Object.keys(PALETAS)[0]];
    estilo.colores = {};
    estilo.orden.forEach((valor, i) => {
      estilo.colores[valor] = paleta[i % paleta.length];
    });
  }
  aplicar();
  guardarDiferido(item);
  pintarDetalle();
}

/** Ordena los valores como se leen: los numeros por magnitud, el resto alfabetico. */
function ordenarValores(valores) {
  const todosNumero = valores.every((v) => v !== '' && Number.isFinite(Number(v)));
  return [...valores].sort((a, b) =>
    todosNumero ? Number(a) - Number(b) : a.localeCompare(b, 'es', { numeric: true }));
}

/** Cortes disponibles. Los cuantiles colapsan cuando el dato esta sesgado
 *  (media ciudad con cero danos deja tres clases identicas en cero), asi que
 *  cuando eso pasa se pasa solo a intervalos iguales. */
function cortesDe(criterio) {
  const cuantiles = datos.cortes || [];
  const iguales = datos.cortes_iguales || [];
  if (criterio === 'iguales') return iguales.length >= 2 ? iguales : cuantiles;
  return cuantiles.length >= 2 ? cuantiles : iguales;
}

function estiloPorDefecto(campo, modo, paleta, criterio) {
  if (modo === 'rangos') {
    const cortes_modo = criterio || 'cuantiles';
    const cortes = cortesDe(cortes_modo);
    const rampa = RAMPAS[paleta] || RAMPAS[Object.keys(RAMPAS)[0]];
    return {
      campo, modo: 'rangos', paleta: paleta || Object.keys(RAMPAS)[0],
      cortes_modo, cortes, colores: muestrear(rampa, cortes.length - 1),
    };
  }
  const orden = ordenarValores(datos.valores.map((v) => v.valor));
  const lista = PALETAS[paleta] || PALETAS[Object.keys(PALETAS)[0]];
  const colores = {};
  orden.forEach((valor, i) => { colores[valor] = lista[i % lista.length]; });
  return { campo, modo: 'categorias', paleta: paleta || Object.keys(PALETAS)[0], orden, colores };
}

async function cambiarCampo(campo) {
  const { item } = actual;

  if (!campo) {
    item.estilo = null;
    limpiarFiltro(item.id);
    try { await guardarEstilo(item); } catch (error) { avisar(error.message, true); }
    // El servidor deja de meter 'valor' en la tesela: hay que volver a pedirlas.
    refrescarDatos();
    aplicar();
    pintarPanel();
    return;
  }

  $('sim-detalle').innerHTML = '<p class="vacio">Leyendo valores…</p>';
  try {
    await cargarValores(campo, 5);
  } catch (error) { avisar(error.message, true); return; }

  // Por rangos solo si el campo es numerico Y tiene suficientes valores para
  // que agrupar signifique algo; con doce valores distintos o menos, un color
  // por valor se lee mejor que cinco rangos.
  const porRangos = datos.numerico && datos.valores.length > 12 &&
                    cortesDe('cuantiles').length >= 3;
  item.estilo = estiloPorDefecto(campo, porRangos ? 'rangos' : 'categorias', null, null);
  limpiarFiltro(item.id);

  try { await guardarEstilo(item); } catch (error) { avisar(error.message, true); }
  // Cambiar de campo cambia lo que el servidor mete en la tesela.
  refrescarDatos();
  aplicar();
  pintarPanel();
}

async function cambiarModo(modo) {
  const { item } = actual;
  if (item.estilo.modo === modo) return;
  if (modo === 'rangos' && cortesDe('cuantiles').length < 2) {
    avisar('Todos los elementos tienen el mismo valor: no hay rangos que separar.', true);
    return;
  }
  item.estilo = estiloPorDefecto(item.estilo.campo, modo, null, null);
  limpiarFiltro(item.id);
  aplicar();
  guardarDiferido(item);
  pintarDetalle();
}

async function cambiarClases(k) {
  const { item } = actual;
  try {
    await cargarValores(item.estilo.campo, k);
  } catch (error) { avisar(error.message, true); return; }
  item.estilo = estiloPorDefecto(
    item.estilo.campo, 'rangos', item.estilo.paleta, item.estilo.cortes_modo);
  aplicar();
  guardarDiferido(item);
  pintarDetalle();
}

function cambiarCriterio(criterio) {
  const { item } = actual;
  item.estilo = estiloPorDefecto(
    item.estilo.campo, 'rangos', item.estilo.paleta, criterio);
  aplicar();
  guardarDiferido(item);
  pintarDetalle();
}

/** Lleva al mapa el estado actual: color, filtro y leyenda. */
function aplicar() {
  const { item, alCambiar } = actual;
  fijarFiltro(item.id, expresionFiltro(item));
  alCambiar();
}
