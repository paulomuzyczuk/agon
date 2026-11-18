#!/usr/bin/env bash
# Installs Agon's USER-level systemd units (no sudo): sync, freshness, backup and
# the Monday calendar reconcile.
#
#   deploy/user/install.sh                 all four units
#   deploy/user/install.sh agon-sync       just one (several may be named)
#   deploy/user/install.sh --no-reload     skip `systemctl --user daemon-reload`
#
# Why a script: the unit files in this folder are TEMPLATES. Two things differ
# on every machine, the folder you cloned the repo into and where `pnpm` lives
# (an nvm install is versioned), and they used to be edited into the copied
# unit. Copying a unit again then silently put the template values back and the
# job died on its first step (agon-sync, 2026-11-18: "Changing to the requested
# working directory failed").
#
# So the per-machine values live in a systemd drop-in instead,
#   ~/.config/systemd/user/<unit>.service.d/local.conf
# written ONCE with this checkout's real path and the pnpm found on your PATH.
# Re-running this script refreshes the unit and timer from the repo but never
# touches an existing local.conf: edit that file for anything else that is
# specific to your machine (an extra Environment=, a different PATH, ...).
#
# It does not enable any timer. Afterwards, per unit:
#   systemctl --user enable --now <unit>.timer
#   systemctl --user start <unit>.service     # run once, now
#   journalctl --user -u <unit> -n 40
# and once, so user timers keep running while you are logged out:
#   loginctl enable-linger "$USER"
#
# Environment (mostly for tests): AGON_SYSTEMD_USER_DIR overrides the target
# folder, AGON_PNPM_DIR the directory put first on PATH.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC="$REPO/deploy/user"
UNIT_DIR="${AGON_SYSTEMD_USER_DIR:-$HOME/.config/systemd/user}"
ALL_UNITS=(agon-sync agon-freshness agon-backup agon-calendar-reconcile)

reload=1
units=()
for arg in "$@"; do
  case "$arg" in
    --no-reload) reload=0 ;;
    -h | --help) sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "install.sh: unknown option '$arg'" >&2; exit 2 ;;
    *) units+=("$arg") ;;
  esac
done
[ ${#units[@]} -gt 0 ] || units=("${ALL_UNITS[@]}")

for u in "${units[@]}"; do
  if [ ! -f "$SRC/$u.service" ]; then
    echo "install.sh: no such unit '$u' (have: ${ALL_UNITS[*]})" >&2
    exit 2
  fi
done

pnpm_dir="${AGON_PNPM_DIR:-}"
if [ -z "$pnpm_dir" ]; then
  if ! pnpm_bin="$(command -v pnpm)"; then
    echo "install.sh: pnpm is not on your PATH; install it, or set AGON_PNPM_DIR" >&2
    exit 1
  fi
  pnpm_dir="$(dirname "$pnpm_bin")"
fi

mkdir -p "$UNIT_DIR"
for u in "${units[@]}"; do
  cp "$SRC/$u.service" "$UNIT_DIR/$u.service"
  [ -f "$SRC/$u.timer" ] && cp "$SRC/$u.timer" "$UNIT_DIR/$u.timer"

  conf="$UNIT_DIR/$u.service.d/local.conf"
  if [ -e "$conf" ]; then
    echo "$u: unit refreshed; kept your $conf"
    continue
  fi
  mkdir -p "$UNIT_DIR/$u.service.d"
  cat > "$conf" <<CONF
# This machine's settings for $u.service. Written once by deploy/user/install.sh;
# re-running it never overwrites this file. Edit freely.
[Service]
WorkingDirectory=$REPO
Environment=PATH=$pnpm_dir:/usr/local/bin:/usr/bin:/bin
CONF
  echo "$u: installed; wrote $conf"
done

if [ "$reload" -eq 1 ]; then
  systemctl --user daemon-reload
fi
echo "Done. Enable a timer with: systemctl --user enable --now <unit>.timer"
