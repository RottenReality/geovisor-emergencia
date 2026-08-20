/* Filtro de las capas catastrales.
 *
 * Por que un modulo aparte del filtro de simbologia
 * -------------------------------------------------
 * El de simbologia filtra por UN campo, el mismo por el que se colorea, y
 * guarda {ocultos, min, max}. Aqui hacen falta varios campos a la vez -planta
 * Y tipo de planta Y ano- y ninguno tiene por que ser el de la simbologia.
 * Meter esa forma en el mismo almacen obligaria a que cada lectura del filtro
 * de las capas propias distinguiese entre dos formas distintas, que es la via
 * rapida a romper lo que ya funciona.
 *
 * Por que en el navegador y no en el servidor
 * -------------------------------------------
 * Los atributos ya viajan dentro de la tesela, asi que filtrar es cambiar una
 * expresion de MapLibre: instantaneo y sin volver a pedir nada. Filtrando en
 * el servidor, cada cambio de planta invalidaria la cache de teselas y seria
 * una espera. Ademas el filtro es de quien mira, no del equipo: esconderle
 * datos a todo el mundo sin que se entere es justo lo que no puede pasar en
 * una emergencia, y es el mismo criterio que ya sigue el filtro de las capas
 * propias.
 *
 * La contrapartida es que el peso de la tesela no baja al filtrar: se descarga
 * todo y se dibuja una parte. A cambio, moverse entre plantas no cuesta nada.
 */

import { api, escapar, $ } from './util.js';

const LLAVE = 'geovisor.filtro-catastro';

/** {claveDeFuente: {campo: {valor} | {min, max}}} */
let filtros = {};
try { filtros = JSON.parse(localStorage.getItem(LLAVE) || '{}'); } catch { filtros = {}; }

const guardar = () => localStorage.setItem(LLAVE, JSON.stringify(filtros));

/** Valores de cada campo, tal como los devolvio el servidor. */
const catalogoValores = new Map();

// Por encima de esto un desplegable deja de ser comodo y se ofrece un rango.
const MAX_OPCIONES = 40;

export const filtroDe = (clave) => filtros[clave] || null;

export function tieneFiltro(clave) {
  const f = filtros[clave];
  if (!f) return false;
  return Object.values(f).some((v) =>
    v && (v.valor !== undefined || Number.isFinite(v.min) || Number.isFinite(v.max)));
}

/** Cuantos campos estan acotando ahora mismo. Lo usa el distintivo del panel. */
export function cuantosFiltros(clave) {
  const f = filtros[clave];
  if (!f) return 0;
  return Object.values(f).filter((v) =>
    v && (v.valor !== undefined || Number.isFinite(v.min) || Number.isFinite(v.max))).length;
}

/** Traduce el filtro guardado a una expresion de MapLibre sobre la tesela. */
export function expresion(clave) {
  const f = filtros[clave];
  if (!f) return null;

  const partes = [];
  for (const [campo, ajuste] of Object.entries(f)) {
    if (!ajuste) continue;
    if (ajuste.valor !== undefined) {
      // to-string porque un mismo campo puede llegar como numero o como
      // texto segun la fila, y '3' y 3 tienen que casar igual.
      partes.push(['==', ['to-string', ['get', campo]], String(ajuste.valor)]);
      continue;
    }
    const hayRango = Number.isFinite(ajuste.min) || Number.isFinite(ajuste.max);
    if (!hayRango) continue;
    // Sin 'has', lo que no trae el atributo valdria 0 y se colaria en
    // cualquier rango que incluya el cero.
    partes.push(['has', campo]);
    if (Number.isFinite(ajuste.min)) {
      partes.push(['>=', ['to-number', ['get', campo], 0], ajuste.min]);
    }
    if (Number.isFinite(ajuste.max)) {
      partes.push(['<=', ['to-number', ['get', campo], 0], ajuste.max]);
    }
  }
  return partes.length ? ['all', ...partes] : null;
}

