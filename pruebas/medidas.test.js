/* Pruebas de las medidas que se leen sobre un modelo 3D.
 *
 * Todo esto sale por pantalla mientras alguien marca una grieta y decide si
 * la estructura se usa o no. Una cifra mal formateada o una longitud que
 * ignora el desnivel no da error: da un numero creible y equivocado.
 *
 * Se ejecutan con:  node --test "pruebas/*.test.js"
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { distancia3d, longitud3dDe, formatearLongitud, distancia } from '../web/js/util.js';

const cerca = (real, esperado, margen) =>
  assert.ok(Math.abs(real - esperado) < margen,
            `${real} deberia estar a menos de ${margen} de ${esperado}`);

// Dos puntos del cerro del Cristo Rey, a unos metros uno de otro.
const A = [-76.564498, 3.435738, 1483.0];

test('sin desnivel, la distancia 3D es la del suelo', () => {
  const b = [-76.564398, 3.435738, 1483.0];
  cerca(distancia3d(A, b), distancia(A, b), 1e-9);
});

test('una grieta vertical mide su altura, no cero', () => {
  // El caso que motiva todo: mismo punto en planta, tres metros de caida.
  const b = [-76.564498, 3.435738, 1486.0];
  cerca(distancia3d(A, b), 3.0, 1e-6);
  cerca(distancia(A, b), 0, 1e-6);
});

test('la diagonal se compone de plano y desnivel', () => {
  // Un punto a ~11,1 m al este y 4 m mas arriba: 3-4-5 escalado.
  const b = [-76.564498 + 0.0001, 3.435738, 1483.0];
  const plano = distancia(A, b);
  const subido = [b[0], b[1], 1483.0 + 4];
  cerca(distancia3d(A, subido), Math.hypot(plano, 4), 1e-9);
});

test('la altura que falta se trata como cero y no como NaN', () => {
  // Los vertices de una capa plana no traen Z. Sin esto, mezclarlos con los
  // de un modelo daria NaN y el panel mostraria «NaN m».
  const sinZ = [-76.564398, 3.435738];
  assert.ok(Number.isFinite(distancia3d(A, sinZ)));
  assert.ok(Number.isFinite(distancia3d(sinZ, A)));
});

test('la longitud de una polilinea suma sus tramos', () => {
  const puntos = [
    [-76.564498, 3.435738, 1483.0],
    [-76.564498, 3.435738, 1485.0],
    [-76.564498, 3.435738, 1488.0],
  ];
  cerca(longitud3dDe(puntos), 5.0, 1e-6);
});

test('una polilinea de un solo punto mide cero', () => {
  assert.equal(longitud3dDe([A]), 0);
  assert.equal(longitud3dDe([]), 0);
});

test('el ancho de una grieta se lee en centimetros', () => {
  // Antes esto salia como «0 m», que es justo lo que hay que poder leer.
  assert.equal(formatearLongitud(0.15), '15 cm');
  assert.equal(formatearLongitud(0.03), '3 cm');
  assert.equal(formatearLongitud(0.9), '90 cm');
});

test('los tramos de pocos metros llevan decimales', () => {
  assert.equal(formatearLongitud(3.456), '3,46 m');
  assert.equal(formatearLongitud(1), '1,00 m');
});

test('a partir de diez metros el centimetro es precision falsa', () => {
  assert.equal(formatearLongitud(143.64), '144 m');
  assert.equal(formatearLongitud(12.3), '12 m');
});

test('los kilometros siguen saliendo como antes', () => {
  assert.equal(formatearLongitud(1500), '1,50 km');
});

test('una medida que no existe no se inventa', () => {
  // Un elemento sin geometria 3D llega con null desde el servidor.
  assert.equal(formatearLongitud(null), '—');
  assert.equal(formatearLongitud(undefined), '—');
  assert.equal(formatearLongitud(NaN), '—');
});
