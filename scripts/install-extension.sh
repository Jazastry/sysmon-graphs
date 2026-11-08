#!/usr/bin/env bash
# Installs src/ as a GNOME Shell extension for the current user (npm run install-extension).
# The target folder must carry the extension's uuid, so the uuid is read from src/metadata.json.
#   EXTENSIONS_DIR=/some/dir npm run install-extension     install somewhere else (used by the tests)
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
src="$root/src"

uuid="$(sed -n 's/.*"uuid"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$src/metadata.json" | head -1)"
[ -n "$uuid" ] || { echo "could not read the uuid from $src/metadata.json" >&2; exit 1; }
command -v glib-compile-schemas >/dev/null 2>&1 || { echo "missing: glib-compile-schemas (Ubuntu: sudo apt install libglib2.0-bin)" >&2; exit 1; }

extensions="${EXTENSIONS_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions}"
dest="$extensions/$uuid"

mkdir -p "$extensions"
rm -rf "$dest"                       # a clean copy: files deleted from src/ must not linger
mkdir -p "$dest"
cp -r "$src"/. "$dest"/
glib-compile-schemas "$dest/schemas" # always ship a schema compiled for this machine

echo "Installed $uuid to $dest"

# the extension used to be called sysmon-graphs@jasen; two copies would fight over the same settings
legacy="$extensions/sysmon-graphs@jasen"
if [ "$uuid" != "sysmon-graphs@jasen" ] && [ -d "$legacy" ]; then
    echo
    echo "Note: the old copy $legacy is still installed."
    echo "Disable and remove it (the settings are kept):"
    echo "  gnome-extensions disable sysmon-graphs@jasen; rm -rf '$legacy'"
fi

echo
echo "Next: log out and back in (Wayland needs this to load new or changed extension code),"
echo "then enable it:  gnome-extensions enable $uuid"
