// The "world" the specs run in: temporary folders, compiled schemas, fake apps and a fake nvidia-smi.
// Everything lives under one temp directory that run.js creates before any spec is loaded and removes at the end.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

export const TESTS_DIR = GLib.path_get_dirname(GLib.path_get_dirname(import.meta.url.replace('file://', '')));
export const EXT_DIR = GLib.getenv('SYSMON_EXT_DIR') || GLib.build_filenamev([TESTS_DIR, '..', 'src']);

export const world = {};      // filled by setupWorld()

const enc = new TextEncoder();
const dec = new TextDecoder();

export function writeFile(path, text, mode = null) {
    GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o755);
    GLib.file_set_contents(path, enc.encode(text));
    if (mode !== null) GLib.chmod(path, mode);
}

export function readFile(path) {
    try { return dec.decode(GLib.file_get_contents(path)[1]); } catch (e) { return null; }
}

export function exists(path) { return GLib.file_test(path, GLib.FileTest.EXISTS); }

export function sleep(ms) {
    return new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => { r(); return GLib.SOURCE_REMOVE; }));
}

// resolves true as soon as cond() is true, false after timeoutMs
export async function waitFor(cond, timeoutMs = 3000, stepMs = 25) {
    const end = GLib.get_monotonic_time() / 1000 + timeoutMs;
    while (GLib.get_monotonic_time() / 1000 < end) {
        if (cond()) return true;
        await sleep(stepMs);
    }
    return !!cond();
}

export function rmrf(path) {
    try { GLib.spawn_command_line_sync(`rm -rf '${path}'`); } catch (e) { /* ignore */ }
}

export function worldPaths(root) {
    return {
        root,
        apps: `${root}/share/applications`,        // "system" launcher entries
        dataHome: `${root}/home-data`,               // the user's ~/.local/share
        userApps: `${root}/home-data/applications`,
        bin: `${root}/bin`,
        out: `${root}/out`,                          // fake launchers write what they received here
        schemas: `${root}/schemas`,
    };
}

// GLib reads these once at start-up, so they must be in the environment *before* gjs starts: run.js re-launches
// itself with this environment when it was started without it.
export function worldEnv(root) {
    const p = worldPaths(root);
    return {
        SYSMON_TEST_ROOT: root,
        XDG_DATA_DIRS: `${root}/share:/usr/share`,
        XDG_DATA_HOME: p.dataHome,
        GSETTINGS_BACKEND: 'memory',
    };
}

// create the temp tree (schemas, fake apps); returns the root
export function buildWorld() {
    const root = GLib.dir_make_tmp('sysmon-tests-XXXXXX');
    const p = worldPaths(root);
    for (const d of [p.apps, p.userApps, p.bin, p.out, p.schemas]) GLib.mkdir_with_parents(d, 0o755);

    // compiled settings schema
    GLib.spawn_command_line_sync(`cp '${EXT_DIR}'/schemas/org.gnome.shell.extensions.sysmon-graphs.gschema.xml '${p.schemas}/'`);
    const [ok, , err] = GLib.spawn_command_line_sync(`glib-compile-schemas --strict '${p.schemas}'`);
    if (!ok) throw new Error(`glib-compile-schemas failed: ${dec.decode(err)}`);

    // fake launchers: they record their arguments and the environment variables that matter
    const script = name => `#!/bin/sh\n{ echo "ARGS: $*"; env | grep -E '^(__NV_PRIME|__GLX_VENDOR|__VK_LAYER|__EGL_VENDOR|GDK_BACKEND|QT_QPA|MOZ_ENABLE)'; } > '${p.out}/${name}.tmp' && mv '${p.out}/${name}.tmp' '${p.out}/${name}.txt'\n`;   // atomic: readers never see half a file
    for (const n of ['microsoft-edge-stable', 'firefox', 'sysmon-test-app']) writeFile(`${p.bin}/${n}`, script(n), 0o755);
    const entry = (name, exec, extra = '') => `[Desktop Entry]\nType=Application\nName=${name}\nExec=${exec}\nIcon=utilities-terminal\n${extra}`;
    writeFile(`${p.apps}/fake-edge.desktop`, entry('Fake Edge', `${p.bin}/microsoft-edge-stable %U`));
    writeFile(`${p.apps}/fake-firefox.desktop`, entry('Fake Firefox', `${p.bin}/firefox --new-window %u`));
    writeFile(`${p.apps}/fake-app.desktop`, entry('Fake App', `${p.bin}/sysmon-test-app`));
    writeFile(`${p.apps}/fake-dbus.desktop`, entry('Fake DBus', '/bin/true', 'DBusActivatable=true\n'));
    writeFile(`${p.apps}/fake-term.desktop`, entry('Fake Term', '/bin/true', 'Categories=System;TerminalEmulator;\n'));
    return root;
}

// in the (re-launched) test process: adopt the tree that the parent built
export function adoptWorld(root) { Object.assign(world, worldPaths(root)); return world; }

export function teardownWorld(root) { rmrf(root || world.root); }
