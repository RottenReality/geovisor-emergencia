# python:3.12-slim ya esta en cache en la VPS -> arranque sin descarga.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    # Techo de la cache de GDAL. Sin esto, convertir una ortofoto grande
    # agota la RAM del contenedor y el kernel lo mata.
    GDAL_CACHEMAX=256

# gdal-bin aporta gdalinfo y gdal_translate, que son los que convierten a COG.
RUN apt-get update \
 && apt-get install -y --no-install-recommends gdal-bin \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

EXPOSE 8080

# 2 workers: suficiente para el equipo y deja RAM para las conversiones GDAL.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "2"]
