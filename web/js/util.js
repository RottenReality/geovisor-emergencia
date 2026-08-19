/* Utilidades compartidas. */

export const $ = (id) => document.getElementById(id);

let temporizador;

export function avisar(texto, esError = false) {
  const aviso = $('aviso');
  aviso.textContent = texto;
  aviso.classList.toggle('error', esError);
  aviso.classList.add('visible');
  clearTimeout(temporizador);
  temporizador = setTimeout(() => aviso.classList.remove('visible'), esError ? 6000 : 4000);
}

/** Texto del error que manda el servidor.
 *
 * Casi siempre `detail` es una frase y basta con mostrarla. Pero cuando FastAPI
 * rechaza el cuerpo por validacion llega como lista de objetos, y meterla tal
 * cual en un Error la convierte en "[object Object]": quien sube ve un mensaje
 * indescifrable y encima se pierde el unico dato que importaba, que campo
 * fallo. Aqui se rescata.
 */
function detalleDeError(cuerpo, estado) {
  const detalle = cuerpo?.detail;
  if (typeof detalle === 'string' && detalle) return detalle;
  if (Array.isArray(detalle) && detalle.length) {
    return detalle
      .map((fallo) => {
        // loc viene como ['body', 'tamano']; 'body' no le dice nada a nadie.
        const campo = (fallo?.loc || []).filter((parte) => parte !== 'body').join('.');
        return campo ? `${campo}: ${fallo?.msg}` : String(fallo?.msg ?? fallo);
      })
      .join('; ');
  }
  return `Error ${estado}`;
}

/** fetch con manejo central del 401: si la sesion caduca, al login. */
export async function api(ruta, opciones = {}) {
  const respuesta = await fetch(ruta, opciones);
  if (respuesta.status === 401) {
    location.href = '/login.html';
    throw new Error('Sesion expirada');
  }
  if (!respuesta.ok) {
    const cuerpo = await respuesta.json().catch(() => ({}));
    throw new Error(detalleDeError(cuerpo, respuesta.status));
  }
  return respuesta.status === 204 ? null : respuesta.json();
}

/** Dispara una descarga del navegador sin sacar a nadie del visor.
 *
 * Un <a download> y no un fetch(): el enlace viaja con la cookie de sesion,
 * deja el progreso y la reanudacion en manos del navegador, y respeta el
 * nombre que manda el servidor en Content-Disposition. Bajar un COG de 1,8 GB
 * por fetch() lo cargaria entero en memoria antes de guardar el primer byte.
 */
export function descargarArchivo(url, mensaje, nombre = '') {
  const enlace = document.createElement('a');
  enlace.href = url;
  // Vacio = manda el Content-Disposition del servidor. Solo hay que dar el
  // nombre a mano cuando la url es un blob:, que no lleva cabeceras.
  enlace.download = nombre;
  document.body.appendChild(enlace);
  enlace.click();
  enlace.remove();
  if (mensaje) avisar(mensaje);
}

export function escapar(texto) {
  const div = document.createElement('div');
  div.textContent = texto;
  return div.innerHTML;
}

export const numero = (valor, decimales = 1) =>
  Number(valor).toLocaleString('es-CO', {
    minimumFractionDigits: decimales,
    maximumFractionDigits: decimales,
  });

export const formatearLongitud = (m) =>
  m < 1000 ? `${numero(m, 0)} m` : `${numero(m / 1000, 2)} km`;

export const formatearArea = (m2) =>
  m2 < 10000 ? `${numero(m2, 0)} m²` : `${numero(m2 / 10000, 2)} ha`;

/** Peso de un archivo, para rotular el boton que lo baja. */
export const formatearPeso = (mb) => {
  if (mb == null) return '';
  if (mb >= 1024) return `${numero(mb / 1024, 1)} GB`;
  return `${numero(mb, mb < 10 ? 1 : 0)} MB`;
};

// --- Medicion geodesica ----------------------------------------------------
// Solo para el rotulo en vivo mientras se dibuja. Las cifras oficiales las
// calcula PostGIS sobre EPSG:9377; estas son una aproximacion esferica,
// suficiente para orientar a quien esta dibujando.
const RADIO_TIERRA = 6371008.8;   // radio medio IUGG, metros
const RAD = Math.PI / 180;

export function distancia(a, b) {
  const dLat = (b[1] - a[1]) * RAD;
  const dLng = (b[0] - a[0]) * RAD;
  const h = Math.sin(dLat / 2) ** 2 +
            Math.cos(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * RADIO_TIERRA * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function longitudDe(coordenadas) {
  let total = 0;
  for (let i = 1; i < coordenadas.length; i++) total += distancia(coordenadas[i - 1], coordenadas[i]);
  return total;
}

export function areaDe(anillo) {
  if (anillo.length < 3) return 0;
  let total = 0;
  for (let i = 0; i < anillo.length; i++) {
    const [x1, y1] = anillo[i];
    const [x2, y2] = anillo[(i + 1) % anillo.length];
    total += (x2 - x1) * RAD * (2 + Math.sin(y1 * RAD) + Math.sin(y2 * RAD));
  }
  return Math.abs(total * RADIO_TIERRA * RADIO_TIERRA / 2);
}
