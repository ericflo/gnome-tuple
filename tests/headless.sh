#!/bin/bash
# Render the extension in a throwaway headless GNOME Shell (its own D-Bus
# session, dconf, XDG dirs and runtime dir — nothing touches your desktop)
# and screenshot the menu in each demo state.
#
# Usage: tests/headless.sh [out-dir] [dark|light]   screenshots
#        tests/headless.sh --clicks                   click the switches with a
#                                                     virtual pointer (tests/clicks.js)
#        tests/headless.sh --stage [out-dir]          the camera flow and call stage
#                                                     with real input (tests/stage.js)
set -euo pipefail

mode=screenshots
if [[ ${1:-} == --clicks ]]; then mode=clicks; shift; fi
if [[ ${1:-} == --stage ]]; then mode=stage; shift; fi

here=$(cd "$(dirname "$0")/.." && pwd)
out=$(realpath -m "${1:-/tmp/tuple-shots}")
scheme=${2:-dark}
root=$(mktemp -d /tmp/tuple-gs.XXXXXX)
mkdir -p "$root"/{data/gnome-shell/extensions,config,cache,state,runtime} "$out"
chmod 700 "$root/runtime"
ln -s "$here/tuple@ericflo" "$root/data/gnome-shell/extensions/tuple@ericflo"
ln -s "$here/tests/clicker@tuple-test" "$root/data/gnome-shell/extensions/clicker@tuple-test"

# Profile pictures for the demo people (and "you"), so screenshots show them
# without the network; Bob and Erin have none, which keeps their initials.
pics=$root/cache/tuple-gnome/avatars
mkdir -p "$pics"
seed() {  # email letter colour colour
  local h; h=$(printf '%s' "$1" | md5sum | cut -d' ' -f1)
  if [ -z "${2:-}" ]; then echo none > "$pics/$h.none"; return; fi
  magick -size 96x96 "gradient:$3-$4" -gravity center -pointsize 46 -fill white -annotate 0 "$2" "png:$pics/$h.img"
}
seed alice@example.com A '#3584e4' '#1c71d8'
seed carol@example.com C '#e66100' '#c64600'
seed dev@example.com D '#2ec27e' '#26a269'
seed femi@example.com F '#9141ac' '#813d9c'
seed you@example.com Y '#c01c28' '#a51d2d'
seed bob@example.com
seed erin@example.com

export XDG_DATA_HOME=$root/data XDG_CONFIG_HOME=$root/config XDG_CACHE_HOME=$root/cache
export XDG_STATE_HOME=$root/state XDG_RUNTIME_DIR=$root/runtime
unset DISPLAY WAYLAND_DISPLAY

dbus-run-session -- bash -c '
  set -u
  root=$1 here=$2 out=$3 scheme=$4 mode=$5
  gsettings set org.gnome.shell enabled-extensions "[\"tuple@ericflo\", \"clicker@tuple-test\"]"
  gsettings set org.gnome.shell disable-user-extensions false
  gsettings set org.gnome.shell welcome-dialog-last-shown-version "999"
  gsettings set org.gnome.desktop.interface color-scheme "prefer-$scheme"
  # A plain backdrop, so screenshots show the menu and not your wallpaper.
  for key in picture-uri picture-uri-dark; do gsettings set org.gnome.desktop.background $key ""; done
  gsettings set org.gnome.desktop.background picture-options none
  gsettings set org.gnome.desktop.background color-shading-type solid
  gsettings set org.gnome.desktop.background primary-color "#241f31"
  gnome-shell --headless --virtual-monitor 1280x1100 --no-x11 --wayland-display tuple-test-0 \
    > "$root/shell.log" 2>&1 &
  shell=$!
  gdbus wait --session --timeout 60 org.gnome.Shell || { echo "shell did not start"; tail -30 "$root/shell.log"; exit 1; }
  sleep 4
  case "$mode" in
    clicks) gjs -m "$here/tests/clicks.js" ;;
    stage) gjs -m "$here/tests/stage.js" "$out" ;;
    *) gjs -m "$here/tests/screenshots.js" "$out" ;;
  esac
  status=$?
  kill $shell 2>/dev/null; wait $shell 2>/dev/null
  echo "--- shell log (extension lines)"
  grep -iE "tuple|JS ERROR|JS WARNING|Gjs-CRITICAL|St-CRITICAL" "$root/shell.log" | grep -v "^$" | head -60
  exit $status
' _ "$root" "$here" "$out" "$scheme" "$mode"
