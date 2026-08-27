/* Orquestador del visor. */

import { api, avisar, escapar, descargarArchivo, numero, $ } from './util.js';
import {
  mapa, inicializarFuentes, capasConsultables, refrescarDatos, refrescarExternas,
  cambiarBase, baseGuardada, prepararBases, irA, seguirCursor,
} from './mapa.js';
import * as capas from './capas.js';
import * as dibujo from './dibujo.js';
import * as ficha from './ficha.js';
import * as subidas from './subidas.js';
import * as comparar from './comparar.js';
import * as simbologia from './simbologia.js';
import * as bandas from './bandas.js';
import * as externas from './externas.js';
import * as tabla from './tabla.js';
import { PRIORITARIAS, RESTO, COLOMBIA } from './ciudades.js';
import * as coordenadas from './coordenadas.js';
import { a9377 } from './proyeccion.js';

// ---------------------------------------------------------------------------
// Arranque
// ---------------------------------------------------------------------------
mapa.on('load', async () => {
  inicializarFuentes();
  cambiarBase(baseGuardada());
  // Los mapas base claros son vectoriales y hay que ir a buscarlos. NO se
  // espera aqui: el visor arranca igual y ellos aparecen cuando llegan.
  prepararBases();
  seguirCursor();
  dibujo.inicializar();
  comparar.inicializar();
  tabla.inicializar();

  dibujo.alGuardarElemento(() => capas.cargar());
  ficha.alBorrarElemento(() => capas.cargar());

  // Antes de la primera carga: si este navegador venia con fuentes externas
  // encendidas, tienen que estar en la lista desde el primer pintado.
  await externas.inicializar(() => capas.cargar());
  await capas.cargar();
});

// ---------------------------------------------------------------------------
// Seleccion de elementos
// ---------------------------------------------------------------------------
/** Todo lo que responde al clic: lo dibujado por el equipo y lo externo. */
const consultables = () => [...capasConsultables(), ...externas.consultables()];

mapa.on('click', (evento) => {
  if (dibujo.dibujando()) return;

  const capasVivas = consultables();
  if (!capasVivas.length) return;

  // Un margen de 4 px hace que tocar una linea o un punto fino funcione con
  // el dedo, no solo con raton fino.
  const caja = [
    [evento.point.x - 4, evento.point.y - 4],
    [evento.point.x + 4, evento.point.y + 4],
  ];
  // Se pregunta por todo de una vez para que gane lo que este dibujado
  // encima. Consultando primero lo propio, un poligono grande del equipo
  // taparia el punto externo que cae justo sobre el.
  const encontrados = mapa.queryRenderedFeatures(caja, { layers: capasVivas });
  if (!encontrados.length) { ficha.cerrar(); externas.cerrarGlobo(); return; }

  const elegido = encontrados[0];
  if (elegido.layer.id.startsWith('ext-')) {
    ficha.cerrar();
    externas.mostrar(elegido, evento.lngLat);
  } else {
    externas.cerrarGlobo();
    ficha.abrir(elegido.properties.id);
  }
});

mapa.on('mousemove', (evento) => {
  if (dibujo.dibujando()) return;
  const capasVivas = consultables();
  if (!capasVivas.length) return;
  const encima = mapa.queryRenderedFeatures(evento.point, { layers: capasVivas }).length > 0;
  mapa.getCanvas().style.cursor = encima ? 'pointer' : '';
});

$('ficha-cerrar').onclick = () => ficha.cerrar();

// ---------------------------------------------------------------------------
// Ciudades
// ---------------------------------------------------------------------------
function montarCiudades() {
  const selector = $('ciudad');
  const opcion = (lugar) => `<option value="${escapar(lugar.nombre)}">${escapar(lugar.nombre)}</option>`;

  selector.innerHTML = `
    <option value="">Ir a…</option>
    <optgroup label="Zona afectada">${PRIORITARIAS.map(opcion).join('')}</optgroup>
    <optgroup label="Resto del país">${RESTO.map(opcion).join('')}</optgroup>
    <optgroup label="General">${opcion(COLOMBIA)}</optgroup>`;

  selector.onchange = (evento) => {
    const lugar = [...PRIORITARIAS, ...RESTO, COLOMBIA].find((l) => l.nombre === evento.target.value);
    if (lugar) irA(lugar);
    evento.target.value = '';
  };
}
montarCiudades();

// ---------------------------------------------------------------------------
// Ir a unas coordenadas
// ---------------------------------------------------------------------------
// El marcador es de esta pestana y de este momento: no se guarda ni lo ve
// nadie mas. Para dejar constancia de un sitio estan las capas de dibujo.
let marcador = null;

function quitarMarcador() {
  marcador?.remove();
  marcador = null;
  $('ir-a-quitar').hidden = true;
}

