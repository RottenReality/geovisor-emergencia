/* Lectura de coordenadas escritas o pegadas a mano.
 *
 * Modulo puro: no toca el DOM, no toca el mapa y no importa nada. Asi se
 * prueba entero con `node --test pruebas/`, que es donde de verdad hace falta
 * cubrirse: el texto lo teclea o lo pega una persona con prisa desde Google
 * Maps, desde WhatsApp o dictado por radio, y cada fuente lo escribe distinto.
 *
 * Siempre se devuelve un objeto, nunca se lanza:
 *
 *   { vacio: true }                        no hay nada que leer
 *   { error: 'motivo en castellano' }      hay texto pero no son coordenadas
 *   { lat, lon, fuera, invertible }        se pudo leer
 *
 * `fuera` avisa de que el punto cae fuera de Colombia e `invertible` de que,
 * intercambiando latitud y longitud, caeria dentro: es el error mas comun al
 * copiar, y conviene ofrecer la correccion en vez de limitarse a rechazar.
 */

// Colombia con holgura: incluye San Andres al noroeste, Leticia al sur y la
// frontera con Venezuela al este. Solo sirve para sospechar, no para validar.
const COLOMBIA = { oeste: -82.2, este: -66.5, sur: -4.5, norte: 13.6 };

export const dentroDeColombia = (lat, lon) =>
  lat >= COLOMBIA.sur && lat <= COLOMBIA.norte
  && lon >= COLOMBIA.oeste && lon <= COLOMBIA.este;

const NUM = String.raw`\d+(?:\.\d+)?`;
const HEM = '[NSEWnsew]';

// El hemisferio de detras se descarta si le siguen cifras: en "N3 W76" esa W
// abre la segunda parte, no cierra la primera.
const HEM_FINAL = String.raw`(?:(${HEM})(?!\s*[\d°]))?`;

/** Un valor decimal suelto, con el hemisferio delante o detras. */
const PARTE = String.raw`(?:(${HEM})\s*)?([+-]?${NUM})\s*°?\s*${HEM_FINAL}`;
// El separador es obligatorio: sin el, "3.4516" se partiria en "3.4" y "516".
const SEPARADOR = String.raw`(?:\s*[,;]\s*|\s+)`;
const DECIMAL = new RegExp(String.raw`^${PARTE}${SEPARADOR}${PARTE}$`);

/* Grados, minutos y segundos. Se barre componente a componente en vez de con
 * un patron unico para las dos, porque en 3°27'05.8"N 76°31'55.2"W la letra
 * del medio podria cerrar la primera o abrir la segunda y las dos lecturas son
 * validas. La regla que las separa es la vista: el hemisferio se pega sin
 * espacio al valor que le corresponde. Por eso aqui no hay \s* junto a las
 * letras, y no porque sobre.
 */
const COMPONENTE_GMS = new RegExp(
  String.raw`(${HEM})?\s*(${NUM})\s*°\s*(?:(${NUM})\s*'\s*)?(?:(${NUM})\s*")?(${HEM})?`,
  'g');

