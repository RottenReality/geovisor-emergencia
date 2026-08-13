-- Geovisor de emergencia sismica -- esquema inicial
-- Se ejecuta una sola vez, en el primer arranque del contenedor de base.

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
-- Capas: agrupan elementos y definen su simbologia en el visor.
-- ---------------------------------------------------------------------------
CREATE TABLE capas (
  id         SERIAL PRIMARY KEY,
  nombre     TEXT NOT NULL,
  tipo       TEXT NOT NULL DEFAULT 'vector',   -- vector | raster
  color      TEXT NOT NULL DEFAULT '#e63946',
  visible    BOOLEAN NOT NULL DEFAULT true,
  creado_en  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Elementos: la geometria se guarda SIEMPRE en 4326 (estandar web).
-- La reproyeccion a 9377 se hace al consultar, no al almacenar: asi el dato
-- crudo es intercambiable y la salida oficial es reproducible.
-- ---------------------------------------------------------------------------
CREATE TABLE elementos (
  id              SERIAL PRIMARY KEY,
  capa_id         INTEGER REFERENCES capas(id) ON DELETE CASCADE,
  nombre          TEXT,
  propiedades     JSONB NOT NULL DEFAULT '{}'::jsonb,
  geom            GEOMETRY(Geometry, 4326) NOT NULL,
  autor           TEXT,
  creado_en       TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_elementos_geom  ON elementos USING GIST (geom);
CREATE INDEX idx_elementos_capa  ON elementos (capa_id);
CREATE INDEX idx_elementos_props ON elementos USING GIN (propiedades);

CREATE OR REPLACE FUNCTION tocar_actualizado_en() RETURNS TRIGGER AS $$
BEGIN
  NEW.actualizado_en := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_elementos_actualizado
  BEFORE UPDATE ON elementos
  FOR EACH ROW EXECUTE FUNCTION tocar_actualizado_en();

-- ---------------------------------------------------------------------------
-- Rasters (Fase 2): registro de ortofotos / satelital convertidas a COG.
-- ---------------------------------------------------------------------------
CREATE TABLE rasters (
  id         SERIAL PRIMARY KEY,
  nombre     TEXT NOT NULL,
  archivo    TEXT,                              -- ruta dentro de /datos/rasters
  estado     TEXT NOT NULL DEFAULT 'pendiente', -- pendiente|procesando|listo|error
  mensaje    TEXT,
  bounds     DOUBLE PRECISION[],                -- [oeste, sur, este, norte] en 4326
  creado_en  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Vista oficial Colombia -- MAGNA-SIRGAS / Origen-Nacional (EPSG:9377),
-- proyeccion oficial segun Resolucion 471 de 2020 del IGAC.
--
-- Las medidas se calculan aqui, en PostGIS y sobre la proyeccion metrica
-- oficial. Nunca desde el navegador: Turf solo da feedback visual al dibujar.
-- ST_Length devuelve 0 en poligonos y ST_Area devuelve 0 en lineas; se dejan
-- ambas columnas para que el export sea homogeneo.
-- ---------------------------------------------------------------------------
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
  ROUND(ST_Length(ST_Transform(e.geom, 9377))::numeric, 2) AS longitud_m,
  ROUND(ST_Area(ST_Transform(e.geom, 9377))::numeric, 2)   AS area_m2,
  ROUND(ST_Perimeter(ST_Transform(e.geom, 9377))::numeric, 2) AS perimetro_m
FROM elementos e
LEFT JOIN capas c ON c.id = e.capa_id;

-- ---------------------------------------------------------------------------
-- Capas iniciales para respuesta sismica.
-- ---------------------------------------------------------------------------
INSERT INTO capas (nombre, color) VALUES
  ('Danos en edificaciones', '#e63946'),
  ('Albergues',              '#2a9d8f'),
  ('Vias bloqueadas',        '#f4a261'),
  ('Puntos de atencion',     '#457b9d'),
  ('Zonas de riesgo',        '#9d4edd'),
  ('General',                '#6c757d');
