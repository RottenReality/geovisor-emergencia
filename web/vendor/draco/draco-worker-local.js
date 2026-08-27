/* Envoltura del worker de Draco que lo deja buscar el descompresor aqui.
 *
 * loaders.gl trae la URL del descompresor de Draco QUEMADA en el codigo
 * -www.gstatic.com, la CDN de Google- y, dentro de un worker, no hay opcion
 * que la cambie: el propio worker sobrescribe `options.modules` con las del
 * cargador (vacias) antes de resolverla, asi que `modules`, `libraryPath` y
 * `useLocalLibraries` no llegan nunca. Comprobado en la version 4.3.3, que es
 * la del archivo de al lado.
 *
 * Sin esto, mirar el modelo 3D depende de que el navegador alcance una CDN
 * ajena: 344 KB antes de la primera malla, y nada en pantalla si la red del
 * puesto de mando la bloquea o no llega. En una emergencia eso no vale, y
 * ademas el visor no carga nada de fuera por politica.
 *
 * Se resuelve donde si se puede: interceptando las dos unicas peticiones que
 * el worker hace a esa CDN y sirviendolas de /vendor/draco, que es donde ya
 * estan los mismos archivos y la misma version.
 */
const CDN = 'https://www.gstatic.com/draco/versioned/decoders/1.5.6/';
const AQUI = '/vendor/draco/';

const local = (recurso) => (typeof recurso === 'string' && recurso.startsWith(CDN)
  ? AQUI + recurso.slice(CDN.length)
  : recurso);

const importarOriginal = self.importScripts.bind(self);
self.importScripts = (...rutas) => importarOriginal(...rutas.map(local));

const traerOriginal = self.fetch.bind(self);
self.fetch = (recurso, opciones) => traerOriginal(local(recurso), opciones);

importScripts(`${AQUI}draco-worker.js`);
