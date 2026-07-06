#!/usr/bin/env bash
# OptiScan one-time VPS bootstrap (Ubuntu 22.04/24.04).
# Run as root on a fresh droplet:
#   curl -fsSL https://raw.githubusercontent.com/bexgonz37/optiscan/main/scripts/vps-setup.sh | bash
set -euo pipefail

REPO="${OPTISCAN_REPO:-https://github.com/bexgonz37/optiscan.git}"
DIR="${OPTISCAN_DIR:-/opt/optiscan}"

echo "==> OptiScan VPS setup"
echo "    install dir: $DIR"

if ! command -v docker >/dev/null 2>&1; then
  echo "==> Installing Docker..."
  apt-get update -qq
  apt-get install -y ca-certificates curl git
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
fi

mkdir -p "$DIR"
if [ ! -d "$DIR/.git" ]; then
  git clone "$REPO" "$DIR"
else
  git -C "$DIR" pull --ff-only
fi

cd "$DIR"

if [ ! -f .env.production ]; then
  cp env.production.example .env.production
  echo ""
  echo "==> Created .env.production — EDIT IT NOW:"
  echo "    nano $DIR/.env.production"
  echo "    Set POLYGON_API_KEY and SCAN_API_TOKEN at minimum."
  echo ""
  read -r -p "Press Enter after you've saved .env.production..." _
fi

echo "==> Building and starting OptiScan..."
docker compose up -d --build

echo ""
echo "==> Done. OptiScan should be running on port 8780."
echo "    Health: curl http://localhost:8780/api/health"
echo "    UI:     http://YOUR_SERVER_IP:8780"
echo ""
echo "    Open firewall port 8780 only to your IP, or use SSH tunnel:"
echo "      ssh -L 8780:localhost:8780 root@YOUR_SERVER_IP"
echo ""
echo "    In browser console (once): localStorage.setItem('optiscan:token', 'YOUR_SCAN_API_TOKEN')"
echo ""
docker compose ps
