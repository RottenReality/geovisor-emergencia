"""Configuracion leida del entorno. Sin dependencias extra a proposito."""
import os

DATABASE_URL = os.environ["DATABASE_URL"]

CLAVE_ACCESO = os.environ.get("CLAVE_ACCESO", "")
SECRET_KEY = os.environ.get("SECRET_KEY", "")

# Duracion de la sesion. En emergencia conviene larga: nadie quiere volver a
# escribir la clave en un celular bajo lluvia a las 3 de la manana.
SESION_HORAS = int(os.environ.get("SESION_HORAS", "72"))
SESION_SEGUNDOS = SESION_HORAS * 3600

COOKIE_NOMBRE = "geo_sesion"

# Directorio de datos subidos (montado como volumen).
DIR_DATOS = os.environ.get("DIR_DATOS", "/datos")
DIR_RASTERS = os.path.join(DIR_DATOS, "rasters")

# TiTiler vive solo en la red interna de Docker: el navegador nunca lo alcanza.
# Su imagen sirve en el puerto 80, no en el 8000.
TITILER_URL = os.environ.get("TITILER_URL", "http://titiler")

# EPSG oficial de Colombia: MAGNA-SIRGAS / Origen-Nacional
# (Resolucion 471 de 2020, IGAC).
SRID_OFICIAL_CO = 9377

if not CLAVE_ACCESO:
    raise RuntimeError("Falta CLAVE_ACCESO en el entorno (.env)")
if not SECRET_KEY:
    raise RuntimeError("Falta SECRET_KEY en el entorno (.env)")
