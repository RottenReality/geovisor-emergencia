/* Fuentes externas: catalogo, encendido y ficha de cada elemento.
 *
 * Son treinta y dos servicios de IGAC, Esri Colombia, Copernicus, GDACS y
 * otros. Metidos todos en el panel de la izquierda lo dejarian ilegible, y el
 * panel es la herramienta de trabajo, no un indice.
 *
 * Por eso el catalogo vive en una ventana aparte: se abre, se elige, se
 * cierra. Solo lo que alguien encendio ocupa sitio en el panel, y ahi se
 * comporta como cualquier otra capa (ver, opacidad, orden, ir a la capa).
 *
 * Que este encendido se guarda en ESTE navegador, no en el servidor. Encender
 * una fuente externa es mirar, no decidir: cada quien explora las que le
 * sirven sin cambiarle el mapa al resto. Lo que si es una decision de equipo
 * -guardar una copia fechada como capa propia- tiene su propio boton y esa si
 * la ve todo el mundo.
 */

import { api, avisar, escapar, $ } from './util.js';
import { mapa, capasExternasConsultables } from './mapa.js';

/** Catalogo del servidor. Se pide una vez por sesion. */
let catalogo = null;
/** Ficha del evento (GDACS + Copernicus). Se pide una vez. */
let evento = null;
/** Aviso al resto del visor de que la lista de capas cambio. */
let alCambiar = () => {};

let globo = null;         // popup abierto sobre el mapa
let filtro = '';          // texto del buscador del catalogo

const LLAVE = 'geovisor.externas';

/** {clave: {visible, opacidad, orden}} de las fuentes encendidas. */
let encendidas = {};
try { encendidas = JSON.parse(localStorage.getItem(LLAVE) || '{}'); } catch { encendidas = {}; }
const guardar = () => localStorage.setItem(LLAVE, JSON.stringify(encendidas));

/** Cuantos elementos trajo la ultima descarga, por clave. */
const totales = {};
/** Cuantos registros de la fuente no se pudieron dibujar por no traer posicion. */
const sinUbicacion = {};

const fuenteDe = (clave) => catalogo?.fuentes.find((f) => f.clave === clave) || null;

// ---------------------------------------------------------------------------
// Capas encendidas
// ---------------------------------------------------------------------------