/** Unifica las variantes tipograficas que meten Word, Maps y los moviles. */
function normalizar(texto) {
  return texto
    .replace(/[\u2032\u2019\u00b4`]/g, "'")     // prima, apostrofo curvo, acento
    .replace(/[\u2033\u201c\u201d]/g, '"')      // prima doble, comillas curvas
    .replace(/[\u00ba\u00b0\u02da]/g, '°')      // ordinal masculino, anillo
    .replace(/[\u2212\u2013\u2014]/g, '-')      // menos matematico, guiones largos
    .replace(/[()[\]]/g, ' ')                   // hay quien copia el par entre parentesis
    .replace(/\s+/g, ' ')
    .trim();
}

const negativo = (hemisferio) => /[SWsw]/.test(hemisferio || '');
const esLatitud = (hemisferio) => /[NSns]/.test(hemisferio || '');

/** Aplica el hemisferio a un valor ya positivo o con signo propio. */
const conSigno = (valor, hemisferio) =>
  negativo(hemisferio) ? -Math.abs(valor) : valor;

/**
 * Coloca los dos valores como latitud y longitud.
 * Manda la letra del hemisferio si la hay; si no, se respeta el orden en que
 * se escribio, que es el de Google Maps: primero la latitud.
 */
function ordenar(a, b) {
  if (esLatitud(b.hemisferio) && !esLatitud(a.hemisferio)) {
    return { lat: b.valor, lon: a.valor };
  }
  return { lat: a.valor, lon: b.valor };
}

function leerDecimal(texto) {
  const c = DECIMAL.exec(texto);
  if (!c) return null;
  const [, hemA1, valA, hemA2, hemB1, valB, hemB2] = c;
  const hemA = hemA1 || hemA2;
  const hemB = hemB1 || hemB2;
  return ordenar(
    { valor: conSigno(parseFloat(valA), hemA), hemisferio: hemA },
    { valor: conSigno(parseFloat(valB), hemB), hemisferio: hemB },
  );
}

function leerGms(texto) {
  COMPONENTE_GMS.lastIndex = 0;
  const partes = [];
  let sobrante = texto;
  for (const c of texto.matchAll(COMPONENTE_GMS)) {
    const hemisferio = c[1] || c[5];
    const valor = parseFloat(c[2])
      + (parseFloat(c[3]) || 0) / 60
      + (parseFloat(c[4]) || 0) / 3600;
    partes.push({ valor: conSigno(valor, hemisferio), hemisferio });
    sobrante = sobrante.replace(c[0], ' ');
  }
  // Tienen que ser exactamente dos y no puede quedar nada suelto alrededor:
  // si sobra texto es que no eran coordenadas, sino una frase con numeros.
  if (partes.length !== 2 || /[^\s,;]/.test(sobrante)) return null;
  return ordenar(partes[0], partes[1]);
}

const ES_ENLACE = /^https?:\/\/|google\.[a-z.]+\/maps|goo\.gl|maps\.app/i;

/**
 * Coordenadas dentro de una URL de Google Maps.
 * Se prueban de mas fiable a menos: !3d/!4d es el sitio senalado, q= es lo que
 * se busco, y @ solo dice donde estaba la vista, que puede no ser el sitio.
 */
function leerEnlace(texto) {
  if (/maps\.app\.goo\.gl|goo\.gl\/maps/i.test(texto)) {
    return { error: 'Ese enlace corto no lleva las coordenadas dentro. '
                  + 'Abrelo en el navegador y copia las que salen arriba.' };
  }

  const lat = /!3d(-?\d+(?:\.\d+)?)/.exec(texto);
  const lon = /!4d(-?\d+(?:\.\d+)?)/.exec(texto);
  if (lat && lon) return { lat: parseFloat(lat[1]), lon: parseFloat(lon[1]) };

  const consulta = /[?&](?:q|query|ll|daddr|center)=(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/i
    .exec(texto);
  if (consulta) return { lat: parseFloat(consulta[1]), lon: parseFloat(consulta[2]) };

  const vista = /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/.exec(texto);
  if (vista) return { lat: parseFloat(vista[1]), lon: parseFloat(vista[2]) };

  return { error: 'Ese enlace no trae coordenadas. Pega mejor los dos numeros.' };
}

/**
 * Interpreta lo que haya escrito la persona.
 * @param {string} texto
 * @returns {{vacio?: true, error?: string, lat?: number, lon?: number,
 *            fuera?: boolean, invertible?: boolean}}
 */
export function interpretar(texto) {
  const limpio = normalizar(texto || '');
  if (!limpio) return { vacio: true };

  let leido;
  if (ES_ENLACE.test(limpio)) {
    leido = leerEnlace(limpio);
    if (leido.error) return leido;
  } else {
    // El punto y coma solo aparece cuando la coma hace de separador decimal,
    // que es como lo exporta un Excel en espanol: 3,4516; -76,5320
    const texto2 = limpio.includes(';')
      ? limpio.replace(/,/g, '.').replace(/;/g, ',')
      : limpio;
    // Los apostrofos y las comillas solo salen en grados-minutos-segundos.
    leido = /['"]/.test(texto2) ? leerGms(texto2) : leerDecimal(texto2);
  }

  if (!leido) {
    return { error: 'No reconozco eso como coordenadas. '
                  + 'Prueba con 3.4516, -76.5320 o pega el enlace de Google Maps.' };
  }

  const { lat, lon } = leido;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return { error: 'No reconozco eso como coordenadas.' };
  }
  if (Math.abs(lat) > 90) {
    return { error: `La latitud tiene que estar entre -90 y 90, y llego ${lat}. `
                  + 'Quiza estan al reves: primero la latitud, luego la longitud.' };
  }
  if (Math.abs(lon) > 180) {
    return { error: `La longitud tiene que estar entre -180 y 180, y llego ${lon}.` };
  }

  const fuera = !dentroDeColombia(lat, lon);
  return { lat, lon, fuera, invertible: fuera && dentroDeColombia(lon, lat) };
}
