# SysMon Graphs: tests

A [Jasmine](https://jasmine.github.io/) suite that runs under plain **gjs**, the same JavaScript runtime GNOME Shell
uses. Jasmine comes from the `jasmine-core` dev dependency in `package.json` (run `npm install` once in the project folder).

```
npm test                 # everything (same as tests/run.sh)
npm test -- perm gpu     # only spec files whose name contains "perm" or "gpu"
SEED=12345 npm test      # repeat one particular random order (the seed is printed at the top of each run)
```

Needs `npm`, `gjs` and `glib-compile-schemas` (both come with a normal GNOME install). The settings-window specs also need a
display; `tests/run.sh` starts a virtual one with `xvfb-run` when your session has none (`sudo apt install xvfb`), and
skips those specs if neither is available. Exit status is 0 when everything passed, so it works in scripts and CI.

## What is tested

| Spec file | What it covers |
|---|---|
| `stats.spec.js` | the `/proc` and `/sys` parsers, number formatting, `nvidia-smi` output, PCI names |
| `chart.spec.js` | the Cairo chart drawing (edge cases, colour and data actually change the image) |
| `gpu.spec.js` | GPU sampling against a fake PCI tree and a fake `nvidia-smi`: AMD, NVIDIA in Performance and Hybrid mode, the rule that a sleeping card is never woken, back-off while idle, missing drivers |
| `sampler.spec.js` | the real sampler on this machine's `/proc`: a complete snapshot with sane ranges |
| `perm.spec.js` | the "Always" launcher edits: backup, byte-exact restore, created copies, browser flags, `DBusActivatable`, entries changed by someone else |
| `extension-panel.spec.js` | the top bar items: order, show/hide, widths and text, the two GPU items, threshold alerts |
| `extension-popover.spec.js` | hover, click-to-pin, closing, one popover at a time |
| `extension-apps.spec.js` | the "Apps on NVIDIA" list, launching (generic apps, browsers, Firefox), the running-app warning, the Always toggle |
| `prefs.spec.js` | the real settings window: per-item rows, item order and switches, alert rows, values written to settings |
| `project.spec.js` | `metadata.json` (uuid, schema, imports), `package.json`, `.gitignore`, and the install script run against a temporary folder |

## How it works

* `run.js` is the Jasmine runner for gjs (jasmine-core's own node runner cannot run gjs code, so only the core package is used). GLib reads `XDG_DATA_DIRS` only once at start-up, so `run.js` builds a temporary
  "world" (compiled schema, fake launcher entries, fake launcher programs) and re-starts itself inside it. The world is
  deleted afterwards. Your real settings, launcher entries and home folder are never touched.
* `helpers/gnome-stubs.js` stands in for GNOME Shell (panel, buttons, labels, popovers). `helpers/load.js` loads the
  **real** `src/extension.js` / `src/prefs.js` with only their GNOME-only imports redirected to the stubs, so the code under test is
  exactly the code that ships.
* Settings use GSettings' in-memory backend and every test starts from default settings.

## What this cannot show

The stubs record what the extension asks GNOME Shell to do; they cannot show how it looks or feels. Drawing on the real
panel, real pointer handling, real app start-up and your actual GPUs still need a manual check in a real session.
Writing a spec for a new feature: copy the closest `describe` in `extension-panel.spec.js` and use `createExtension()`
from `helpers/ext-harness.js`.
