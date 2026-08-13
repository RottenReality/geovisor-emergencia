#!/usr/bin/env bash
# Prepara la VPS para el geovisor. Es idempotente: se puede repetir sin dano.
# NO toca ni detiene contenedores existentes.
set -euo pipefail

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
ok()  { printf '    \033[1;32mOK\033[0m %s\n' "$*"; }

if [[ $EUID -ne 0 ]]; then
  echo "Ejecutar como root: sudo ./setup-vps.sh" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# 1. SWAP
# La VPS arranca con 0 swap. Convertir una ortofoto con GDAL puede pedir mas
# RAM de la disponible y el kernel mataria contenedores (incluidos los ajenos).
# ---------------------------------------------------------------------------
log "Configurando swap de 4 GB"
if swapon --show | grep -q '/swapfile'; then
  ok "swap ya activo"
else
  if [[ ! -f /swapfile ]]; then
    fallocate -l 4G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=4096
  fi
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  ok "swap de 4 GB activado"
fi
grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
# Preferir RAM; usar swap solo como red de seguridad.
sysctl -qw vm.swappiness=10
grep -q '^vm.swappiness' /etc/sysctl.conf || echo 'vm.swappiness=10' >> /etc/sysctl.conf
ok "vm.swappiness=10"

# ---------------------------------------------------------------------------
# 2. Docker
# ---------------------------------------------------------------------------
log "Verificando Docker"
if command -v docker >/dev/null 2>&1; then
  ok "docker $(docker --version | awk '{print $3}' | tr -d ,)"
else
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
  ok "docker instalado"
fi
docker compose version >/dev/null 2>&1 || { echo "Falta el plugin docker compose" >&2; exit 1; }
ok "docker compose disponible"

# ---------------------------------------------------------------------------
# 3. Puertos 80/443 libres
# ---------------------------------------------------------------------------
log "Verificando que 80 y 443 esten libres"
for p in 80 443; do
  if ss -tln "sport = :$p" 2>/dev/null | grep -q LISTEN; then
    echo "ERROR: el puerto $p ya esta ocupado. Liberarlo antes de desplegar." >&2
    ss -tlnp "sport = :$p"
    exit 1
  fi
done
ok "80 y 443 libres"

# ---------------------------------------------------------------------------
# 4. Firewall (OPT-IN)
# Desactivado por defecto a proposito: habilitar ufw a ciegas en un servidor
# remoto puede cortar la propia sesion SSH. Activar con ENABLE_FIREWALL=1.
# ---------------------------------------------------------------------------
if [[ "${ENABLE_FIREWALL:-0}" == "1" ]]; then
  log "Configurando firewall (ufw)"
  apt-get update -qq && apt-get install -y -qq ufw
  ufw allow 22/tcp
  ufw allow 80/tcp
  ufw allow 443/tcp
  ufw --force enable
  ok "ufw activo (22, 80, 443)"
else
  log "Firewall omitido (exportar ENABLE_FIREWALL=1 para configurarlo)"
fi

# ---------------------------------------------------------------------------
# 5. Respaldo diario de la base
# ---------------------------------------------------------------------------
log "Programando respaldo diario"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$REPO_DIR/respaldos"
cat > /usr/local/bin/geovisor-respaldo.sh <<BACKUP
#!/usr/bin/env bash
set -euo pipefail
REPO="$REPO_DIR"
DEST="\$REPO/respaldos"
mkdir -p "\$DEST"
# cron no hereda el entorno: leer credenciales del .env del repo.
set -a; . "\$REPO/.env"; set +a
docker exec geo_db pg_dump -U "\${POSTGRES_USER:-geovisor}" -d "\${POSTGRES_DB:-geovisor}" \
  | gzip > "\$DEST/geovisor-\$(date +%F-%H%M).sql.gz"
# Retencion: 7 dias
find "\$DEST" -name 'geovisor-*.sql.gz' -mtime +7 -delete
BACKUP
chmod +x /usr/local/bin/geovisor-respaldo.sh
cat > /etc/cron.d/geovisor-respaldo <<'CRON'
0 3 * * * root /usr/local/bin/geovisor-respaldo.sh >> /var/log/geovisor-respaldo.log 2>&1
CRON
ok "respaldo diario a las 03:00, retencion 7 dias"

log "VPS lista"
free -h
echo
echo "Siguiente paso:  ./deploy.sh"