/** Fuentes encendidas con la forma que espera el resto del visor. */
export function items() {
  if (!catalogo) return [];
  return Object.keys(encendidas)
    .map((clave) => {
      const fuente = fuenteDe(clave);
      if (!fuente) return null;
      const estado = encendidas[clave];
      return {
        id: clave,
        esExterna: true,
        esRaster: false,
        esImagen: fuente.tipo === 'imagen',
        nombre: fuente.nombre,
        color: fuente.color,
        estilo: fuente.simbologia || null,
        visible: estado.visible !== false,
        opacidad: estado.opacidad ?? 1,
        orden: estado.orden ?? 0,
        bounds: fuente.bounds || null,
        total: totales[clave] ?? fuente.total,
        sinUbicacion: sinUbicacion[clave] ?? fuente.sin_ubicacion ?? 0,
        fuente,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.orden - b.orden);
}

export function fijar(clave, cambios) {
  if (!encendidas[clave]) return;
  Object.assign(encendidas[clave], cambios);
  guardar();
}

const ordenes = () => Object.values(encendidas).map((e) => e.orden ?? 0);

/**
 * Enciende una fuente y la deja lista en el panel.
 *
 * Los vectores se descargan aqui, antes de montarlos en el mapa. Cuesta una
 * peticion que MapLibre despues reaprovecha de la cache del navegador, y a
 * cambio pasan dos cosas que importan: se sabe en el acto cuantos elementos
 * trajo, y si la fuente esta caida el equipo se entera al hacer clic en vez de
 * quedarse mirando un mapa donde no aparece nada.
 *
 * Las ortoimagenes entran al fondo y los vectores al frente, que es el orden
 * en que se miran: los puntos sobre la imagen, nunca debajo.
 */
export async function encender(clave) {
  const fuente = fuenteDe(clave);
  if (!fuente) return;

  if (fuente.tipo !== 'imagen') {
    const datos = await api(`/api/externas/${clave}.geojson`);
    totales[clave] = datos.features.length;
    sinUbicacion[clave] = datos.sin_ubicacion || 0;
  }

  const orden = fuente.tipo === 'imagen'
    ? Math.min(0, ...ordenes()) - 1
    : Math.max(0, ...ordenes()) + 1;
  encendidas[clave] = { visible: true, opacidad: 1, orden };
  guardar();
  await alCambiar();
}

export async function apagar(clave) {
  delete encendidas[clave];
  guardar();
  await alCambiar();
  cerrarGlobo();
}

export const estaEncendida = (clave) => clave in encendidas;

/** Intercambia el orden con la fuente vecina del grupo. */
export async function mover(clave, direccion) {
  const orden = items();
  const posicion = orden.findIndex((i) => i.id === clave);
  const vecina = orden[posicion + direccion];
  if (!vecina) return;
  const mio = encendidas[clave].orden ?? 0;
  encendidas[clave].orden = encendidas[vecina.id].orden ?? 0;
  encendidas[vecina.id].orden = mio;
  guardar();
  await alCambiar();
}

// ---------------------------------------------------------------------------
// Arranque
// ---------------------------------------------------------------------------
export async function inicializar(alCambiarCapas) {
  alCambiar = alCambiarCapas;
  $('externas').onclick = abrir;
  $('externas-cerrar').onclick = cerrar;
  // Si el navegador venia con fuentes encendidas hay que tener el catalogo
  // antes de pintar el panel, o no se sabria ni como se llaman.
  if (Object.keys(encendidas).length) await cargarCatalogo();
}

async function cargarCatalogo(forzar = false) {
  if (catalogo && !forzar) return catalogo;
  try {
    catalogo = await api('/api/externas');
  } catch (error) {
    avisar(`No se pudo leer el catálogo: ${error.message}`, true);
    catalogo = catalogo || { temas: [], fuentes: [], productos: [] };
  }
  return catalogo;
}

// ---------------------------------------------------------------------------
// Ventana del catalogo
// ---------------------------------------------------------------------------
export const estaAbierto = () => $('telon-externas').classList.contains('visible');

export function cerrar() {
  $('telon-externas').classList.remove('visible');
}

async function abrir() {
  $('telon-externas').classList.add('visible');
  $('externas-cuerpo').innerHTML = '<p class="vacio">Consultando el catálogo…</p>';
  // Se vuelve a pedir en cada apertura: lo que cambia entre una vez y otra es
  // justo lo que se viene a mirar, cuantos elementos hay y de cuando son.
  await cargarCatalogo(true);
  pintarCatalogo();
  // La ficha del evento y las novedades llegan de otros dos servidores: se
  // piden aparte para no retrasar la lista, que es a lo que se viene.
  ficha();
}

/** Cuenta cuantas hay y de cuando, sin volver a pedir los datos. */
function pista(fuente) {
  if (fuente.tipo === 'imagen') return 'ortoimagen';
  const total = totales[fuente.clave] ?? fuente.total;
  if (total == null) return '';
  const edad = fuente.descargado;
  const cuando = edad == null ? ''
    : edad < 90 ? ' · recién' : ` · hace ${Math.round(edad / 60)} min`;
  const fuera = sinUbicacion[fuente.clave] ?? fuente.sin_ubicacion ?? 0;
  return `${total.toLocaleString('es-CO')}${fuera ? ` +${fuera.toLocaleString('es-CO')} sin ubicar` : ''}${cuando}`;
}

function pintarCatalogo() {
  const texto = filtro.trim().toLowerCase();
  const coincide = (f) => !texto
    || `${f.nombre} ${f.organizacion} ${f.nota}`.toLowerCase().includes(texto);

  const secciones = catalogo.temas.map((tema) => {
    const suyas = catalogo.fuentes.filter((f) => f.tema === tema.clave && coincide(f));
    if (!suyas.length) return '';
    return `
      <section class="tema">
        <h3>${escapar(tema.titulo)}</h3>
        <p class="nota">${escapar(tema.descripcion)}</p>
        ${suyas.map(filaFuente).join('')}
      </section>`;
  }).join('');

  const productos = catalogo.productos.filter((p) =>
    !texto || `${p.nombre} ${p.organizacion}`.toLowerCase().includes(texto));

  $('externas-cuerpo').innerHTML = `
    <div id="externas-evento" class="evento">${evento ? textoEvento() : ''}</div>

    <input type="search" id="externas-buscar" placeholder="Buscar fuente…"
           value="${escapar(filtro)}" aria-label="Buscar en el catálogo">

    ${secciones || '<p class="vacio">Ninguna fuente coincide con la búsqueda.</p>'}

    ${productos.length ? `
      <section class="tema">
        <h3>Productos para descargar</h3>
        <p class="nota">
          No son servicios en vivo: se traen una vez y quedan como capas propias del
          equipo, con simbología, medición en 9377 y exportación.
        </p>
        ${productos.map(filaProducto).join('')}
      </section>` : ''}

    <section class="tema">
      <h3>Capas nuevas del programa DRP</h3>
      <p class="nota">
        Esri Colombia publica capas mientras dura la emergencia. Esto muestra las que
        todavía no están en el catálogo, para poder pedir que se integren.
      </p>
      <button id="externas-novedades" class="tenue">Buscar capas nuevas</button>
      <div id="externas-nuevas"></div>
    </section>`;

  cablear();
}

function filaFuente(fuente) {
  const activa = estaEncendida(fuente.clave);
  const integrable = fuente.tipo !== 'enlace';

  return `
    <div class="fuente ${activa ? 'activa' : ''} ${integrable ? '' : 'sin-integrar'}">
      <label class="casilla">
        <input type="checkbox" data-fuente="${escapar(fuente.clave)}"
               ${activa ? 'checked' : ''} ${integrable ? '' : 'disabled'}>
        <span class="titulo">${escapar(fuente.nombre)}</span>
      </label>
      <span class="marca-org">${escapar(fuente.organizacion)}</span>
      ${integrable ? `<span class="conteo">${escapar(pista(fuente))}</span>` : ''}
      ${fuente.nota ? `<p class="nota">${escapar(fuente.nota)}</p>` : ''}
      ${fuente.formulario ? `
        <a class="enlace" href="${escapar(fuente.formulario)}" target="_blank" rel="noopener"
           title="Abre el formulario de captura en una pestaña nueva">
          &#10010; Llenar el formulario</a>` : ''}
      ${fuente.motivo ? `
        <p class="nota aviso-tema">
          ${escapar(fuente.motivo)}
          <a href="${escapar(fuente.url)}" target="_blank" rel="noopener">ver el servicio</a>
        </p>` : ''}
    </div>`;
}

function filaProducto(producto) {
  const traible = producto.tipo !== 'enlace';
  return `
    <div class="fuente ${traible ? '' : 'sin-integrar'}">
      <span class="titulo">${escapar(producto.nombre)}</span>
      <span class="marca-org">${escapar(producto.organizacion)}</span>
      <span class="conteo">${producto.mb} MB</span>
      ${producto.nota ? `<p class="nota">${escapar(producto.nota)}</p>` : ''}
      ${producto.motivo ? `<p class="nota aviso-tema">${escapar(producto.motivo)}</p>` : ''}
      ${traible
        ? `<button data-producto="${escapar(producto.clave)}" class="tenue">Traer al visor</button>`
        : `<a class="enlace" href="${escapar(producto.url)}" target="_blank" rel="noopener">
             Descargar del origen</a>`}
    </div>`;
}

function textoEvento() {
  const g = evento.gdacs;
  const e = evento.ems;
  if (!g && !e) return '';
  const partes = [];
  if (g) {
    partes.push(`<strong>${escapar(g.nombre || 'Sismo')}</strong>`);
    if (g.magnitud) partes.push(`M ${escapar(String(g.magnitud))}`);
    if (g.fecha) partes.push(escapar(g.fecha.replace('T', ' ').slice(0, 16)));
  }
  if (e) {
    partes.push(`Copernicus ${escapar(e.codigo)} ` +
                `${e.cerrada ? 'cerrada' : 'activa'} · ${e.aois.length} AOI`);
  }
  return `<p>${partes.join(' · ')}</p>`;
}

async function ficha() {
  if (evento) return;
  try {
    evento = await api('/api/externas/evento');
  } catch { return; }              // el catalogo funciona igual sin la ficha
  const caja = $('externas-evento');
  if (caja) caja.innerHTML = textoEvento();
}

function cablear() {
  const cuerpo = $('externas-cuerpo');

  const buscador = $('externas-buscar');
  buscador.oninput = (e) => {
    filtro = e.target.value;
    pintarCatalogo();
    // Repintar mata el foco; devolverlo es lo que permite seguir escribiendo.
    const nuevo = $('externas-buscar');
    nuevo.focus();
    nuevo.setSelectionRange(nuevo.value.length, nuevo.value.length);
  };

  cuerpo.querySelectorAll('input[data-fuente]').forEach((control) => {
    control.onchange = async (e) => {
      const clave = e.target.dataset.fuente;
      const encender_ = e.target.checked;
      control.disabled = true;
      try {
        if (encender_) await encender(clave); else await apagar(clave);
      } catch (error) {
        // La fuente esta caida o devolvio algo raro: se deja la casilla como
        // estaba, porque encenderla sin datos solo confundiria.
        avisar(error.message, true);
        control.checked = !encender_;
        control.disabled = false;
        return;
      }
      control.disabled = false;
      pintarCatalogo();
      if (encender_) {
        const total = totales[clave];
        avisar(`"${fuenteDe(clave).nombre}" en el panel de capas` +
               (total != null ? ` · ${total.toLocaleString('es-CO')} elementos.` : '.'));
      }
    };
  });

  cuerpo.querySelectorAll('button[data-producto]').forEach((boton) => {
    boton.onclick = () => traer(boton);
  });

  const buscarNuevas = $('externas-novedades');
  if (buscarNuevas) buscarNuevas.onclick = () => novedades(buscarNuevas);
}

async function traer(boton) {
  const clave = boton.dataset.producto;
  const producto = catalogo.productos.find((p) => p.clave === clave);
  if (!confirm(`Traer "${producto.nombre}" (${producto.mb} MB) al visor?`)) return;

  boton.disabled = true;
  boton.textContent = 'Trayendo…';
  try {
    const salida = await api(`/api/externas/productos/${clave}/importar`, { method: 'POST' });
    if (salida.capas) {
      const total = salida.capas.reduce((suma, c) => suma + c.insertados, 0);
      avisar(`${salida.capas.length} capas nuevas · ${total.toLocaleString('es-CO')} entidades.`);
    } else {
      avisar('Imagen recibida. Se está preparando en segundo plano.');
    }
    boton.textContent = 'Traído';
    await alCambiar();
  } catch (error) {
    avisar(error.message, true);
    boton.disabled = false;
    boton.textContent = 'Traer al visor';
  }
}

async function novedades(boton) {
  boton.disabled = true;
  boton.textContent = 'Consultando…';
  const caja = $('externas-nuevas');
  try {
    const salida = await api('/api/externas/novedades');
    caja.innerHTML = salida.nuevas.length
      ? salida.nuevas.map((n) => `
          <div class="fuente sin-integrar">
            <span class="titulo">${escapar(n.titulo || 'Sin título')}</span>
            <span class="conteo">${new Date(n.modificado).toLocaleDateString('es-CO')}</span>
            ${n.descripcion ? `<p class="nota">${escapar(n.descripcion)}</p>` : ''}
          </div>`).join('')
      : '<p class="vacio">El catálogo está al día.</p>';
  } catch (error) {
    caja.innerHTML = `<p class="vacio">${escapar(error.message)}</p>`;
  }
  boton.disabled = false;
  boton.textContent = 'Buscar capas nuevas';
}

// ---------------------------------------------------------------------------
// Copia fechada
// ---------------------------------------------------------------------------

/** Congela la fuente tal como esta ahora, como capa propia del equipo. */
export async function copiar(item) {
  const nombre = prompt('Nombre de la copia:',
    `${item.nombre} · ${new Date().toLocaleDateString('es-CO')}`);
  if (!nombre) return;
  try {
    const salida = await api(`/api/externas/${item.id}/copiar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nombre }),
    });
    avisar(`Copiadas ${salida.insertados.toLocaleString('es-CO')} entidades a "${salida.nombre}".`);
    await alCambiar();
  } catch (error) { avisar(error.message, true); }
}

