-- Geovisor de emergencia sismica -- esquema.
--
-- IDEMPOTENTE A PROPOSITO: se aplica en cada despliegue, no solo en el primer
-- arranque del contenedor. Asi el esquema evoluciona sin necesidad de un
-- sistema de migraciones ni de recrear la base, que en plena emergencia seria
-- inaceptable.

CREATE EXTENSION IF NOT EXISTS postgis;

-- ---------------------------------------------------------------------------
-- EPSG:9377 -- MAGNA-SIRGAS / Origen-Nacional
--
-- PROJ 7.2.1 (el que trae postgis:16-3.4) es anterior a la incorporacion de
-- este codigo al registro EPSG, asi que la base arranca SIN el y cualquier
-- ST_Transform(geom, 9377) falla con "Cannot find SRID (9377)". Se registra
-- aqui de forma explicita para no depender de la version de PROJ.
--
-- Parametros conforme a la Resolucion 471 de 2020 del IGAC:
--   Transversa de Mercator, origen 4°N / 73°O, factor de escala 0.9992,
--   falso este 5.000.000 m, falso norte 2.000.000 m, elipsoide GRS80.
-- ---------------------------------------------------------------------------
INSERT INTO spatial_ref_sys (srid, auth_name, auth_srid, srtext, proj4text)
VALUES (
  9377, 'EPSG', 9377,
  'PROJCS["MAGNA-SIRGAS / Origen-Nacional",GEOGCS["MAGNA-SIRGAS",DATUM["Marco_Geocentrico_Nacional_de_Referencia",SPHEROID["GRS 1980",6378137,298.257222101]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",4],PARAMETER["central_meridian",-73],PARAMETER["scale_factor",0.9992],PARAMETER["false_easting",5000000],PARAMETER["false_northing",2000000],UNIT["metre",1],AUTHORITY["EPSG","9377"]]',
  '+proj=tmerc +lat_0=4 +lon_0=-73 +k=0.9992 +x_0=5000000 +y_0=2000000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs'
)
ON CONFLICT (srid) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Capas vectoriales
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS capas (
  id         SERIAL PRIMARY KEY,
  nombre     TEXT NOT NULL,
  tipo       TEXT NOT NULL DEFAULT 'vector',
  color      TEXT NOT NULL DEFAULT '#e63946',
  visible    BOOLEAN NOT NULL DEFAULT true,
  creado_en  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 'orden' controla que capa se dibuja encima de cual. Mayor = mas al frente.
ALTER TABLE capas ADD COLUMN IF NOT EXISTS orden    INTEGER;
ALTER TABLE capas ADD COLUMN IF NOT EXISTS opacidad REAL NOT NULL DEFAULT 1;
UPDATE capas SET orden = id WHERE orden IS NULL;

-- Multiplicador del radio de los puntos. Un punto de 7 px se ve en una capa de
-- treinta reportes y desaparece en una de tres mil; el tamano util depende de
-- la capa y de la escala a la que se este trabajando, asi que lo decide quien
-- mira. Solo afecta a los puntos: lineas y poligonos ya tienen su ancho.
ALTER TABLE capas ADD COLUMN IF NOT EXISTS radio REAL NOT NULL DEFAULT 1;

-- Simbologia tematica: como pintar la capa segun uno de sus atributos.
-- Se guarda en el servidor a proposito: el codigo de colores de "nivel de
-- afectacion" es un acuerdo del equipo, y si cada quien lo viera distinto los
-- informes y las capturas de pantalla dejarian de ser comparables.
--   {"campo": "afectacion",
--    "modo":  "categorias",
--    "colores": {"severo": "#c1121f", "leve": "#e9c46a"}}
--   {"campo": "viviendas", "modo": "rangos",
--    "cortes": [0, 12, 34, 71, 187], "colores": ["#ffedbe", ...]}
-- El FILTRO, en cambio, NO se guarda aqui: es local a cada navegador. Que
-- alguien esconda datos a todo el equipo sin que se entere es justo lo que no
-- puede pasar en una emergencia.
ALTER TABLE capas ADD COLUMN IF NOT EXISTS estilo JSONB;

-- ---------------------------------------------------------------------------
-- Elementos: la geometria se guarda SIEMPRE en 4326 (estandar web).
-- La reproyeccion a 9377 se hace al consultar, no al almacenar: asi el dato
-- crudo es intercambiable y la salida oficial es reproducible.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS elementos (
  id              SERIAL PRIMARY KEY,
  capa_id         INTEGER REFERENCES capas(id) ON DELETE CASCADE,
  nombre          TEXT,
  propiedades     JSONB NOT NULL DEFAULT '{}'::jsonb,
  geom            GEOMETRY(Geometry, 4326) NOT NULL,
  autor           TEXT,
  creado_en       TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_elementos_geom  ON elementos USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_elementos_capa  ON elementos (capa_id);
CREATE INDEX IF NOT EXISTS idx_elementos_props ON elementos USING GIN (propiedades);

CREATE OR REPLACE FUNCTION tocar_actualizado_en() RETURNS TRIGGER AS $$
BEGIN
  NEW.actualizado_en := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_elementos_actualizado ON elementos;
CREATE TRIGGER trg_elementos_actualizado
  BEFORE UPDATE ON elementos
  FOR EACH ROW EXECUTE FUNCTION tocar_actualizado_en();

-- ---------------------------------------------------------------------------
-- Rasters: ortofotos de dron y satelital, convertidas a COG.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rasters (
  id         SERIAL PRIMARY KEY,
  nombre     TEXT NOT NULL,
  archivo    TEXT,
  estado     TEXT NOT NULL DEFAULT 'pendiente',  -- pendiente|procesando|listo|error
  mensaje    TEXT,
  bounds     DOUBLE PRECISION[],                 -- [oeste, sur, este, norte] en 4326
  creado_en  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE rasters ADD COLUMN IF NOT EXISTS orden    INTEGER;
ALTER TABLE rasters ADD COLUMN IF NOT EXISTS visible  BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE rasters ADD COLUMN IF NOT EXISTS opacidad REAL NOT NULL DEFAULT 1;
ALTER TABLE rasters ADD COLUMN IF NOT EXISTS autor    TEXT;

-- Como pintar cada raster. La imagen satelital cruda (PlanetScope, Sentinel)
-- trae 4 bandas de 16 bits de reflectancia, que un PNG no puede mostrar: hay
-- que elegir tres bandas y estirar el contraste. 'bandas' guarda el indice,
-- la interpretacion de color y los percentiles 2/98 de cada una, medidos al
-- ingerir, para no recalcularlos en cada tesela.
ALTER TABLE rasters ADD COLUMN IF NOT EXISTS bandas      JSONB;
ALTER TABLE rasters ADD COLUMN IF NOT EXISTS combinacion TEXT NOT NULL DEFAULT 'natural';

-- Asignacion MANUAL de que banda es cual, cuando el archivo no lo dice.
-- Cada mision entrega el apilado en su propio orden (PlanetScope y Sentinel
-- van Azul-Verde-Rojo-NIR; Skysat y buena parte de la fotografia aerea van
-- Rojo-Verde-Azul-NIR) y muchos GeoTIFF no declaran ni interpretacion de
-- color ni nombre de banda. Adivinar mal invierte rojo y azul, y la escena
-- sale azulada. NULL = deducirlo del archivo.
--   {"rojo": 3, "verde": 2, "azul": 1, "nir": 4, "swir": null}
ALTER TABLE rasters ADD COLUMN IF NOT EXISTS papeles JSONB;

-- Como repartir el contraste entre las tres bandas del color natural:
--   NULL/'auto' deducirlo,  'comun' el mismo rango para las tres (color fiel),
--   'banda'   cada banda a su propio rango (mas contraste, pero tine).
ALTER TABLE rasters ADD COLUMN IF NOT EXISTS balance TEXT;

-- Cola de conversion: el worker toma los 'pendiente', y 'procesando_desde'
-- permite recuperar los que quedaron colgados por un reinicio.
ALTER TABLE rasters ADD COLUMN IF NOT EXISTS origen           TEXT;
ALTER TABLE rasters ADD COLUMN IF NOT EXISTS destino          TEXT;
ALTER TABLE rasters ADD COLUMN IF NOT EXISTS procesando_desde TIMESTAMPTZ;

UPDATE rasters SET orden = id WHERE orden IS NULL;

CREATE INDEX IF NOT EXISTS idx_rasters_cola ON rasters (estado) WHERE estado = 'pendiente';

-- ---------------------------------------------------------------------------
-- Subidas por trozos.
--
-- Una escena Skysat pesa 1,8 GB. Enviarla en un solo POST significa que
-- cualquier microcorte obliga a empezar de cero, y que un worker de la API
-- queda ocupado todo ese rato, dejando la web sin responder. Aqui el archivo
-- llega en trozos de unos megabytes: cada peticion dura segundos y, si se
-- corta, se reanuda por el trozo que faltaba.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS subidas (
  id               TEXT PRIMARY KEY,
  tipo             TEXT NOT NULL DEFAULT 'raster',   -- raster | vector
  nombre           TEXT NOT NULL,                    -- nombre de la capa a crear
  archivo          TEXT NOT NULL,                    -- nombre original del archivo
  tamano           BIGINT NOT NULL,
  tam_trozo        INTEGER NOT NULL,
  total_trozos     INTEGER NOT NULL,
  trozos_recibidos INTEGER[] NOT NULL DEFAULT '{}',
  autor            TEXT,
  creado_en        TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_subidas_actualizado ON subidas (actualizado_en);

-- ---------------------------------------------------------------------------
-- Vista oficial Colombia -- MAGNA-SIRGAS / Origen-Nacional (EPSG:9377),
-- proyeccion oficial segun Resolucion 471 de 2020 del IGAC.
--
-- Las medidas se calculan aqui, en PostGIS y sobre la proyeccion metrica
-- oficial. Nunca desde el navegador: alli solo se estima para el rotulo en
-- vivo mientras se dibuja.
-- ST_Length devuelve 0 en poligonos y ST_Area devuelve 0 en lineas; se dejan
-- ambas columnas para que el export sea homogeneo.
-- ---------------------------------------------------------------------------
DROP VIEW IF EXISTS v_elementos_oficial_co;
CREATE VIEW v_elementos_oficial_co AS
SELECT
  e.id,
  e.capa_id,
  c.nombre AS capa,
  e.nombre,
  e.propiedades,
  e.autor,
  e.creado_en,
  ST_Transform(e.geom, 9377) AS geom_9377,
  GeometryType(e.geom)       AS tipo_geometria,
  ROUND(ST_Length(ST_Transform(e.geom, 9377))::numeric, 2)    AS longitud_m,
  ROUND(ST_Area(ST_Transform(e.geom, 9377))::numeric, 2)      AS area_m2,
  ROUND(ST_Perimeter(ST_Transform(e.geom, 9377))::numeric, 2) AS perimetro_m
FROM elementos e
LEFT JOIN capas c ON c.id = e.capa_id;

-- ---------------------------------------------------------------------------
-- Pila de capas: quien va encima de quien, y que hay dentro de que grupo.
--
-- Antes el orden vivia en capas.orden, rasters.orden y el localStorage de cada
-- navegador, con escalas independientes. Eso hacia imposible intercalar una
-- fuente externa entre dos capas propias, y hacia que dos navegadores con
-- distinto juego de externas se pisaran la numeracion en cada recarga.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS grupos (
  id     SERIAL PRIMARY KEY,
  nombre TEXT NOT NULL,
  color  TEXT NOT NULL DEFAULT '#8d99ae'
);

-- Estado de una fuente externa publicada en el mapa del equipo. Es el
-- equivalente de lo que capas y rasters ya guardan en su propia tabla; el
-- nombre, el color y la URL los pone el catalogo de fuentes.py, no la base.
CREATE TABLE IF NOT EXISTS externas (
  clave    TEXT PRIMARY KEY,
  visible  BOOLEAN NOT NULL DEFAULT true,
  opacidad REAL    NOT NULL DEFAULT 1
);
ALTER TABLE externas ADD COLUMN IF NOT EXISTS radio REAL NOT NULL DEFAULT 1;

-- Una fila por cosa que ocupa sitio en el panel, grupos incluidos:
--   capa-13  raster-6  ext-ungrd-ede  grupo-2
-- Estar aqui es lo que significa estar en el mapa.
CREATE TABLE IF NOT EXISTS pila (
  clave    TEXT PRIMARY KEY,
  grupo_id INTEGER REFERENCES grupos(id) ON DELETE SET NULL,
  orden    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pila_grupo ON pila (grupo_id, orden);

-- ---------------------------------------------------------------------------
-- Capas iniciales para respuesta sismica. Solo en una base recien creada:
-- si el equipo ya borro alguna, no debe reaparecer en el siguiente despliegue.
-- ---------------------------------------------------------------------------
INSERT INTO capas (nombre, color, orden)
SELECT * FROM (VALUES
  ('Danos en edificaciones', '#e63946', 1),
  ('Albergues',              '#2a9d8f', 2),
  ('Vias bloqueadas',        '#f4a261', 3),
  ('Puntos de atencion',     '#457b9d', 4),
  ('Zonas de riesgo',        '#9d4edd', 5),
  ('General',                '#6c757d', 6)
) AS semilla(nombre, color, orden)
WHERE NOT EXISTS (SELECT 1 FROM capas);
