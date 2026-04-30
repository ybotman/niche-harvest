#!/usr/bin/env bash
# deploy/pi/setup-pi.sh — Pi 5 first-boot bootstrap for niche-harvest.
#
# Run as: bash setup-pi.sh
# Idempotent — safe to re-run.
#
# What it does:
#   1. apt update + essential packages
#   2. Node.js 22 (via nodesource)
#   3. Create narvest user (no sudo, no shell login by default)
#   4. Generate ssh keypair (for git clone if pulling from private repo)
#   5. Install Tailscale (for remote SSH access)
#   6. Clone niche-harvest repo
#   7. npm install
#   8. Create data/ + log dirs
#   9. Install systemd units
#   10. Print next steps (env file, secrets, enable services)
#
# Prerequisites:
#   - Pi 5 8GB running Raspberry Pi OS Bookworm 64-bit
#   - Internet connected
#   - sudo access for the running user
#   - SSH access (optional — for remote operation)
#
# Run from any user with sudo. Script will:
#   - sudo install system packages
#   - create narvest user
#   - clone repo to /home/narvest/niche-harvest

set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/ybotman/niche-harvest.git}"
NARVEST_USER="narvest"
NARVEST_HOME="/home/${NARVEST_USER}"
INSTALL_DIR="${NARVEST_HOME}/niche-harvest"

log() {
  printf "[setup-pi] %s\n" "$*"
}

require_root() {
  if [[ $EUID -ne 0 ]]; then
    log "re-running with sudo..."
    exec sudo -E bash "$0" "$@"
  fi
}

step_apt() {
  log "Step 1: apt update + essential packages"
  apt-get update
  apt-get install -y \
    git \
    curl \
    wget \
    build-essential \
    python3 \
    sqlite3 \
    chromium-browser \
    chromium-codecs-ffmpeg \
    fonts-liberation \
    libnss3 \
    libgconf-2-4 \
    libxss1 \
    libasound2 \
    ca-certificates
}

step_node() {
  log "Step 2: Node.js 22"
  if command -v node >/dev/null 2>&1 && node --version | grep -q "^v22"; then
    log "  Node 22 already installed"
    return
  fi
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
  log "  Node $(node --version) installed"
}

step_user() {
  log "Step 3: narvest user"
  if id "$NARVEST_USER" >/dev/null 2>&1; then
    log "  user '$NARVEST_USER' already exists"
  else
    useradd -m -s /bin/bash "$NARVEST_USER"
    log "  user '$NARVEST_USER' created"
  fi
  # Allow narvest to write to its own data dir
  install -d -m 0755 -o "$NARVEST_USER" -g "$NARVEST_USER" \
    "$NARVEST_HOME/.ssh" \
    "$NARVEST_HOME/logs"
}

step_ssh_key() {
  log "Step 4: ssh keypair for narvest user"
  local key="$NARVEST_HOME/.ssh/id_ed25519"
  if [[ -f "$key" ]]; then
    log "  ssh key already exists at $key"
  else
    sudo -u "$NARVEST_USER" ssh-keygen -t ed25519 -f "$key" -N "" -C "narvest@$(hostname)"
    log "  ssh key created"
    log "  PUBLIC KEY (add to GitHub if cloning private repo):"
    cat "${key}.pub"
  fi
}

step_tailscale() {
  log "Step 5: Tailscale (for remote SSH)"
  if command -v tailscale >/dev/null 2>&1; then
    log "  tailscale already installed"
  else
    curl -fsSL https://tailscale.com/install.sh | sh
    log "  tailscale installed"
    log "  Run 'sudo tailscale up' AFTER setup completes to authenticate"
  fi
}

