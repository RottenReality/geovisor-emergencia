/* Pruebas de la lectura de coordenadas pegadas a mano.
 *
 * Aqui esta el riesgo real de la barra: el texto lo escribe o lo pega una
 * persona con prisa, desde Google Maps, desde WhatsApp o dictado por radio.
 * El modulo es puro y no importa nada, asi que se prueba sin navegador.
 *
 * Se ejecutan con:  node --test pruebas/
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { interpretar, dentroDeColombia } from '../web/js/coordenadas.js';

/** Compara con tolerancia: al leer grados-minutos-segundos hay redondeo. */
const cerca = (real, esperado, margen = 1e-6) =>
  assert.ok(Math.abs(real - esperado) < margen,
            `${real} deberia estar a menos de ${margen} de ${esperado}`);

const bien = (texto) => {
  const r = interpretar(texto);
  assert.equal(r.error, undefined, `"${texto}" deberia leerse: ${r.error}`);
  return r;
};

// --- Decimal, que es lo que copia Google Maps ------------------------------
test('lat, lon separadas por coma', () => {
  const { lat, lon } = bien('3.4516, -76.5320');
  cerca(lat, 3.4516); cerca(lon, -76.5320);
});

test('sin espacio tras la coma', () => {
  const { lat, lon } = bien('3.4516,-76.5320');
  cerca(lat, 3.4516); cerca(lon, -76.5320);
});

test('separadas solo por espacios', () => {
  const { lat, lon } = bien('3.4516   -76.5320');
  cerca(lat, 3.4516); cerca(lon, -76.5320);
});

test('entre parentesis y con espacios sobrantes', () => {
  const { lat, lon } = bien('  (3.4516, -76.5320)  ');
  cerca(lat, 3.4516); cerca(lon, -76.5320);
});

test('con signo mas explicito', () => {
  const { lat, lon } = bien('+3.4516, -76.5320');
  cerca(lat, 3.4516); cerca(lon, -76.5320);
});

test('coma decimal a la europea, separadas por punto y coma', () => {
  // Excel y algunos equipos en espanol exportan asi.
  const { lat, lon } = bien('3,4516; -76,5320');
  cerca(lat, 3.4516); cerca(lon, -76.5320);
});

test('sufijo N/W en vez de signo', () => {
  const { lat, lon } = bien('3.4516 N, 76.5320 W');
  cerca(lat, 3.4516); cerca(lon, -76.5320);
});

test('sufijo S/E da signos contrarios', () => {
  const { lat, lon } = bien('4.2153 S, 69.9406 W');
  cerca(lat, -4.2153); cerca(lon, -69.9406);
});

// --- Grados, minutos y segundos -------------------------------------------
test('grados-minutos-segundos como los muestra Google Maps', () => {
  const { lat, lon } = bien(`3°27'05.8"N 76°31'55.2"W`);
  cerca(lat, 3.4516111, 1e-5); cerca(lon, -76.5320, 1e-5);
});

test('grados y minutos decimales, sin segundos', () => {
  const { lat, lon } = bien(`3°27.096'N 76°31.92'W`);
  cerca(lat, 3.4516, 1e-4); cerca(lon, -76.532, 1e-4);
});

test('comillas rectas o tipograficas dan igual', () => {
  const a = bien(`3°27'05.8"N 76°31'55.2"W`);
  const b = bien('3°27\u203205.8\u2033N 76°31\u203255.2\u2033W');
  cerca(a.lat, b.lat, 1e-9); cerca(a.lon, b.lon, 1e-9);
});

test('el hemisferio puede ir delante', () => {
  const { lat, lon } = bien(`N3°27'05.8" W76°31'55.2"`);
  cerca(lat, 3.4516111, 1e-5); cerca(lon, -76.5320, 1e-5);
});

// --- Enlaces de Google Maps pegados enteros --------------------------------
test('URL con @lat,lon,zoom', () => {
  const { lat, lon } = bien('https://www.google.com/maps/@3.4516,-76.5320,17z');
  cerca(lat, 3.4516); cerca(lon, -76.5320);
});

test('URL con ?q=lat,lon', () => {
  const { lat, lon } = bien('https://maps.google.com/?q=3.4516,-76.5320');
  cerca(lat, 3.4516); cerca(lon, -76.5320);
});

test('URL larga de compartir, con !3d y !4d', () => {
  // En estas el @ apunta al centro de la vista y !3d/!4d al sitio marcado:
  // manda el sitio marcado, que es lo que la persona quiso senalar.
  const { lat, lon } = bien(
    'https://www.google.com/maps/place/Cali/@3.39,-76.60,12z/data=!3m1!4b1!4d-76.5320!3d3.4516');
  cerca(lat, 3.4516); cerca(lon, -76.5320);
});

test('URL corta sin coordenadas se rechaza con motivo', () => {
  const r = interpretar('https://maps.app.goo.gl/AbCdEf123');
  assert.match(r.error, /enlace corto/i);
});

// --- Basura y limites ------------------------------------------------------
test('texto vacio no es un error, simplemente no hay nada', () => {
  assert.equal(interpretar('').error, undefined);
  assert.equal(interpretar('   ').vacio, true);
});

test('un solo numero no alcanza', () => {
  assert.ok(interpretar('3.4516').error);
});

test('texto sin numeros se rechaza', () => {
  assert.ok(interpretar('la esquina de la 5 con 15').error);
});

test('latitud imposible se rechaza nombrando el limite', () => {
  assert.match(interpretar('95.0, -76.5').error, /latitud/i);
});

test('longitud imposible se rechaza nombrando el limite', () => {
  assert.match(interpretar('3.45, -200.0').error, /longitud/i);
});

test('el cero absoluto es valido aunque este en el Atlantico', () => {
  const { lat, lon } = bien('0, 0');
  assert.equal(lat, 0); assert.equal(lon, 0);
});

// --- Colombia y el error de invertir lat/lon -------------------------------
test('Cali cae dentro de Colombia', () => {
  assert.equal(dentroDeColombia(3.4516, -76.5320), true);
});

test('Madrid no cae dentro de Colombia', () => {
  assert.equal(dentroDeColombia(40.4168, -3.7038), false);
});

test('lat/lon invertidas se detectan y se ofrece el intercambio', () => {
  // -76.5320, 3.4516 cae en el oceano Antartico; al invertirlas, en Cali.
  const r = bien('-76.5320, 3.4516');
  assert.equal(r.fuera, true);
  assert.equal(r.invertible, true);
});

test('un punto legitimo fuera de Colombia avisa pero no propone invertir', () => {
  const r = bien('40.4168, -3.7038');   // Madrid; invertida tampoco es Colombia
  assert.equal(r.fuera, true);
  assert.equal(r.invertible, false);
});

test('un punto dentro de Colombia no marca nada', () => {
  const r = bien('3.4516, -76.5320');
  assert.equal(r.fuera, false);
  assert.equal(r.invertible, false);
});
