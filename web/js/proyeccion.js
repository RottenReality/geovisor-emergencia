/* Proyeccion a EPSG:9377 -- MAGNA-SIRGAS / Origen-Nacional.
 *
 * Se calcula en el navegador solo para mostrar la posicion del cursor en
 * tiempo real; pedirsela al servidor en cada movimiento del raton seria
 * absurdo. Las cifras que van a un informe oficial las produce PostGIS.
 *
 * Transversa de Mercator (Snyder / EPSG 9807) con los parametros de la
 * Resolucion 471 de 2020 del IGAC. Exacta al milimetro dentro de Colombia.
 */

const A = 6378137.0;                 // semieje mayor GRS80
const F = 1 / 298.257222101;         // achatamiento GRS80
const K0 = 0.9992;                   // factor de escala
const LAT0 = 4 * Math.PI / 180;      // latitud de origen  4°N
const LON0 = -73 * Math.PI / 180;    // meridiano central 73°O
const FE = 5000000;                  // falso este
const FN = 2000000;                  // falso norte

const E2 = 2 * F - F * F;            // primera excentricidad al cuadrado
const EP2 = E2 / (1 - E2);           // segunda excentricidad al cuadrado

/** Arco meridiano desde el ecuador hasta la latitud dada. */
function arcoMeridiano(lat) {
  return A * (
    (1 - E2 / 4 - 3 * E2 ** 2 / 64 - 5 * E2 ** 3 / 256) * lat
    - (3 * E2 / 8 + 3 * E2 ** 2 / 32 + 45 * E2 ** 3 / 1024) * Math.sin(2 * lat)
    + (15 * E2 ** 2 / 256 + 45 * E2 ** 3 / 1024) * Math.sin(4 * lat)
    - (35 * E2 ** 3 / 3072) * Math.sin(6 * lat)
  );
}

const M0 = arcoMeridiano(LAT0);

/**
 * Convierte longitud/latitud en grados (EPSG:4326) a Este/Norte en metros
 * (EPSG:9377).
 * @returns {{este: number, norte: number}}
 */
export function a9377(lon, lat) {
  const phi = lat * Math.PI / 180;
  const lam = lon * Math.PI / 180;

  const senPhi = Math.sin(phi);
  const cosPhi = Math.cos(phi);
  const tanPhi = Math.tan(phi);

  const N = A / Math.sqrt(1 - E2 * senPhi * senPhi);
  const T = tanPhi * tanPhi;
  const C = EP2 * cosPhi * cosPhi;
  const Aa = (lam - LON0) * cosPhi;
  const M = arcoMeridiano(phi);

  const este = FE + K0 * N * (
    Aa
    + (1 - T + C) * Aa ** 3 / 6
    + (5 - 18 * T + T * T + 72 * C - 58 * EP2) * Aa ** 5 / 120
  );

  const norte = FN + K0 * (
    M - M0 + N * tanPhi * (
      Aa * Aa / 2
      + (5 - T + 9 * C + 4 * C * C) * Aa ** 4 / 24
      + (61 - 58 * T + T * T + 600 * C - 330 * EP2) * Aa ** 6 / 720
    )
  );

  return { este, norte };
}