function marcar(lat, lon) {
  quitarMarcador();
  const { este, norte } = a9377(lon, lat);
  // Una linea por dato: juntando el Este y el Norte, el globo parte la cifra
  // en dos renglones y deja de poderse leer de un vistazo.
  const globo = new maplibregl.Popup({ offset: 28, closeButton: false, maxWidth: '280px' })
    .setHTML(`
      <div class="globo-coord">
        <div><span class="rotulo">WGS84</span> ${lat.toFixed(6)}, ${lon.toFixed(6)}</div>
        <div><span class="rotulo">9377 E</span> ${numero(este, 1)}</div>
        <div><span class="rotulo">9377 N</span> ${numero(norte, 1)}</div>
      </div>`);

  marcador = new maplibregl.Marker({ color: '#ffd166' })
    .setLngLat([lon, lat])
    .setPopup(globo)
    .addTo(mapa);
  marcador.togglePopup();

  mapa.flyTo({ center: [lon, lat], zoom: 17, speed: 1.6 });
  $('ir-a-quitar').hidden = false;
}

/** Aviso propio de la barra, para lo que necesita un boton y no cabe en un toast. */
function anotar(html) {
  const nota = $('ir-a-nota');
  nota.innerHTML = html;
  nota.hidden = !html;
  // Al crecer la barra taparia los botones de zoom, que estan dentro del mapa
  // y no se pueden alcanzar con un selector desde aqui. La marca va al body.
  document.body.classList.toggle('con-nota', !!html);
}

function irACoordenadas() {
  anotar('');
  const leido = coordenadas.interpretar($('ir-a-texto').value);
  if (leido.vacio) return;
  if (leido.error) { anotar(escapar(leido.error)); return; }

  marcar(leido.lat, leido.lon);

  if (leido.invertible) {
    // Poner la latitud donde va la longitud es el error mas comun al copiar,
    // y se corrige solo: se ofrece hecho en vez de limitarse a rechazar.
    const alReves = `${leido.lon}, ${leido.lat}`;
    anotar(`Ese punto cae fuera de Colombia.
            <button type="button" id="ir-a-invertir">¿Querías ${escapar(alReves)}?</button>`);
    $('ir-a-invertir').onclick = () => {
      $('ir-a-texto').value = alReves;
      irACoordenadas();
    };
  } else if (leido.fuera) {
    anotar('Marcado, pero queda fuera de Colombia.');
  }
}

$('ir-a-buscar').onclick = irACoordenadas;
$('ir-a-texto').onkeydown = (evento) => {
  if (evento.key === 'Enter') irACoordenadas();
};
$('ir-a-quitar').onclick = () => { quitarMarcador(); anotar(''); };

// ---------------------------------------------------------------------------
// Mapas base
// ---------------------------------------------------------------------------
// «sinfondo» esta en la lista aunque su boton salga oculto: aparece solo
// mientras hay un modelo 3D encendido, y para entonces ya tiene que estar
// cableado. Lo ensena y lo esconde modelo3d.js.
for (const clave of ['claro', 'oscuro', 'satelite', 'sinfondo']) {
  $(`base-${clave}`).onclick = () => cambiarBase(clave);
}

// ---------------------------------------------------------------------------
// Crear capa
// ---------------------------------------------------------------------------
$('crear-capa').onclick = async () => {
  const nombre = $('nueva-capa-nombre').value.trim();
  if (!nombre) { avisar('Ponle un nombre a la capa.', true); return; }
  try {
    await capas.crearCapa(nombre, $('nueva-capa-color').value);
    $('nueva-capa-nombre').value = '';
    avisar(`Capa "${nombre}" creada.`);
  } catch (error) { avisar(error.message, true); }
};

// ---------------------------------------------------------------------------
// Cargas
// ---------------------------------------------------------------------------
subidas.alTerminarSubida(async (resultado) => {
  if (resultado.tipo === 'vector') {
    avisar(`Cargadas ${resultado.insertados} entidades` +
           (resultado.omitidos ? ` · ${resultado.omitidos} omitidas` : '') + '.');
    refrescarDatos();
  } else {
    avisar('Ráster recibido. Se está convirtiendo en segundo plano.');
  }
  await capas.cargar();
});

/** Las dos cargas usan el mismo camino: trozos reanudables, varios a la vez. */
async function cargarArchivo({ campoArchivo, campoNombre, boton, tipo, queEs }) {
  const archivos = [...$(campoArchivo).files];
  const nombre = $(campoNombre).value.trim();
  if (!archivos.length) { avisar(`Elige ${queEs}.`, true); return; }
  // Con varios archivos el nombre de cada capa sale del propio archivo, asi
  // que el campo pasa a ser opcional.
  if (!nombre && archivos.length === 1) { avisar('Ponle nombre a la capa.', true); return; }

  const control = $(boton);
  control.disabled = true;

  const resultado = await subidas.subirVarios(archivos, nombre, tipo);
  if (archivos.length > 1) {
    avisar(`${resultado.bien} de ${archivos.length} cargados` +
           (resultado.mal ? ` · ${resultado.mal} con problemas` : '') + '.',
           resultado.mal > 0);
  }

  $(campoArchivo).value = '';
  $(campoNombre).value = '';
  control.disabled = false;
}

$('subir-vector').onclick = () => cargarArchivo({
  campoArchivo: 'archivo-vector', campoNombre: 'nombre-capa-vector',
  boton: 'subir-vector', tipo: 'vector', queEs: 'un archivo GeoJSON',
});

