#!/bin/bash
# Install the Tuple extension for this user: link it into GNOME Shell's
# extension directory, compile its settings schema, put tuple-shell in
# ~/.local/bin, and enable it. Re-running is safe.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
uuid="tuple@ericflo"
ext="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions"
dest="$ext/$uuid"

mkdir -p "$ext"
if [[ -L $dest ]]; then
  ln -sfn "$here/$uuid" "$dest"
elif [[ -e $dest ]]; then
  echo "install: $dest exists and is not a symlink; leaving it alone" >&2
  exit 1
else
  ln -s "$here/$uuid" "$dest"
fi
echo "linked $dest -> $here/$uuid"

glib-compile-schemas "$here/$uuid/schemas"

mkdir -p "$HOME/.local/bin"
ln -sfn "$here/$uuid/bin/tuple-shell" "$HOME/.local/bin/tuple-shell"
echo "linked ~/.local/bin/tuple-shell"

# Through the shell if it already has the extension loaded; otherwise add it
# to the enabled list, which GNOME Shell reads at the next login (on Wayland
# it only discovers new extensions when it starts).
if gnome-extensions enable "$uuid" 2>/dev/null; then
  echo "enabled $uuid"
else
  current=$(gsettings get org.gnome.shell enabled-extensions)
  if [[ $current != *"'$uuid'"* ]]; then
    updated=$(/usr/bin/python3 -I -c 'import ast, sys
l = ast.literal_eval(sys.argv[1].removeprefix("@as "))
print(repr(l + [sys.argv[2]]))' "$current" "$uuid")
    gsettings set org.gnome.shell enabled-extensions "$updated"
  fi
  echo "added $uuid to enabled-extensions — log out and back in to load it"
fi
