#!/usr/bin/env bash
# deploy/pi/scripts/install-kiosk.sh — configure Pi to auto-launch chromium
# in kiosk mode pointing at the niche-harvest dashboard.
#
# Run as the desktop user (NOT root, NOT narvest). The kiosk runs in the
# desktop session of whoever is auto-logged-in (typically `ybotman`).
#
# Prerequisites:
#   - Pi auto-login enabled (via Imager or raspi-config → System Options
#     → Boot/Auto Login → Desktop Autologin)
#   - chromium-browser or chromium installed
#   - niche-harvest-dashboard.service running (provides http://localhost:9000)
#   - Trixie RPi OS uses Wayland with labwc or wayfire compositor
#
# Usage:
#   bash install-kiosk.sh

set -euo pipefail

URL="${KIOSK_URL:-http://localhost:9000}"

# Find chromium binary
CHROMIUM=""
for cmd in chromium chromium-browser /usr/bin/chromium /usr/bin/chromium-browser; do
  if command -v "$cmd" >/dev/null 2>&1 || [[ -x "$cmd" ]]; then
    CHROMIUM="$cmd"
    break
  fi
done
if [[ -z "$CHROMIUM" ]]; then
  echo "install-kiosk: no chromium binary found"
  exit 1
fi
echo "install-kiosk: using $CHROMIUM"

# 1. Write a kiosk launcher script
mkdir -p "$HOME/.local/bin"
cat > "$HOME/.local/bin/nh-kiosk.sh" <<EOF
#!/usr/bin/env bash
# Auto-launch niche-harvest dashboard in fullscreen kiosk mode.
# Waits for dashboard server to be reachable before opening.

# Wait up to 60s for the dashboard server to come up
for i in {1..30}; do
  if curl -sf -o /dev/null --max-time 2 "$URL/api/state" 2>/dev/null; then
    break
  fi
  sleep 2
done

# Hide cursor after 1s of inactivity (requires unclutter; best-effort)
unclutter -idle 1 -root &

# Disable screen blanking (X11) — labwc/wayfire have separate idle settings
xset -dpms 2>/dev/null || true
xset s off 2>/dev/null || true

# Launch chromium in kiosk mode
exec $CHROMIUM \\
  --kiosk \\
  --noerrdialogs \\
  --no-first-run \\
  --disable-infobars \\
  --disable-translate \\
  --disable-features=TranslateUI \\
  --disable-pinch \\
  --overscroll-history-navigation=0 \\
  --check-for-update-interval=31536000 \\
  --user-data-dir=\$HOME/.config/chromium-kiosk \\
  "$URL"
EOF
chmod +x "$HOME/.local/bin/nh-kiosk.sh"
echo "install-kiosk: wrote $HOME/.local/bin/nh-kiosk.sh"

# 2. Wayland labwc autostart (Trixie default). Falls back to wayfire/.config
#    if labwc isn't present, then to LXDE for older configs.
LABWC_DIR="$HOME/.config/labwc"
WAYFIRE_INI="$HOME/.config/wayfire.ini"
LXDE_AUTOSTART="$HOME/.config/lxsession/LXDE-pi/autostart"

if command -v labwc >/dev/null 2>&1 || [[ -d "$LABWC_DIR" ]]; then
  mkdir -p "$LABWC_DIR"
  cat > "$LABWC_DIR/autostart" <<EOF
# niche-harvest dashboard kiosk autostart (labwc)
~/.local/bin/nh-kiosk.sh &
EOF
  chmod +x "$LABWC_DIR/autostart"
  echo "install-kiosk: configured labwc autostart at $LABWC_DIR/autostart"
elif [[ -f "$WAYFIRE_INI" ]] || command -v wayfire >/dev/null 2>&1; then
  # wayfire has a [autostart] section
  if [[ ! -f "$WAYFIRE_INI" ]]; then
    cat > "$WAYFIRE_INI" <<EOF
[autostart]
nh_kiosk = ~/.local/bin/nh-kiosk.sh
EOF
  else
    if ! grep -q "nh_kiosk" "$WAYFIRE_INI"; then
      if grep -q "^\[autostart\]" "$WAYFIRE_INI"; then
        # Append under existing [autostart] section
        sed -i "/^\[autostart\]/a nh_kiosk = ~/.local/bin/nh-kiosk.sh" "$WAYFIRE_INI"
      else
        printf "\n[autostart]\nnh_kiosk = ~/.local/bin/nh-kiosk.sh\n" >> "$WAYFIRE_INI"
      fi
    fi
  fi
  echo "install-kiosk: configured wayfire autostart at $WAYFIRE_INI"
elif [[ -d "$(dirname "$LXDE_AUTOSTART")" ]] || [[ -f "$LXDE_AUTOSTART" ]]; then
  mkdir -p "$(dirname "$LXDE_AUTOSTART")"
  if [[ ! -f "$LXDE_AUTOSTART" ]] || ! grep -q "nh-kiosk" "$LXDE_AUTOSTART"; then
    echo "@$HOME/.local/bin/nh-kiosk.sh" >> "$LXDE_AUTOSTART"
  fi
  echo "install-kiosk: configured LXDE autostart at $LXDE_AUTOSTART"
else
  echo "install-kiosk: WARN — no compositor autostart location found"
  echo "install-kiosk: launch manually: ~/.local/bin/nh-kiosk.sh"
fi

# 3. Install unclutter (cursor hider) if missing
if ! command -v unclutter >/dev/null 2>&1; then
  echo "install-kiosk: installing unclutter..."
  sudo apt-get install -y unclutter || echo "install-kiosk: WARN — unclutter install failed (cursor will be visible)"
fi

cat <<EOF

═══════════════════════════════════════════════════════════════
  Kiosk install COMPLETE
═══════════════════════════════════════════════════════════════

Dashboard URL: $URL
Kiosk launcher: $HOME/.local/bin/nh-kiosk.sh

To activate:
  - Reboot the Pi: sudo reboot
  - On boot, the dashboard will auto-launch fullscreen

To test now (without reboot):
  ~/.local/bin/nh-kiosk.sh

To exit kiosk:
  - From the Pi: Alt+F4 (most compositors)
  - From SSH:    sudo pkill chromium

═══════════════════════════════════════════════════════════════
EOF
