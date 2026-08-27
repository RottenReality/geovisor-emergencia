/* Los dos mandos del modelo 3D que fallan sin decir nada.
 *
 * Ninguno de los dos da error cuando se pone donde no es: el visor arranca,
 * el modelo aparece y lo unico que pasa es que se ve mal. Costo tres tandas
 * de cambios averiguarlo, asi que queda escrito aqui.
 *
 * No se puede probar ejecutando -esto vive en el navegador, con deck.gl y una
 * GPU-, asi que se lee el codigo, como en backend/tests/test_parches.py.
 *
 * Se ejecutan con:  node --test pruebas/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const leer = (ruta) => readFileSync(new URL(`../${ruta}`, import.meta.url), 'utf8');

const modelo3d = leer('web/js/modelo3d.js');
const deck = leer('web/vendor/deck.min.js');

// --- El presupuesto de cache -----------------------------------------------
test('el presupuesto de cache se pone en el objeto, no en sus opciones', () => {
  // La libreria declara `maximumMemoryUsage = 32` como campo del conjunto y
  // NUNCA lo copia desde `options`. Ponerlo en `options` -como estuvo- deja
  // la cache en 32 MB, la libreria suelta cada fotograma todo lo que no se
  // este viendo, y al girar salen manchas lisas donde aun no ha vuelto a
  // llegar la tesela buena.
  assert.match(modelo3d, /conjunto\.maximumMemoryUsage\s*=/,
               'hay que asignar el campo del conjunto');
  assert.doesNotMatch(modelo3d, /conjunto\.options\.maximumMemoryUsage/,
                      'en options no hace nada: la libreria no lo lee de ahi');
});

test('la libreria sigue leyendo el presupuesto del campo y no de las opciones', () => {
  // Si un dia deck.gl arregla esto, la prueba de arriba deja de ser cierta y
  // conviene volver a mirar. La cuenta de la cache es esta, literal.
  assert.ok(deck.includes('maximumMemoryUsage*1024*1024'),
            'deck.gl ya no calcula asi el techo de la cache: revisar modelo3d.js');
});

// --- El descompresor de las mallas -----------------------------------------
test('el worker de Draco es la envoltura que sirve el descompresor de aqui', () => {
  // Las mallas de DJI Terra declaran Draco como extension REQUERIDA: sin
  // descompresor no se dibuja ni una tesela. La URL de gstatic esta quemada
  // dentro del worker de la libreria y ninguna opcion la cambia.
  assert.match(modelo3d, /workerUrl: `\$\{VENDOR\}\/draco\/draco-worker-local\.js`/);
  assert.doesNotMatch(modelo3d, /libraryPath\s*:/,
                      'libraryPath no existe en esta version de la libreria');
});

test('estan los archivos que la envoltura sirve', () => {
  for (const archivo of ['web/vendor/draco/draco-worker-local.js',
                         'web/vendor/draco/draco-worker.js',
                         'web/vendor/draco/draco_wasm_wrapper.js',
                         'web/vendor/draco/draco_decoder.wasm']) {
    assert.ok(existsSync(new URL(`../${archivo}`, import.meta.url)), archivo);
  }
});

test('la envoltura redirige la version de Draco que el worker pide', () => {
  // Si al re-vendorizar el worker cambia la version del descompresor, la
  // envoltura deja de reconocer la URL, el navegador vuelve a Google y el
  // modelo depende otra vez de una CDN ajena. Sin fallar, ademas: por eso se
  // comprueba aqui y no se descubre en campo.
  const worker = leer('web/vendor/draco/draco-worker.js');
  const envoltura = leer('web/vendor/draco/draco-worker-local.js');
  const pedida = /DRACO_DECODER_VERSION\s*=\s*"([\d.]+)"/.exec(worker);
  assert.ok(pedida, 'no se encontro la version del descompresor en el worker');
  assert.ok(envoltura.includes(`decoders/${pedida[1]}/`),
            `el worker pide Draco ${pedida[1]} y la envoltura redirige otra version`);
});
