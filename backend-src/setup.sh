#!/bin/bash
# Red Shrimp Lab — Bare-metal setup script (no Docker)
# Run once on a fresh Ubuntu 22.04 / Alibaba Cloud ECS

set -e

echo "=== Red Shrimp Lab Setup ==="

# ── Node.js 22 ────────────────────────────────────────────────────
if ! command -v node &>/dev/null; then
  echo "Installing Node.js 22..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
echo "Node: $(node -v)"

# ── PostgreSQL 16 ─────────────────────────────────────────────────
if ! command -v psql &>/dev/null; then
  echo "Installing PostgreSQL 16..."
  sudo apt-get install -y postgresql postgresql-contrib
  sudo systemctl enable postgresql
  sudo systemctl start postgresql
fi

# Create DB and user
DB_NAME=${DB_NAME:-redshrimp}
DB_USER=${DB_USER:-postgres}
echo "Creating database '$DB_NAME'..."
sudo -u postgres psql -c "CREATE DATABASE $DB_NAME;" 2>/dev/null || echo "DB may already exist, skipping."

# ── Run schema ────────────────────────────────────────────────────
echo "Running schema migrations..."
sudo -u postgres psql -d "$DB_NAME" -f src/db/schema.sql
echo "Schema applied."

# ── npm install ───────────────────────────────────────────────────
echo "Installing dependencies..."
npm install

# ── Upload directory ──────────────────────────────────────────────
UPLOADS_DIR=${UPLOADS_DIR:-/var/redshrimp/uploads}
sudo mkdir -p "$UPLOADS_DIR"
sudo chown "$USER:$USER" "$UPLOADS_DIR"
echo "Upload dir: $UPLOADS_DIR"

# ── systemd service ───────────────────────────────────────────────
WORK_DIR=$(pwd)
cat > /tmp/redshrimp.service << EOF
[Unit]
Description=Red Shrimp Lab Backend
After=network.target postgresql.service

[Service]
Type=simple
User=$USER
WorkingDirectory=$WORK_DIR
ExecStart=/usr/bin/node --loader ts-node/esm src/index.ts
Restart=always
RestartSec=5
EnvironmentFile=$WORK_DIR/.env
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

sudo cp /tmp/redshrimp.service /etc/systemd/system/redshrimp.service
sudo systemctl daemon-reload
sudo systemctl enable redshrimp

echo ""
echo "=== Setup complete ==="
echo "1. Copy .env.example to .env and fill in values"
echo "2. sudo systemctl start redshrimp"
echo "3. sudo journalctl -u redshrimp -f   (view logs)"
