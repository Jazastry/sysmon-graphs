#!/usr/bin/env bash
# Runs the whole test suite (normally through `npm test`) (or only the spec files whose name contains one of the arguments).
#   ./run.sh                 everything
#   ./run.sh perm gpu        only perm.spec.js and gpu.spec.js
#   SEED=12345 ./run.sh      repeat a particular random order
# Exit status: 0 = all passed, 1 = a spec failed, 2 = the suite could not start.
set -u
cd "$(dirname "$0")"

[ -f ../node_modules/jasmine-core/lib/jasmine-core/jasmine.js ] || { echo 'jasmine-core is missing: run "npm install" in the project folder first'; exit 2; }

for tool in gjs glib-compile-schemas; do
    command -v "$tool" >/dev/null 2>&1 || { echo "missing: $tool (Ubuntu: sudo apt install gjs libglib2.0-bin)"; exit 2; }
done

# The settings-window specs need a display. Use a virtual one if the session has none.
if [ -z "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ]; then
    if command -v xvfb-run >/dev/null 2>&1; then
        exec xvfb-run -a gjs -m run.js "$@"
    fi
    echo "note: no display and no xvfb-run, so the settings-window specs will be skipped (Ubuntu: sudo apt install xvfb)" >&2
fi
exec gjs -m run.js "$@"
