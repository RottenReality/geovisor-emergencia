/* Orquestador del visor. */

import { api, avisar, escapar, $ } from './util.js';
import {
  mapa, inicializarFuentes, capasConsultables, refrescarDatos,
  cambiarBase, baseGuardada, irA, seguirCursor,
} from './mapa.js';
import * as capas from './capas.js';
import * as dibujo from './dibujo.js';
import * as ficha from './ficha.js';
import * as subidas from './subidas.js';
import { PRIORITARIAS, RESTO, COLOMBIA } from './ciudades.js';

// ---------------------------------------------------------------------------
// Arranque
// ---------------------------------------------------------------------------
mapa.on('load', async () => {
  inicializarFuentes();
  cambiarBase(baseGuardada());
  seguirCursor();
  dibujo.inicializar();

  dibujo.alGuardarElemento(() => capas.cargar());
  ficha.alBorrarElemento(() => capas.cargar());

  await capas.cargar();
});

// ---------------------------------------------------------------------------
// Seleccion de elementos
// ---------------------------------------------------------------------------
mapa.on('click', (evento) => {
  if (dibujo.dibujando()) return;

  const consultables = capasConsultables();
  if (!consultables.length) return;

  // Un margen de 4 px hace que tocar una linea o un punto fino funcione con
  // el dedo, no solo con raton fino.
  const caja = [
    [evento.point.x - 4, evento.point.y - 4],
    [evento.point.x + 4, evento.point.y + 4],
  ];
  const encontrados = mapa.queryRenderedFeatures(caja, { layers: consultables });
  if (!encontrados.length) { ficha.cerrar(); return; }

  ficha.abrir(encontrados[0].properties.id);
});

mapa.on('mousemove', (evento) => {
  if (dibujo.dibujando()) return;
  const consultables = capasConsultables();
  if (!consultables.length) return;
  const encima = mapa.queryRenderedFeatures(evento.point, { layers: consultables }).length > 0;
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
// Mapas base
// ---------------------------------------------------------------------------
for (const clave of ['claro', 'oscuro', 'satelite']) {
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

/** Las dos cargas usan el mismo camino: trozos reanudables. */
async function cargarArchivo({ campoArchivo, campoNombre, boton, tipo, queEs }) {
  const archivo = $(campoArchivo).files[0];
  const nombre = $(campoNombre).value.trim();
  if (!archivo) { avisar(`Elige ${queEs}.`, true); return; }
  if (!nombre) { avisar('Ponle nombre a la capa.', true); return; }

  const control = $(boton);
  control.disabled = true;
  try {
    await subidas.subir(archivo, nombre, tipo);
    $(campoArchivo).value = '';
    $(campoNombre).value = '';
  } catch { /* el panel de subidas ya muestra el fallo */ }
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
function descargar(srid) {
  const enlace = document.createElement('a');
  enlace.href = `/api/export/geojson?srid=${srid}`;
  enlace.download = '';
  document.body.appendChild(enlace);
  enlace.click();
  enlace.remove();
  avisar(srid === 9377 ? 'Descargando GeoJSON oficial (EPSG:9377).' : 'Descargando GeoJSON WGS84.');
}
$('exportar-9377').onclick = () => descargar(9377);
$('exportar-4326').onclick = () => descargar(4326);

// ---------------------------------------------------------------------------
// Rail, sesion y teclado
// ---------------------------------------------------------------------------
$('alternar').onclick = () => $('rail').classList.toggle('oculto');
$('refrescar').onclick = async () => {
  refrescarDatos();
  await capas.cargar();
  avisar('Datos actualizados.');
};

$('salir').onclick = async () => {
  await fetch('/api/logout', { method: 'POST' });
  location.href = '/login.html';
};

document.addEventListener('keydown', (evento) => {
  if (evento.key !== 'Escape') return;
  if (dibujo.hayModal()) dibujo.cerrarModal();
  else if (dibujo.dibujando()) dibujo.activar(null);
  else ficha.cerrar();
});

// Comprobacion de sesion antes de mostrar nada.
(async () => {
  try {
    const sesion = await api('/api/session');
    $('quien').textContent = sesion.autor || 'sin identificar';
    if (window.innerWidth <= 720) $('rail').classList.add('oculto');
  } catch { /* api() ya redirigio al login */ }
})();