$('subir-raster').onclick = () => cargarArchivo({
  campoArchivo: 'archivo-raster', campoNombre: 'nombre-capa-raster',
  boton: 'subir-raster', tipo: 'raster', queEs: 'un GeoTIFF',
});

// ---------------------------------------------------------------------------
// Importar del servidor (escenas grandes dejadas por scp)
// ---------------------------------------------------------------------------
async function listarEntrada() {
  const lista = $('lista-entrada');
  try {
    const archivos = await api('/api/rasters/disponibles');
    if (!archivos.length) {
      lista.innerHTML = '<p class="vacio">No hay archivos en la carpeta de entrada.</p>';
      return;
    }
    lista.innerHTML = '';
    for (const item of archivos) {
      const fila = document.createElement('div');
      fila.className = 'entrada-fila';
      fila.innerHTML = `
        <span class="nombre" title="${escapar(item.archivo)}">${escapar(item.archivo)}</span>
        <span class="conteo">${item.mb} MB</span>
        <button>Importar</button>`;
      fila.querySelector('button').onclick = async (evento) => {
        const nombre = prompt('Nombre para esta capa:', item.archivo.replace(/\.[^.]+$/, ''));
        if (!nombre) return;
        evento.target.disabled = true;
        evento.target.textContent = 'Importando…';
        try {
          await api('/api/rasters/importar', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ archivo: item.archivo, nombre }),
          });
          avisar('Importado. Se está preparando en segundo plano.');
          await Promise.all([capas.cargar(), listarEntrada()]);
        } catch (error) {
          avisar(error.message, true);
          evento.target.disabled = false;
          evento.target.textContent = 'Importar';
        }
      };
      lista.appendChild(fila);
    }
  } catch (error) { avisar(error.message, true); }
}
$('buscar-entrada').onclick = listarEntrada;

// ---------------------------------------------------------------------------
// Descargas
// ---------------------------------------------------------------------------
// Sin capa_id: todo el dibujo en un archivo. Bajar UNA capa suelta vive en
// las opciones de esa capa, dentro del panel de capas, que es donde se la
// esta mirando cuando surge la necesidad.
const descargarTodo = (srid) => descargarArchivo(
  `/api/export/geojson?srid=${srid}`,
  srid === 9377
    ? 'Descargando todo el dibujo en GeoJSON oficial (EPSG:9377).'
    : 'Descargando todo el dibujo en GeoJSON WGS84.');

$('exportar-9377').onclick = () => descargarTodo(9377);
$('exportar-4326').onclick = () => descargarTodo(4326);

// ---------------------------------------------------------------------------
// Rail, sesion y teclado
// ---------------------------------------------------------------------------
$('alternar').onclick = () => $('rail').classList.toggle('oculto');
$('refrescar').onclick = async () => {
  refrescarDatos();
  await capas.cargar();
  refrescarExternas();
  avisar('Datos actualizados.');
};

$('salir').onclick = async () => {
  await fetch('/api/logout', { method: 'POST' });
  location.href = '/login.html';
};

// ---------------------------------------------------------------------------
// Simbologia y leyenda
// ---------------------------------------------------------------------------
$('sim-cerrar').onclick = () => simbologia.cerrar();
$('bandas-cerrar').onclick = () => bandas.cerrar();

// La leyenda se pliega y se recuerda plegada: en un portatil de 13" sobre el
// terreno, cada centimetro de mapa cuenta.
const plegada = localStorage.getItem('geovisor.leyenda') === 'plegada';
$('leyenda').classList.toggle('plegada', plegada);
$('leyenda-plegar').setAttribute('aria-expanded', String(!plegada));
$('leyenda-plegar').onclick = () => {
  const ahora = $('leyenda').classList.toggle('plegada');
  $('leyenda-plegar').setAttribute('aria-expanded', String(!ahora));
  localStorage.setItem('geovisor.leyenda', ahora ? 'plegada' : 'abierta');
};

document.addEventListener('keydown', (evento) => {
  if (evento.key !== 'Escape') return;
  if (bandas.estaAbierto()) bandas.cerrar();
  else if (simbologia.estaAbierto()) simbologia.cerrar();
  else if (externas.estaAbierto()) externas.cerrar();
  else if ($('telon-comparar').classList.contains('visible')) {
    $('telon-comparar').classList.remove('visible');
  } else if (dibujo.hayModal()) dibujo.cerrarModal();
  else if (dibujo.dibujando()) dibujo.activar(null);
  else if (comparar.estaActiva()) comparar.desactivar();
  else if (tabla.estaAbierta()) tabla.cerrar();
  else { ficha.cerrar(); externas.cerrarGlobo(); }
});

// Comprobacion de sesion antes de mostrar nada.
(async () => {
  try {
    const sesion = await api('/api/session');
    $('quien').textContent = sesion.autor || 'sin identificar';
    if (window.innerWidth <= 720) $('rail').classList.add('oculto');
  } catch { /* api() ya redirigio al login */ }
})();
