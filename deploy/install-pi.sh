#!/usr/bin/env bash
# One-shot setup for Raspberry Pi OS (run from the repo folder).
set -euo pipefail
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 18 ]; then
  echo "Installing Node.js 22..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
npm install --omit=dev
[ -f .env ] || { cp .env.example .env; echo "Edit .env and add your DISCORD_TOKEN"; }
sed -e "s#/home/pi/bdfd-pi-ultra#$PWD#" -e "s#User=pi#User=$USER#" deploy/bdx.service | sudo tee /etc/systemd/system/bdx.service >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable bdx
echo "Done. Start with: sudo systemctl start bdx   Logs: journalctl -u bdx -f"
