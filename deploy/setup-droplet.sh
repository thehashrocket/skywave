#!/usr/bin/env bash
# One-time setup for a fresh Ubuntu 24.04 Droplet that runs the radio service.
# Run as root:  bash setup-droplet.sh
# Safe to run again.
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "run as root" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

echo "==> packages and automatic security updates"
apt-get update
apt-get -y upgrade
apt-get install -y ca-certificates curl git ufw unattended-upgrades
dpkg-reconfigure -f noninteractive unattended-upgrades

echo "==> Docker (official apt repo)"
if ! command -v docker >/dev/null; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi

echo "==> Docker log rotation (default for every container)"
if [[ ! -f /etc/docker/daemon.json ]]; then
  cat > /etc/docker/daemon.json <<'JSON'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "5" }
}
JSON
  systemctl restart docker
fi
systemctl enable --now docker

echo "==> 1 GB swap (headroom for building numpy/scipy wheels on a small box)"
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 1G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "==> firewall: SSH, HTTP, HTTPS (+ HTTP/3)"
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp
ufw --force enable

echo "==> deploy user"
if ! id deploy >/dev/null 2>&1; then
  adduser --disabled-password --gecos "" deploy
  usermod -aG docker deploy
  if [[ -f /root/.ssh/authorized_keys ]]; then
    install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
    install -m 600 -o deploy -g deploy /root/.ssh/authorized_keys /home/deploy/.ssh/authorized_keys
  fi
fi

cat <<'MSG'

Done. Next, as the deploy user (ssh deploy@<droplet>):
  git clone <repo> skywave && cd skywave
  cp apps/radio/.env.example apps/radio/.env    # then edit it (see deploy/README.md)
  echo 'RADIO_DOMAIN=radio.example.com' > .env
  docker compose -f docker-compose.prod.yml up -d --build

Docker publishes 80/443 itself, so ufw isn't what guards them; also attach a
DigitalOcean Cloud Firewall allowing only 22, 80 and 443.
MSG