export function limpiar(clave) {
  delete filtros[clave];
  guardar();
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------
/** Pide al servidor que valores toma cada campo filtrable. Se pide una vez. */
async function valoresDe(clave, campo) {
  const llave = `${clave}|${campo}`;
  if (!catalogoValores.has(llave)) {
    catalogoValores.set(llave, await api(
      `/api/externas/${clave}/valores?campo=${encodeURIComponent(campo)}`));
  }
  return catalogoValores.get(llave);
}

const numeroCorto = (n) => Number(n).toLocaleString('es-CO');

/** Un control por campo: desplegable si los valores caben, rango si no. */
function control(clave, filtro, datos) {
  const puesto = filtros[clave]?.[filtro.campo] || {};
  const id = `fcat-${clave}-${filtro.campo}`;
  const total = datos.valores.reduce((a, v) => a + v.total, 0);

  // Un rango solo tiene sentido si el campo es numerico Y tiene demasiados
  // valores para listarlos. Con quince plantas distintas, el desplegable es
  // mas rapido de usar que teclear dos numeros.
  const porRango = datos.numerico && datos.valores.length > MAX_OPCIONES;

  if (porRango) {
    return `
      <div class="fcat-campo">
        <label for="${id}-min">${escapar(filtro.etiqueta)}
          <span class="pista">${numeroCorto(datos.minimo)} a ${numeroCorto(datos.maximo)}</span>
        </label>
        <div class="fila">
          <input type="number" id="${id}-min" data-campo="${escapar(filtro.campo)}" data-parte="min"
                 placeholder="desde" value="${Number.isFinite(puesto.min) ? puesto.min : ''}">
          <input type="number" id="${id}-max" data-campo="${escapar(filtro.campo)}" data-parte="max"
                 placeholder="hasta" value="${Number.isFinite(puesto.max) ? puesto.max : ''}">
        </div>
      </div>`;
  }

  // Ordenados por valor y no por frecuencia: en un desplegable de plantas se
  // busca "la 7", y para eso tiene que estar donde uno espera.
  const ordenados = [...datos.valores].sort((a, b) => (datos.numerico
    ? Number(a.valor) - Number(b.valor)
    : String(a.valor).localeCompare(String(b.valor), 'es')));

  return `
    <div class="fcat-campo">
      <label for="${id}">${escapar(filtro.etiqueta)}</label>
      <select id="${id}" data-campo="${escapar(filtro.campo)}" data-parte="valor">
        <option value="">— todas (${numeroCorto(total)}) —</option>
        ${ordenados.map((v) => `
          <option value="${escapar(String(v.valor))}"
                  ${String(puesto.valor) === String(v.valor) ? 'selected' : ''}>
            ${escapar(String(v.valor))} · ${numeroCorto(v.total)}
          </option>`).join('')}
      </select>
    </div>`;
}

/**
 * Pinta el bloque de filtro dentro del detalle de la capa.
 *
 * Se pinta al abrir las opciones y no antes: cada campo filtrable cuesta una
 * consulta que recorre la capa entera, y pedirlas para las seis capas nada
 * mas cargar el visor serian veinte consultas que casi nadie va a usar.
 */
export async function pintar(caja, item, alCambiar) {
  const clave = item.id;
  const declarados = item.fuente?.filtros || [];
  if (!declarados.length) { caja.innerHTML = ''; return; }

  caja.innerHTML = '<p class="vacio">Leyendo valores…</p>';
  let datos;
  try {
    datos = await Promise.all(declarados.map((f) => valoresDe(clave, f.campo)));
  } catch (error) {
    caja.innerHTML = `<p class="nota aviso-tema">No se pudieron leer los valores: ${
      escapar(error.message)}</p>`;
    return;
  }

  caja.innerHTML = `
    <label style="margin-top:12px">Filtrar
      <output>${cuantosFiltros(clave) || 'sin filtro'}</output>
    </label>
    <p class="nota" style="margin-top:0">
      Solo cambia <strong>lo que tú ves</strong>; el resto del equipo sigue viendo la capa entera.
    </p>
    ${declarados.map((f, i) => control(clave, f, datos[i])).join('')}
    <button class="tenue" data-fcat="limpiar" style="width:100%;margin-top:6px">
      Quitar el filtro
    </button>`;

  const anotar = (campo, parte, bruto) => {
    filtros[clave] = filtros[clave] || {};
    const ajuste = filtros[clave][campo] = filtros[clave][campo] || {};
    if (parte === 'valor') {
      if (bruto === '') delete ajuste.valor;
      else ajuste.valor = bruto;
    } else {
      const n = Number.parseFloat(bruto);
      if (Number.isFinite(n)) ajuste[parte] = n;
      else delete ajuste[parte];
    }
    if (!Object.keys(ajuste).length) delete filtros[clave][campo];
    if (!Object.keys(filtros[clave]).length) delete filtros[clave];
    guardar();
    alCambiar();
  };

  caja.querySelectorAll('[data-campo]').forEach((control_) => {
    const evento = control_.tagName === 'SELECT' ? 'change' : 'input';
    control_.addEventListener(evento, (e) => {
      anotar(control_.dataset.campo, control_.dataset.parte, e.target.value);
    });
  });
  caja.querySelector('[data-fcat="limpiar"]').onclick = () => {
    limpiar(clave);
    alCambiar();
  };
}
