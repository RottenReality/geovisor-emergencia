/* Orquestador del visor. */

import { api, avisar, escapar, $ } from './util.js';
import {
  mapa, inicializarFuentes, capasConsultables, refrescarDatos,
  cambiarBase, baseGuardada, irA, seguirCursor,
} from './mapa.js';
import * as capas from './capas.js';
import * as dibujo from './dibujo.js';
import * as ficha from './ficha.js';
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
$('subir-vector').onclick = async () => {
  const archivo = $('archivo-vector').files[0];
  const nombre = $('nombre-capa-vector').value.trim();
  if (!archivo) { avisar('Elige un archivo GeoJSON.', true); return; }
  if (!nombre) { avisar('Ponle nombre a la capa.', true); return; }

  const boton = $('subir-vector');
  boton.disabled = true;
  boton.textContent = 'Cargando…';

  const cuerpo = new FormData();
  cuerpo.append('archivo', archivo);
  cuerpo.append('nombre_capa', nombre);
  cuerpo.append('color', $('nueva-capa-color').value);

  try {
    const resultado = await api('/api/upload/vector', { method: 'POST', body: cuerpo });
    avisar(`Cargadas ${resultado.insertados} entidades` +
           (resultado.omitidos ? ` · ${resultado.omitidos} omitidas` : '') + '.');
    $('archivo-vector').value = '';
    $('nombre-capa-vector').value = '';
    refrescarDatos();
    await capas.cargar();
  } catch (error) { avisar(error.message, true); }

  boton.disabled = false;
  boton.textContent = 'Cargar GeoJSON';
};

$('subir-raster').onclick = () => {
  const archivo = $('archivo-raster').files[0];
  const nombre = $('nombre-capa-raster').value.trim();
  if (!archivo) { avisar('Elige un GeoTIFF.', true); return; }
  if (!nombre) { avisar('Ponle nombre al ráster.', true); return; }

  const boton = $('subir-raster');
  const barra = $('progreso-raster');
  boton.disabled = true;
  barra.hidden = false;
  barra.value = 0;

  const cuerpo = new FormData();
  cuerpo.append('archivo', archivo);
  cuerpo.append('nombre', nombre);

  // XMLHttpRequest y no fetch: es la unica forma de tener progreso real de
  // subida, y una ortofoto de varios cientos de MB por una conexion de campo
  // sin barra de progreso parece un cuelgue.
  const peticion = new XMLHttpRequest();
  peticion.open('POST', '/api/rasters');

  peticion.upload.onprogress = (evento) => {
    if (!evento.lengthComputable) return;
    barra.value = Math.round((evento.loaded / evento.total) * 100);
    boton.textContent = `Subiendo ${barra.value}%`;
  };

  peticion.onload = async () => {
    boton.disabled = false;
    boton.textContent = 'Cargar ráster';
    barra.hidden = true;
    if (peticion.status === 401) { location.href = '/login.html'; return; }
    if (peticion.status >= 400) {
      let detalle = `Error ${peticion.status}`;
      try { detalle = JSON.parse(peticion.responseText).detail || detalle; } catch { /* sin json */ }
      avisar(detalle, true);
      return;
    }
    avisar('Ráster recibido. Se está convirtiendo a COG en segundo plano.');
    $('archivo-raster').value = '';
    $('nombre-capa-raster').value = '';
    await capas.cargar();
  };

  peticion.onerror = () => {
    boton.disabled = false;
    boton.textContent = 'Cargar ráster';
    barra.hidden = true;
    avisar('Se cortó la conexión durante la subida.', true);
  };

  peticion.send(cuerpo);
};

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
