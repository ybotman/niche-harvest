# Pi 5 Deployment Runbook

Tomorrow's hands-on runbook for deploying niche-harvest to the new Pi 5 8GB.

---

## Prerequisites checklist

- [ ] Pi 5 8GB (Vilros kit, 2026-04-29 hardware)
- [ ] microSD card (32GB+) OR M.2 NVMe SSD via Pi 5 M.2 HAT
- [ ] Pi 5 case + active cooler
- [ ] Power supply (Pi 5 needs 27W USB-C; included in kit)
- [ ] Ethernet cable (preferred over WiFi for first boot)
- [ ] Monitor + USB keyboard for first-boot config (or use SSH from another machine)
- [ ] GitHub SSH key access (if cloning private repo)
- [ ] MongoDB playground URI (or have it ready in 1Password)

---

## Step 1 — OS install (microSD or SSD)

### Option A: microSD (simpler, slower)

1. Download Raspberry Pi Imager: https://www.raspberrypi.com/software/
2. Insert microSD card into your laptop.
3. In Imager:
   - Choose Device: **Raspberry Pi 5**
   - Choose OS: **Raspberry Pi OS (64-bit) — Bookworm**
   - Choose Storage: your microSD card
   - Click ⚙️ (gear) for advanced config:
     - Hostname: `narvest-pi-1` (or whatever)
     - Enable SSH: yes (use password auth or paste your laptop's `~/.ssh/id_*.pub`)
     - Username: `tobybalsley` (your standard) — narvest user is created later by setup-pi.sh
     - Password: strong one, not reused
     - Locale + timezone: UTC strongly preferred for log alignment
     - Wireless LAN: configure if you'll use WiFi
4. Write the image. Eject card. Insert into Pi.

### Option B: NVMe SSD via M.2 HAT (faster, recommended for production)

1. **First boot from microSD** with Imager + Bookworm 64-bit (do Option A above).
2. Boot the Pi from microSD. After first boot, install the SSD bootloader update:
   ```bash
   sudo rpi-eeprom-config --edit
   # Set: BOOT_ORDER=0xf416 (NVMe first, then microSD)
   sudo reboot
   ```
3. Insert NVMe SSD into the M.2 HAT (HAT must be Pi 5 compatible — check kit docs).
4. Use Imager to write the same OS image directly to the NVMe SSD via USB-NVMe adapter.
5. Power off, remove microSD, boot from NVMe.

Verify SSD boot:
```bash
findmnt /
# Should show /dev/nvme0n1p2 or similar (not /dev/mmcblk0)
```

---

## Step 2 — First boot

1. Connect Ethernet (preferred; WiFi is fine but slower for the npm install step).
2. Power on. Wait ~60 seconds for first boot.
3. Find the Pi's IP from your router OR directly on monitor.
4. SSH in from your laptop:
   ```bash
   ssh tobybalsley@<pi-ip>
   ```

If SSH key was injected via Imager, no password needed.

---

## Step 3 — Run the bootstrap script

```bash
# Get the niche-harvest repo (lightweight clone for the deploy script)
git clone https://github.com/ybotman/niche-harvest.git /tmp/nh
cd /tmp/nh

# Run setup. It re-runs itself with sudo automatically.
bash deploy/pi/setup-pi.sh
```

The script will:
1. apt-get update + install git/curl/sqlite3/chromium-browser/build-essential/python3
2. Install Node.js 22 via Nodesource
3. Create `narvest` user (for systemd service)
4. Generate ssh keypair for narvest (will print public key — add to GitHub if needed)
5. Install Tailscale (does not authenticate yet)
6. Clone niche-harvest to `/home/narvest/niche-harvest`
7. `npm install`
8. Create `data/` dirs
9. Install systemd unit files (does NOT enable services yet)
10. Create `.env` template at `/home/narvest/niche-harvest/.env` (chmod 600)
11. Print next steps

If anything fails, the script is idempotent — fix the issue and re-run.

---

## Step 4 — Configure secrets (.env)

```bash
sudo -u narvest nano /home/narvest/niche-harvest/.env
```

Fill in:
```
MONGODB_URI_PLAYGROUND=mongodb+srv://playground:<password>@cluster0.wjzzbom.mongodb.net/?appName=Cluster0
NICHE_HARVEST_PLAYGROUND=1
BE_URL=https://calendarbeaf-test.azurewebsites.net
```

Verify chmod:
```bash
ls -la /home/narvest/niche-harvest/.env
# Should be -rw------- 1 narvest narvest
```

---

## Step 5 — Authenticate Tailscale (optional but recommended)

Allows you to SSH into the Pi from anywhere via tailnet IP.

```bash
sudo tailscale up
# Open the URL it prints in a browser, sign in
# Verify:
tailscale status
tailscale ip
```

After this, you can `ssh tobybalsley@<tailnet-ip>` from any device on your tailnet.

---

## Step 6 — Smoke test the pipeline

Test as the narvest user (which is what systemd will run as):

```bash
sudo -u narvest -H bash -c 'cd /home/narvest/niche-harvest && \
  source .env && export MONGODB_URI_PLAYGROUND NICHE_HARVEST_PLAYGROUND && \
  ./run.sh --niche=tango snapshot'
```

Expected: snapshot fetches all 7 iCal feeds, writes to `data/tango/snapshots/<date>.json`.

```bash
sudo -u narvest -H bash -c 'cd /home/narvest/niche-harvest && \
  ./run.sh --niche=tango enrich'
```

Expected: classifies events, geocodes ~50 venues, writes enriched state.

```bash
sudo -u narvest -H bash -c 'cd /home/narvest/niche-harvest && \
  source .env && export MONGODB_URI_PLAYGROUND NICHE_HARVEST_PLAYGROUND && \
  ./run.sh --niche=tango load --playground'
```

Expected: writes events to playground cluster. Should match the laptop run.

---

## Step 7 — Test scheduler with --once

```bash
sudo -u narvest -H bash -c 'cd /home/narvest/niche-harvest && \
  source .env && export MONGODB_URI_PLAYGROUND NICHE_HARVEST_PLAYGROUND && \
  ./run.sh --niche=tango schedule --once --target=playground'
```

Expected: scheduler runs one full cycle (snapshot + enrich + retries + load), then exits.

Check the heartbeat file:
```bash
cat /home/narvest/niche-harvest/data/tango/scheduler.heartbeat
# Should show {"timestamp": "...", "pid": ..., "status": "idle"}
```

---

## Step 8 — Phase 6 pre-flight Chromium memory test

Required before enabling FB integration (Phase 6). Validates ARCHITECTURE.md §8 budget.

```bash
sudo -u narvest -H bash /home/narvest/niche-harvest/deploy/pi/scripts/chromium-memory-test.sh 600
```

Expected:
- 10-minute test
- Peak RSS reported every 5 seconds
- PASS if peak < 1500 MB; FAIL if peak >= 1500 MB or OOM
- Report at `/home/narvest/niche-harvest/data/watchdog/chromium-memory-<timestamp>.json`

If FAIL: do NOT proceed with Phase 6 FB work on this Pi. Either upgrade hardware or revisit budget.

---

## Step 9 — Enable systemd for unattended operation

```bash
sudo systemctl enable --now niche-harvest.service
sudo systemctl enable --now niche-harvest-watchdog.timer
```

Verify:
```bash
sudo systemctl status niche-harvest.service
sudo systemctl status niche-harvest-watchdog.timer
sudo journalctl -u niche-harvest -f
```

The scheduler will:
- Run every 30 minutes (default `--tick=1800`)
- Snapshot all sources due (per `check_interval_days`)
- Enrich + 5 retry passes
- Load to playground (per `--target=playground` in service file)
- Write heartbeat to `data/tango/scheduler.heartbeat`

The watchdog timer will:
- Fire every 5 minutes
- Check heartbeat freshness (max 2h)
- Restart `niche-harvest.service` if heartbeat stale

---

## Step 10 — Health check + observation

```bash
# Logs
sudo journalctl -u niche-harvest -f

# Watchdog logs
sudo journalctl -u niche-harvest-watchdog -f

# Process status
ps -ef | grep niche-harvest

# Memory usage
top -p $(pgrep -d, -f niche-harvest)

# Heartbeat
watch -n 10 cat /home/narvest/niche-harvest/data/tango/scheduler.heartbeat

# SQLite state
sudo -u narvest sqlite3 /home/narvest/niche-harvest/data/tango/harvest.sqlite \
  'SELECT status, COUNT(*) FROM raw_events GROUP BY status;'
```

---

## Troubleshooting

**Service won't start:**
```bash
sudo journalctl -u niche-harvest -n 100 --no-pager
```
Common: `.env` missing, MONGODB_URI_PLAYGROUND not set, repo not at expected path.

**Out of memory:**
```bash
dmesg | grep -i "out of memory"
free -h
```
Lower `MemoryMax` in service file or reduce concurrency.

**Geocode rate is low:**
Investigate `data/tango/harvest.sqlite`:
```sql
SELECT geocode_status, COUNT(*) FROM venues GROUP BY geocode_status;
```
If many `pending`: scheduler hasn't completed enough retry passes yet (each tick does 5).

**Pi clock drift causing scheduler issues:**
```bash
timedatectl
sudo timedatectl set-ntp true
```

**Need to update niche-harvest code on Pi:**
```bash
sudo -u narvest -H bash -c 'cd /home/narvest/niche-harvest && git pull && npm install'
sudo systemctl restart niche-harvest
```

---

## Post-deploy verification (24h soak)

After enabling systemd, leave the Pi running for 24 hours and verify:

- [ ] Service is still running: `sudo systemctl status niche-harvest`
- [ ] No watchdog restarts: `sudo journalctl -u niche-harvest-watchdog --since "24 hours ago" | grep restart`
- [ ] Heartbeat fresh: `cat data/tango/scheduler.heartbeat | jq .timestamp` (within last hour)
- [ ] Loaded events grew over 24h: check playground cluster event count
- [ ] No OOM kills: `dmesg | grep -i "killed process"`
- [ ] Memory within budget: `top` shows scheduler RSS < 500 MB during normal operation

If all green: Pi is M1.5 ready. Update `MISSION.md` to close M1.5.