// ---------------------------------------------------------------------------
// Ficha de un elemento externo
// ---------------------------------------------------------------------------

/** Ids de las capas del mapa que responden al clic. Lo usa app.js. */
export const consultables = () => capasExternasConsultables();

/** Abre el globo de un elemento externo. `id` es 'ext-<clave>-punto'. */
export function mostrar(elemento, lngLat) {
  const clave = elemento.layer.id.replace(/^ext-/, '').replace(/-(relleno|borde|punto)$/, '');
  const fuente = fuenteDe(clave);
  if (!fuente) return;

  const propiedades = elemento.properties || {};
  const orden = fuente.campos.length ? fuente.campos : Object.keys(propiedades);
  const titulo = propiedades[fuente.titulo] || fuente.nombre;

  const filas = orden
    .filter((campo) => campo !== fuente.titulo)
    .map((campo) => [campo, propiedades[campo]])
    .filter(([, valor]) => valor !== undefined && valor !== null && valor !== '')
    .map(([campo, valor]) => `
      <tr><th>${escapar(campo)}</th><td>${valorHtml(valor)}</td></tr>`)
    .join('');

  if (globo) globo.remove();
  globo = new maplibregl.Popup({ maxWidth: '340px', closeButton: true })
    .setLngLat(lngLat)
    .setHTML(`
      <div class="globo">
        <h3>${escapar(String(titulo))}</h3>
        <p class="origen">${escapar(fuente.nombre)} · ${escapar(fuente.organizacion)}</p>
        <table>${filas}</table>
      </div>`)
    .addTo(mapa);
}

/** Los enlaces se dejan navegables: media capa trae la nota de prensa o el
 *  video de campo del que sale el dato, y ahi es donde se verifica. */
function valorHtml(valor) {
  const texto = String(valor);
  if (/^https?:\/\//i.test(texto)) {
    return `<a href="${escapar(texto)}" target="_blank" rel="noopener">abrir</a>`;
  }
  return escapar(texto.length > 400 ? `${texto.slice(0, 400)}…` : texto);
}

export function cerrarGlobo() {
  if (globo) { globo.remove(); globo = null; }
}
