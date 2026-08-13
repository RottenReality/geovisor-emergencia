/* Ciudades para encuadrar el mapa rapido.
 *
 * PRIORITARIAS son las afectadas por el sismo: salen fijadas arriba del
 * selector porque el equipo esta repartido entre ellas y no puede perder
 * tiempo buscando en una lista larga. Para cambiarlas basta editar este
 * arreglo: el visor se sirve como archivo estatico, asi que el cambio queda
 * activo al guardar, sin reconstruir nada.
 */

export const PRIORITARIAS = [
  { nombre: 'Cali',      lon: -76.5320, lat: 3.4516, zoom: 12 },
  { nombre: 'Pereira',   lon: -75.6961, lat: 4.8133, zoom: 12 },
  { nombre: 'Armenia',   lon: -75.6811, lat: 4.5339, zoom: 12 },
  { nombre: 'Quibdó',    lon: -76.6611, lat: 5.6947, zoom: 12 },
  { nombre: 'Manizales', lon: -75.5174, lat: 5.0689, zoom: 12 },
];

export const RESTO = [
  { nombre: 'Arauca',                lon: -70.7617, lat:  7.0902, zoom: 12 },
  { nombre: 'Barranquilla',          lon: -74.7964, lat: 10.9639, zoom: 12 },
  { nombre: 'Bogotá',                lon: -74.0721, lat:  4.7110, zoom: 11 },
  { nombre: 'Bucaramanga',           lon: -73.1227, lat:  7.1193, zoom: 12 },
  { nombre: 'Buenaventura',          lon: -77.0312, lat:  3.8801, zoom: 12 },
  { nombre: 'Buga',                  lon: -76.2978, lat:  3.9006, zoom: 13 },
  { nombre: 'Calarcá',               lon: -75.6444, lat:  4.5253, zoom: 13 },
  { nombre: 'Cartagena',             lon: -75.4794, lat: 10.3910, zoom: 12 },
  { nombre: 'Cartago',               lon: -75.9117, lat:  4.7467, zoom: 13 },
  { nombre: 'Cúcuta',                lon: -72.5078, lat:  7.8939, zoom: 12 },
  { nombre: 'Dosquebradas',          lon: -75.6764, lat:  4.8339, zoom: 13 },
  { nombre: 'Florencia',             lon: -75.6062, lat:  1.6144, zoom: 12 },
  { nombre: 'Ibagué',                lon: -75.2322, lat:  4.4389, zoom: 12 },
  { nombre: 'Inírida',               lon: -67.9239, lat:  3.8653, zoom: 12 },
  { nombre: 'Leticia',               lon: -69.9406, lat: -4.2153, zoom: 12 },
  { nombre: 'Medellín',              lon: -75.5812, lat:  6.2442, zoom: 12 },
  { nombre: 'Mitú',                  lon: -70.1733, lat:  1.1983, zoom: 12 },
  { nombre: 'Mocoa',                 lon: -76.6478, lat:  1.1519, zoom: 12 },
  { nombre: 'Montería',              lon: -75.8814, lat:  8.7479, zoom: 12 },
  { nombre: 'Neiva',                 lon: -75.2819, lat:  2.9273, zoom: 12 },
  { nombre: 'Palmira',               lon: -76.3036, lat:  3.5394, zoom: 13 },
  { nombre: 'Pasto',                 lon: -77.2811, lat:  1.2136, zoom: 12 },
  { nombre: 'Popayán',               lon: -76.6147, lat:  2.4448, zoom: 12 },
  { nombre: 'Puerto Carreño',        lon: -67.4859, lat:  6.1889, zoom: 12 },
  { nombre: 'Riohacha',              lon: -72.9072, lat: 11.5444, zoom: 12 },
  { nombre: 'San Andrés',            lon: -81.7006, lat: 12.5847, zoom: 13 },
  { nombre: 'San José del Guaviare', lon: -72.6459, lat:  2.5729, zoom: 12 },
  { nombre: 'Santa Marta',           lon: -74.1990, lat: 11.2408, zoom: 12 },
  { nombre: 'Santa Rosa de Cabal',   lon: -75.6217, lat:  4.8747, zoom: 13 },
  { nombre: 'Sincelejo',             lon: -75.3978, lat:  9.3047, zoom: 12 },
  { nombre: 'Tuluá',                 lon: -76.1954, lat:  4.0847, zoom: 13 },
  { nombre: 'Tumaco',                lon: -78.8156, lat:  1.7986, zoom: 12 },
  { nombre: 'Tunja',                 lon: -73.3678, lat:  5.5353, zoom: 12 },
  { nombre: 'Valledupar',            lon: -73.2532, lat: 10.4631, zoom: 12 },
  { nombre: 'Villavicencio',         lon: -73.6266, lat:  4.1420, zoom: 12 },
  { nombre: 'Yopal',                 lon: -72.3959, lat:  5.3378, zoom: 12 },
];

export const COLOMBIA = { nombre: 'Todo el país', lon: -74.3, lat: 4.6, zoom: 5 };