step_clone() {
  log "Step 6: clone niche-harvest"
  if [[ -d "$INSTALL_DIR/.git" ]]; then
    log "  repo already at $INSTALL_DIR; pulling latest"
    sudo -u "$NARVEST_USER" git -C "$INSTALL_DIR" pull --ff-only origin main || true
  else
    sudo -u "$NARVEST_USER" git clone "$REPO_URL" "$INSTALL_DIR"
    log "  repo cloned to $INSTALL_DIR"
  fi
}

step_npm_install() {
  log "Step 7: npm install"
  sudo -u "$NARVEST_USER" -H bash -c "cd '$INSTALL_DIR' && npm install --production=false"
}

step_data_dirs() {
  log "Step 8: data dirs"
  install -d -m 0755 -o "$NARVEST_USER" -g "$NARVEST_USER" \
    "$INSTALL_DIR/data/tango" \
    "$INSTALL_DIR/data/tango/snapshots" \
    "$INSTALL_DIR/data/tango/geocode-cache" \
    "$INSTALL_DIR/data/watchdog"
}

step_systemd() {
  log "Step 9: install systemd units"
  install -m 0644 \
    "$INSTALL_DIR/deploy/pi/systemd/niche-harvest.service" \
    /etc/systemd/system/niche-harvest.service
  install -m 0644 \
    "$INSTALL_DIR/deploy/pi/systemd/niche-harvest-watchdog.service" \
    /etc/systemd/system/niche-harvest-watchdog.service
  install -m 0644 \
    "$INSTALL_DIR/deploy/pi/systemd/niche-harvest-watchdog.timer" \
    /etc/systemd/system/niche-harvest-watchdog.timer
  systemctl daemon-reload
  log "  systemd units installed (NOT enabled — see next steps)"
}

step_env_template() {
  log "Step 10: .env template"
  local env_file="$INSTALL_DIR/.env"
  if [[ -f "$env_file" ]]; then
    log "  $env_file already exists; not overwriting"
    return
  fi
  cat > "$env_file" <<'EOF'
# niche-harvest Pi environment file
# Loaded by systemd via EnvironmentFile=
# DO NOT commit; contains secrets

# Playground MongoDB (ephemeral cluster)
MONGODB_URI_PLAYGROUND=
NICHE_HARVEST_PLAYGROUND=1

# Live MongoDB (TT_Test) — only set when authorized for live writes
# MONGODB_URI_TEST=
# NICHE_HARVEST_LIVE=1

# Backend URL for category cache + venue AutoMaster
BE_URL=https://calendarbeaf-test.azurewebsites.net
EOF
  chown "$NARVEST_USER:$NARVEST_USER" "$env_file"
  chmod 0600 "$env_file"
  log "  .env template created at $env_file (chmod 600)"
}

print_next_steps() {
  cat <<EOF

═══════════════════════════════════════════════════════════════
  Pi setup COMPLETE — next steps (manual)
═══════════════════════════════════════════════════════════════

1. Edit /home/narvest/niche-harvest/.env and fill secrets:
   sudo -u narvest nano /home/narvest/niche-harvest/.env

2. (Optional) Authenticate Tailscale for remote SSH:
   sudo tailscale up

3. Smoke test the pipeline manually:
   sudo -u narvest -H bash -c 'cd /home/narvest/niche-harvest && \\
     ./run.sh --niche=tango snapshot && ./run.sh --niche=tango enrich'

4. Test scheduler with --once:
   sudo -u narvest -H bash -c 'cd /home/narvest/niche-harvest && \\
     ./run.sh --niche=tango schedule --once --target=playground'

5. Enable systemd services for unattended operation:
   sudo systemctl enable --now niche-harvest.service
   sudo systemctl enable --now niche-harvest-watchdog.timer

6. Tail logs:
   sudo journalctl -u niche-harvest -f

═══════════════════════════════════════════════════════════════
EOF
}

main() {
  require_root "$@"
  step_apt
  step_node
  step_user
  step_ssh_key
  step_tailscale
  step_clone
  step_npm_install
  step_data_dirs
  step_systemd
  step_env_template
  print_next_steps
}

main "$@"
