// "BIOS graphics mode": reads and changes the firmware's graphics setting on Lenovo laptops through the kernel's
// think-lmi driver (/sys/class/firmware-attributes/thinklmi/attributes/GraphicsDevice).
//
//   Switchable Graphics  the integrated GPU draws the desktop, NVIDIA renders on demand (hybrid)
//   Discrete Graphics    NVIDIA draws the desktop, the integrated GPU stays unused
//   UMA Graphics         the integrated GPU only, NVIDIA is switched off
//
// The value is stored in the BIOS and takes effect after a reboot. Writing needs root, so it goes through
// pkexec (polkit shows the normal password dialog); nothing here ever runs without the user confirming.
// The current value is root-only in sysfs, so the current mode is detected from where the laptop panel is wired.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {readText, listDir, linkBase} from './util.js';

const ATTR = 'GraphicsDevice';
const SAFE = /^[A-Za-z0-9 ()._-]+$/;      // what a mode name may contain (it ends up in a root shell command)

// Where to look, and how to run a command as root. Specs replace these, so a test can never touch the real BIOS.
export const cfg = {
    dir: '/sys/class/firmware-attributes/thinklmi',
    drm: '/sys/class/drm',
    pci: '/sys/bus/pci/devices',
    pkexec: null,                          // null = look it up in PATH
    run: runCommand,                       // (argv) => Promise<exit status>, -1 if it could not start
};

// 'discrete' | 'uma' | 'switchable' | 'other'
export function kind(mode) {
    if (/discrete/i.test(mode)) return 'discrete';
    if (/\buma\b|integrated/i.test(mode)) return 'uma';
    if (/switch|hybrid|optimus/i.test(mode)) return 'switchable';
    return 'other';
}

// null when this machine has no such setting; otherwise
// {modes: [...], detected: mode|null, locked: bool (BIOS admin password set), pendingReboot: bool}
export function info() {
    const possible = readText(`${cfg.dir}/attributes/${ATTR}/possible_values`).trim();
    if (!possible) return null;
    const modes = possible.split(';').map(m => m.trim()).filter(m => m && SAFE.test(m));
    if (!modes.length) return null;
    return {
        modes,
        detected: detect(modes),
        locked: readText(`${cfg.dir}/authentication/Admin/is_enabled`).trim() === '1',
        pendingReboot: readText(`${cfg.dir}/attributes/pending_reboot`).trim() === '1',
    };
}

// Which mode the laptop is in now, from where its built-in panel is connected: to the NVIDIA GPU (discrete),
// to the integrated GPU while NVIDIA is present (switchable), or no NVIDIA GPU at all (UMA).
function detect(modes) {
    const find = k => modes.find(m => kind(m) === k) || null;
    let nvidia = false;
    for (const slot of listDir(cfg.pci)) {
        const base = `${cfg.pci}/${slot}`;
        if (readText(`${base}/class`).trim().startsWith('0x03') && readText(`${base}/vendor`).trim() === '0x10de') nvidia = true;
    }
    if (!nvidia) return find('uma');
    let panelDriver = '';
    for (const c of listDir(cfg.drm).sort()) {
        if (!/^card\d+-(eDP|LVDS|DSI)-\d+$/.test(c)) continue;
        if (readText(`${cfg.drm}/${c}/status`).trim() !== 'connected') continue;
        panelDriver = linkBase(`${cfg.drm}/${c.split('-')[0]}/device/driver`);   // card2-eDP-1 -> card2 -> its PCI device's driver
        break;
    }
    if (panelDriver === 'nvidia') return find('discrete');
    if (panelDriver) return find('switchable');
    return null;
}

// Sets the mode in the BIOS. Resolves to 'ok' | 'cancelled' | 'locked' | 'invalid' | 'no-pkexec' | 'error'.
// The root part is a short fixed script: it checks the value against the BIOS's own list and writes only that.
export async function apply(mode) {
    const i = info();
    if (!i || !i.modes.includes(mode)) return 'invalid';
    if (i.locked) return 'locked';
    const pkexec = cfg.pkexec || GLib.find_program_in_path('pkexec');
    if (!pkexec) return 'no-pkexec';
    const f = GLib.shell_quote(`${cfg.dir}/attributes/${ATTR}`);
    const script = `f=${f}; case ";$(cat "$f/possible_values");" in *";$1;"*) ;; *) exit 2;; esac; printf '%s' "$1" > "$f/current_value"`;
    const status = await cfg.run([pkexec, '/bin/sh', '-c', script, 'sysmon-bios', mode]);
    if (status === 0) return 'ok';
    if (status === 126 || status === 127) return 'cancelled';      // pkexec: dialog dismissed / not authorized
    if (status === 2) return 'invalid';
    return 'error';
}

function runCommand(argv) {
    return new Promise(resolve => {
        try {
            const proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
            proc.wait_async(null, (p, res) => {
                try {
                    p.wait_finish(res);
                    resolve(p.get_if_exited() ? p.get_exit_status() : -1);
                } catch (e) { resolve(-1); }
            });
        } catch (e) { resolve(-1); }
    });
}
