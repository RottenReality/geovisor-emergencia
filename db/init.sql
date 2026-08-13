-- Geovisor de emergencia sismica -- esquema inicial
-- Se ejecuta una sola vez, en el primer arranque del contenedor de base.

CREATE EXTENSION IF NOT EXISTS postgis;

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
