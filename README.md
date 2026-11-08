# SysMon Graphs

Smooth CPU / RAM / CPU-temperature / network / disk graphs in the GNOME top bar.
Hover any graph for a detail popover (per-core CPU, top processes, sensors, interfaces, filesystems).

Tested API-wise against GNOME Shell 46 (Ubuntu 24.04); metadata also lists 45, 47, 48.

## Project layout
    src/        the extension itself (this folder is what gets installed)
    tests/      Jasmine specs and the gjs runner (see tests/README.md)
    scripts/    install-extension.sh
    package.json    scripts: test, install-extension; dev dependency: jasmine-core

## Install
    npm run install-extension
Copies `src/` to `~/.local/share/gnome-shell/extensions/sysmon-graphs@jazastry/` (the folder name is the `uuid` in
`src/metadata.json`) and compiles the settings schema there. Then log out and back in (Wayland needs this to load
new or changed extension code) and enable it:

    gnome-extensions enable sysmon-graphs@jazastry

The extension used to be called `sysmon-graphs@jasen`. If that copy is still installed, the script says so:
disable and remove it (`gnome-extensions disable sysmon-graphs@jasen; rm -rf ~/.local/share/gnome-shell/extensions/sysmon-graphs@jasen`),
otherwise both would fight over the same settings. The settings themselves are kept.

Without npm: `cp -r src ~/.local/share/gnome-shell/extensions/sysmon-graphs@jazastry` and run `glib-compile-schemas` on its `schemas/` folder.

## Develop and test
    npm install          # once: installs jasmine-core
    npm test             # all specs;  npm test -- perm gpu  runs only the matching spec files
    npm run install-extension

## Settings
Open the Extensions app -> SysMon Graphs -> settings: font size / bold / family, graph height,
seconds of history, gap between graph and text, show/hide switches for CPU, RAM, temperature, network and disk, the order of all items
(move left / move right, with Reset),
and per item: graph width, colour(s), text size and text box width
(width 0 = default; the default is 44 px, or the width you had set before the width became per item).
Changes apply immediately.

## Debug
    journalctl -f -o cat /usr/bin/gnome-shell

## GPU
* AMD: read from sysfs (load + VRAM + GTT).
* NVIDIA: needs `nvidia-smi` (package nvidia-utils-NNN). Performance mode is polled every 2 s. In Hybrid
  mode a sleeping card is never polled (so it can stay powered down) and an idle awake card is polled every 15 s.
* Each GPU has its own top bar item and popover: **NVIDIA GPU** and **Integrated GPU**. Each graph shows the
  load as a filled area and the memory use (percent of that GPU's memory) as a lighter line; the text shows
  load and used memory. The apps list lives in the NVIDIA popover.
* Settings: show/hide the GPU items, choose which are shown (Auto = one item per GPU in the machine /
  NVIDIA only / integrated only), and set graph width, color, text size and text box width for each GPU item.

## Popovers
Hover to peek. Click a graph to pin its popover open; click it again to close it.

## Apps on the dedicated GPU
Open the GPU popover: the apps you added are listed there. Click one to start it with NVIDIA PRIME
render-offload variables, click the x to remove it, or click "+ Add app…" to pick another one.
Because the desktop is drawn by the integrated GPU, browsers are started through XWayland so the NVIDIA GPU can
render them: Chromium-based browsers get `--ozone-platform=x11` and Firefox gets `MOZ_ENABLE_WAYLAND=0`;
GTK/Qt apps only get the offload variables (GTK4 verified on native Wayland). If the app is already running the popover shows a
warning instead of launching (a new window would join the old process on the wrong GPU). Quit it completely
first; browsers can keep a background process (for Edge: `pkill -x msedge`).

### "Always" toggle
Each app in the GPU popover has an **Always** button. When it is on, the app also uses NVIDIA when started from
the Dock or app grid. This works by editing the app's launcher entry in `~/.local/share/applications`:
an app that already has a personal entry (for example kitty) is backed up as `<name>.desktop.sysmon-backup`
and restored byte for byte when you switch Always off; an app without one gets a tagged copy that is deleted
when you switch it off. Removing the app from the list also switches Always off. Entries changed by this
extension contain the key `X-SysMon-NVIDIA`. If you uninstall the extension while Always is on, remove them with:

    grep -l X-SysMon-NVIDIA ~/.local/share/applications/*.desktop

(entries marked `=created` can simply be deleted; for `=modified` ones, rename the matching `.sysmon-backup`
file back to `.desktop`). Updating an app may overwrite its entry and thereby switch Always off.
A terminal that runs on NVIDIA passes that to every program started from it.

### Threshold alerts
Every graph can change color while its current value is above a threshold. In the settings, each item has an
"alert" row per graph (CPU load, RAM used, temperature, disk activity, and for the two-graph items both graphs:
GPU load and memory, network download and upload). Switch it on, set the threshold and the alert color.
Thresholds are in the units of the graph: percent for CPU, RAM and GPU load/memory, degrees C for temperature,
and MB/s (as shown in the top bar) for network and disk activity. The latest value decides the color, so the whole
graph returns to its normal color as soon as the value drops back to the threshold or below.
