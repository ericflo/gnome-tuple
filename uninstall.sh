#!/bin/bash
# Undo install.sh: disable the extension, remove it from the enabled list,
# and remove both links. Leaves Tuple itself (and its login) alone.
set -euo pipefail
uuid="tuple@ericflo"
dest="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$uuid"

gnome-extensions disable "$uuid" 2>/dev/null || true
current=$(gsettings get org.gnome.shell enabled-extensions)
if [[ $current == *"'$uuid'"* ]]; then
  updated=$(/usr/bin/python3 -I -c 'import ast, sys
l = ast.literal_eval(sys.argv[1].removeprefix("@as "))
print(repr([x for x in l if x != sys.argv[2]]))' "$current" "$uuid")
  gsettings set org.gnome.shell enabled-extensions "$updated"
fi
[[ -L $dest ]] && rm "$dest" && echo "removed $dest"
[[ -L $HOME/.local/bin/tuple-shell ]] && rm "$HOME/.local/bin/tuple-shell" && echo "removed ~/.local/bin/tuple-shell"
echo "disabled $uuid (log out and back in to drop it from the running shell)"
