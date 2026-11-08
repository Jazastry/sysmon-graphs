// "Always on NVIDIA": makes an app start on the dedicated GPU from every launcher (Dock, app grid) by
// editing its launcher entry in ~/.local/share/applications, and puts everything back when switched off.
//
//  * app has no personal entry -> a tagged copy of the system entry is created; switching off deletes it
//  * app has a personal entry   -> it is saved as <id>.sysmon-backup (GNOME ignores that name), the entry is
//                                  edited in place; switching off restores the saved bytes exactly
// Every entry we touch carries the key X-SysMon-NVIDIA, and only entries with that key are ever changed back.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export const MARKER = 'X-SysMon-NVIDIA';
const BACKUP = '.sysmon-backup';
const CHROMIUM_RE = /^(microsoft-edge[\w-]*|msedge|google-chrome[\w-]*|chrome|chromium(-browser)?|brave(-browser)?|vivaldi[\w-]*|opera)$/;

// Environment that makes an app render on the NVIDIA GPU (PRIME render offload) for GL, Vulkan and EGL.
export function nvidiaOffloadEnv() {
    const env = {
        '__NV_PRIME_RENDER_OFFLOAD': '1',
        '__GLX_VENDOR_LIBRARY_NAME': 'nvidia',
        '__VK_LAYER_NV_optimus': 'NVIDIA_only',
    };
    const egl = '/usr/share/glvnd/egl_vendor.d/10_nvidia.json';
    if (GLib.file_test(egl, GLib.FileTest.EXISTS)) env['__EGL_VENDOR_LIBRARY_FILENAMES'] = egl;   // only if present
    return env;
}

// 'chromium' | 'firefox' | 'other', from the words of a launch command
export function classify(argv) {
    const words = argv.map(a => GLib.path_get_basename(a));
    if (words.some(w => CHROMIUM_RE.test(w))) return 'chromium';
    if (words.some(w => /^firefox/.test(w))) return 'firefox';
    return 'other';
}

export function userAppsDir() {
    return GLib.build_filenamev([GLib.get_user_data_dir(), 'applications']);
}

const dec = new TextDecoder();
const enc = new TextEncoder();
const exists = p => GLib.file_test(p, GLib.FileTest.EXISTS);
const readBytes = p => GLib.file_get_contents(p)[1];
const readText = p => dec.decode(readBytes(p));
const entryPath = (id, dir) => GLib.build_filenamev([dir, id]);

// Rewrites one Exec= value: NVIDIA variables in front, the XWayland flag for Chromium-based browsers
function transformExec(value, baseEnv) {
    let argv = [];
    try { argv = GLib.shell_parse_argv(value)[1] || []; } catch (e) { argv = []; }
    const kind = classify(argv);
    const env = {...baseEnv};
    if (kind === 'firefox') env['MOZ_ENABLE_WAYLAND'] = '0';
    let rest = value;
    if (kind === 'chromium') {
        // insert the flag right after the program (and after a leading "env VAR=x" if there is one)
        const m = value.match(/^(\s*(?:env\s+(?:[A-Za-z_]\w*=\S*\s+)*)?(?:"(?:[^"\\]|\\.)*"|\S+))([\s\S]*)$/);
        if (m) rest = `${m[1]} --ozone-platform=x11${m[2]}`;
    }
    const prefix = Object.entries(env).map(([k, v]) => `${k}=${v}`).join(' ');
    return `env ${prefix} ${rest}`;
}

function transform(text, mode) {
    const base = nvidiaOffloadEnv();
    const out = [];
    let marked = false;
    for (const line of text.split('\n')) {
        if (line.startsWith(`${MARKER}=`)) continue;               // never stack markers
        let l = line;
        if (/^Exec=/.test(l)) l = `Exec=${transformExec(l.slice(5), base)}`;
        else if (/^DBusActivatable\s*=\s*true/i.test(l)) l = 'DBusActivatable=false';   // D-Bus start would skip our Exec
        out.push(l);
        if (!marked && l.trim() === '[Desktop Entry]') { out.push(`${MARKER}=${mode}`); marked = true; }
    }
    return out.join('\n');
}

// the app's entry in the system-wide data dirs (/usr/share/applications, ...), never the user's own folder
function systemEntry(id) {
    for (const d of GLib.get_system_data_dirs()) {
        const p = GLib.build_filenamev([d, 'applications', id]);
        if (exists(p)) return p;
    }
    return null;
}

// is "Always on NVIDIA" switched on for this app?
export function isPermanent(id, dir = userAppsDir()) {
    const p = entryPath(id, dir);
    try { return exists(p) && new RegExp(`^${MARKER}=`, 'm').test(readText(p)); } catch (e) { return false; }
}

// -> 'on' | 'error'
export function enable(info, dir = userAppsDir()) {
    try {
        const id = info.get_id();
        if (!id) return 'error';
        const target = entryPath(id, dir);
        GLib.mkdir_with_parents(dir, 0o755);
        let src, mode;
        if (exists(target)) {
            const cur = readBytes(target);
            if (new RegExp(`^${MARKER}=`, 'm').test(dec.decode(cur))) return 'on';   // already ours
            GLib.file_set_contents(target + BACKUP, cur);                            // exact copy of the original
            src = dec.decode(cur);
            mode = 'modified';
        } else {
            // normally the system entry the app info points at; but right after an Always on/off the shell may still
            // hand out a stale info (pointing at a copy we just deleted, or at an already edited one): then start
            // from the real system entry instead
            const f = info.get_filename();
            let text = f && exists(f) ? readText(f) : null;
            if (text === null || new RegExp(`^${MARKER}=`, 'm').test(text)) {
                const sys = systemEntry(id);
                text = sys ? readText(sys) : null;
            }
            if (text === null) return 'error';
            src = text;
            mode = 'created';
        }
        GLib.file_set_contents(target, enc.encode(transform(src, mode)));
        return 'on';
    } catch (e) {
        logError(e, 'SysMon: could not switch "always on NVIDIA" on');
        return 'error';
    }
}

// -> 'off' | 'foreign' (entry was replaced meanwhile, left alone) | 'no-backup' (could not restore) | 'error'
export function disable(id, dir = userAppsDir()) {
    try {
        const target = entryPath(id, dir);
        const backup = target + BACKUP;
        if (!exists(target)) { if (exists(backup)) GLib.unlink(backup); return 'off'; }
        const m = readText(target).match(new RegExp(`^${MARKER}=(\\w+)`, 'm'));
        if (!m) {                                                  // e.g. the app's own updater rewrote it
            if (exists(backup)) GLib.unlink(backup);
            return 'foreign';
        }
        if (m[1] === 'created') { GLib.unlink(target); return 'off'; }
        if (exists(backup)) {
            GLib.file_set_contents(target, readBytes(backup));
            GLib.unlink(backup);
            return 'off';
        }
        return 'no-backup';
    } catch (e) {
        logError(e, 'SysMon: could not switch "always on NVIDIA" off');
        return 'error';
    }
}
