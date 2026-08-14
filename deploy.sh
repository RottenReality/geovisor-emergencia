#!/usr/bin/env bash
# Despliega o actualiza el geovisor. Seguro de repetir.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

if [[ ! -f .env ]]; then
  echo "Falta .env. Copiar de .env.example y rellenar:" >&2
  echo "  cp .env.example .env && nano .env" >&2
  exit 1
fi

# Respaldo previo: si la base ya existe, nunca actualizar sin red de seguridad.
if docker ps --format '{{.Names}}' | grep -qx geo_db; then
  log "Respaldando base antes de actualizar"
  mkdir -p respaldos
  set -a; . ./.env; set +a
  docker exec geo_db pg_dump -U "${POSTGRES_USER:-geovisor}" -d "${POSTGRES_DB:-geovisor}" \
    | gzip > "respaldos/pre-deploy-$(date +%F-%H%M).sql.gz"
  echo "    guardado en respaldos/"
fi

if [[ "${SKIP_PULL:-0}" != "1" && "${REEJECUTADO:-0}" != "1" ]] && git rev-parse --git-dir >/dev/null 2>&1; then
  log "Actualizando codigo"
  git pull --ff-only
  # bash lee el script por trozos mientras lo ejecuta: si el pull acaba de
  # reemplazar este archivo, lo que queda por ejecutar es una mezcla de la
  # version vieja y la nueva. Volver a arrancar con el archivo ya actualizado.
  REEJECUTADO=1 exec "$0" "$@"
fi

log "Levantando servicios"
docker compose up -d --build

# El esquema es idempotente y se aplica en cada despliegue: asi las columnas
# nuevas llegan a una base que ya existe, sin recrearla ni perder datos.
log "Aplicando esquema"
set -a; . ./.env; set +a
until docker exec geo_db pg_isready -U "${POSTGRES_USER:-geovisor}" -q 2>/dev/null; do sleep 2; done
docker exec -i geo_db psql -U "${POSTGRES_USER:-geovisor}" -d "${POSTGRES_DB:-geovisor}" \
  -v ON_ERROR_STOP=1 -q < db/init.sql && echo "    esquema al dia"

# El Caddyfile se monta desde el disco, asi que 'compose up' no reinicia el
# contenedor cuando cambia y la configuracion nueva no llegaba a aplicarse.
if docker ps --format '{{.Names}}' | grep -qx geo_caddy; then
  log "Recargando configuracion de Caddy"
  docker exec geo_caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile \
    && echo "    configuracion al dia" \
    || { echo "    recarga fallida, reiniciando"; docker restart geo_caddy >/dev/null; }
fi

log "Estado"
docker compose ps

log "Esperando a que la API responda"
DOMINIO=$(grep -E '^DOMINIO=' .env | cut -d= -f2-)
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1/health" -H "Host: ${DOMINIO}" >/dev/null 2>&1; then
    echo "    API respondiendo"
    break
  fi
  sleep 2
done

log "Listo"
echo "    Visor:  https://${DOMINIO}"
echo
echo "Contenedores ajenos (deben seguir arriba):"
docker ps --filter 'name=oar_' --format '    {{.Names}}  {{.Status}}'
