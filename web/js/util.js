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

/**
 * Texto seguro para meter en HTML, incluido DENTRO de un atributo.
 *
 * Antes esto creaba un <div>, le ponia el texto y devolvia su innerHTML. Eso
 * escapa &, < y >, pero NO las comillas, y aqui se usa sobre todo dentro de
 * atributos: value="...", title="...". Un nombre de capa con una comilla
 * cerraba el atributo antes de tiempo; lo visible era que el nombre salia
 * cortado, y lo no visible es que el resto se colaba como atributos sueltos.
 * Los nombres de las capas los escribe el equipo, asi que no era hipotetico.
 *
 * De paso deja de tocar el DOM: el panel llama a esto cientos de veces en
 * cada repintado, y crear un elemento por llamada era trabajo regalado.
 */
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export const escapar = (texto) =>
  String(texto ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);

export const numero = (valor, decimales = 1) =>
  Number(valor).toLocaleString('es-CO', {
    minimumFractionDigits: decimales,
    maximumFractionDigits: decimales,
  });

/**
 * Longitud legible.
 *
 * Los tramos cortos llevan decimales y por debajo del metro se pasa a
 * centimetros. Antes cualquier cosa menor de medio metro salia como «0 m»,
 * que es exactamente lo que hace falta leer al medir el ancho de una grieta
 * sobre el modelo 3D. Por encima de diez metros se vuelve a numeros redondos:
 * ahi el centimetro es precision falsa.
 */
export const formatearLongitud = (m) => {
  if (!Number.isFinite(m)) return '—';
  if (m < 1) return `${numero(m * 100, 0)} cm`;
  if (m < 10) return `${numero(m, 2)} m`;
  if (m < 1000) return `${numero(m, 0)} m`;
  return `${numero(m / 1000, 2)} km`;
};

/**
 * Distancia entre dos puntos con altura, en metros.
 *
 * Se compone la horizontal con el desnivel. Para los tramos de los que se
 * habla aqui -metros, no kilometros- tratar el par como un triangulo recto es
 * exacto de sobra, y es lo que hace falta: una grieta que baja por una
 * fachada mide casi cero en planta y su longitud entera es el desnivel.
 */
export function distancia3d(a, b) {
  const plano = distancia(a, b);
  const desnivel = (b[2] || 0) - (a[2] || 0);
  return Math.hypot(plano, desnivel);
}

export function longitud3dDe(coordenadas) {
  let total = 0;
  for (let i = 1; i < coordenadas.length; i++) {
    total += distancia3d(coordenadas[i - 1], coordenadas[i]);
  }
  return total;
}

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
