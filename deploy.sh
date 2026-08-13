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

if [[ "${SKIP_PULL:-0}" != "1" ]] && git rev-parse --git-dir >/dev/null 2>&1; then
  log "Actualizando codigo"
  git pull --ff-only
fi

log "Levantando servicios"
docker compose up -d --build

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
