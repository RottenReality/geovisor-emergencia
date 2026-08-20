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
  # El catastro va SIN sus filas: es una copia de solo lectura de un servicio
  # publico, reimportable con `python -m app.catastro`, y son ~1 GB que si no
  # se arrastrarian en cada respaldo de cada despliegue. La estructura si va,
  # para que restaurar deje la base lista para reimportar.
  docker exec geo_db pg_dump -U "${POSTGRES_USER:-geovisor}" -d "${POSTGRES_DB:-geovisor}" \
    --exclude-table-data=catastro \
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

# El Caddyfile se monta como archivo suelto. Al actualizarlo, git escribe un
# archivo nuevo en vez de modificar el existente, y el montaje del contenedor
# se queda apuntando al inodo viejo: dentro se sigue viendo la configuracion
# anterior, y recargar no sirve porque Caddy lee justamente ese archivo. Solo
# recrear el contenedor rehace el montaje.
if docker ps --format '{{.Names}}' | grep -qx geo_caddy; then
  aqui=$(sha256sum Caddyfile | cut -d' ' -f1)
  alla=$(docker exec geo_caddy sha256sum /etc/caddy/Caddyfile 2>/dev/null | cut -d' ' -f1)
  if [[ "$aqui" != "$alla" ]]; then
    log "El Caddyfile cambio: validando antes de aplicarlo"
    # Validar primero. Un error de sintaxis deja a Caddy reiniciandose en
    # bucle y el visor entero inaccesible; comprobarlo cuesta dos segundos.
    if docker run --rm -e DOMINIO="${DOMINIO}" \
         -v "$PWD/Caddyfile:/etc/caddy/Caddyfile:ro" caddy:2-alpine \
         caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1; then
      echo "    configuracion valida, recreando"
      docker compose up -d --force-recreate caddy
    else
      echo "    ERROR: el Caddyfile no es valido. Se deja el anterior en marcha." >&2
      docker run --rm -e DOMINIO="${DOMINIO}" \
        -v "$PWD/Caddyfile:/etc/caddy/Caddyfile:ro" caddy:2-alpine \
        caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1 | tail -3 >&2
      exit 1
    fi
  fi
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
