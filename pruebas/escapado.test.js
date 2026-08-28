/* Pruebas del escapado de texto que va a parar al HTML del panel.
 *
 * Importa aqui porque los nombres de las capas los escribe el equipo y se
 * meten DENTRO de atributos: value="...", title="...". Una comilla sin
 * escapar corta el atributo, y lo que viene detras deja de ser texto para
 * pasar a ser HTML.
 *
 * Se ejecutan con:  node --test "pruebas/*.test.js"
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { escapar } from '../web/js/util.js';

test('las comillas dobles no cierran el atributo', () => {
  // El fallo original: `value="Grieta "grande""` dejaba el campo en «Grieta ».
  assert.equal(escapar('Grieta "grande"'), 'Grieta &quot;grande&quot;');
});

test('las comillas simples tampoco', () => {
  assert.equal(escapar("Ala 'norte'"), 'Ala &#39;norte&#39;');
});

test('un nombre no puede colar un atributo', () => {
  // Lo que de verdad importa: que no se pueda salir del value.
  const malicioso = '" onmouseover="alert(1)';
  const salida = escapar(malicioso);
  assert.ok(!salida.includes('"'), 'no debe quedar ninguna comilla sin escapar');
  assert.equal(salida, '&quot; onmouseover=&quot;alert(1)');
});

test('sigue escapando lo de siempre', () => {
  assert.equal(escapar('<b>'), '&lt;b&gt;');
  assert.equal(escapar('A & B'), 'A &amp; B');
});

test('el ampersand se escapa una sola vez', () => {
  // Con reemplazos encadenados, `<` se convertiria en `&lt;` y luego su `&`
  // en `&amp;lt;`. Por eso va todo en un solo recorrido.
  assert.equal(escapar('<'), '&lt;');
  assert.equal(escapar('&lt;'), '&amp;lt;');
});

test('el texto normal no se toca', () => {
  const normal = 'Cristo Rey · el monumento en detalle';
  assert.equal(escapar(normal), normal);
});

test('la ausencia de texto no se convierte en la palabra undefined', () => {
  // textContent = undefined daba literalmente «undefined» en pantalla.
  assert.equal(escapar(undefined), '');
  assert.equal(escapar(null), '');
  assert.equal(escapar(''), '');
});

test('los numeros pasan como texto', () => {
  assert.equal(escapar(0), '0');
  assert.equal(escapar(1054), '1054');
});
