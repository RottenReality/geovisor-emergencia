/* Pila de capas: quien va encima de quien, y que hay dentro de que grupo.
 *
 * El orden es del EQUIPO y vive en el servidor. Este modulo solo lo pide, lo
 * cachea entre repintados y ofrece las operaciones; no decide nada.
 *
 * Todo va de abajo arriba, igual que en el backend: el ultimo es el que se
 * dibuja encima. El panel lo pinta al reves, que es la convencion de QGIS.
 */

import { api } from './util.js';

let entradas = [];
let losGrupos = [];

export async function cargar() {
  const datos = await api('/api/pila');
  entradas = datos.entradas;
  losGrupos = datos.grupos;
}

export const grupos = () => losGrupos;

const esGrupo = (clave) => clave.startsWith('grupo-');
const idDeGrupo = (clave) => Number(clave.slice('grupo-'.length));
const porOrden = (a, b) => (a.orden - b.orden) || a.clave.localeCompare(b.clave);

/** Ids de grupo que de verdad estan en la pila. */
const presentes = () =>
  new Set(entradas.filter((f) => esGrupo(f.clave)).map((f) => idDeGrupo(f.clave)));

/** Nivel superior en orden, con cada grupo expandido en su sitio. */
export function arbol() {
  const vivos = presentes();
  const hijos = new Map();
  const superiores = [];

  for (const fila of entradas) {
    // Un hijo cuyo grupo ya no existe sale al nivel superior: dejarlo
    // colgando lo haria desaparecer del panel sin ningun aviso.
    const suyo = vivos.has(fila.grupo_id) ? fila.grupo_id : null;
    if (suyo === null) superiores.push(fila);
    else hijos.set(suyo, [...(hijos.get(suyo) || []), fila]);
  }

  return superiores.sort(porOrden).map((fila) => ({
    clave: fila.clave,
    orden: fila.orden,
    hijos: esGrupo(fila.clave)
      ? (hijos.get(idDeGrupo(fila.clave)) || []).sort(porOrden).map((h) => h.clave)
      : null,
  }));
}

/** Solo las capas, de abajo arriba. Los grupos no se dibujan en el mapa. */
export const aplanar = () =>
  arbol().flatMap((nodo) => (nodo.hijos === null ? [nodo.clave] : nodo.hijos));

/** Grupo al que pertenece una capa, o null si esta suelta. */
export function grupoDe(clave) {
  const fila = entradas.find((f) => f.clave === clave);
  return fila && presentes().has(fila.grupo_id) ? fila.grupo_id : null;
}

/** Si esta en el borde de su contenedor, el boton debe salir deshabilitado. */
export function enElBorde(clave, direccion) {
  const nodos = arbol();
  const dentro = nodos.find((n) => n.hijos?.includes(clave));
  const hermanos = dentro ? dentro.hijos : nodos.map((n) => n.clave);
  const posicion = hermanos.indexOf(clave);
  if (posicion === -1) return true;
  return direccion === 'subir' ? posicion === hermanos.length - 1 : posicion === 0;
}

const enviar = (ruta, cuerpo, metodo = 'POST') => api(ruta, {
  method: metodo,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(cuerpo),
});

export const mover = (clave, direccion) => enviar('/api/pila/mover', { clave, direccion });
export const agrupar = (clave, grupoId) =>
  enviar('/api/pila/agrupar', { clave, grupo_id: grupoId });
export const crearGrupo = (nombre, color) => enviar('/api/grupos', { nombre, color });
export const editarGrupo = (id, cambios) => enviar(`/api/grupos/${id}`, cambios, 'PATCH');
export const disolverGrupo = (id) => api(`/api/grupos/${id}`, { method: 'DELETE' });
