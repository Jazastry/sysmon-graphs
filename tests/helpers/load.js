// Loads extension.js / prefs.js with GNOME-only imports pointed at the stubs and relative imports pointed
// at the real extension files, so the code under test is the shipped code, unmodified.
import Gio from 'gi://Gio';
import {EXT_DIR, world, readFile, writeFile, TESTS_DIR} from './world.js';

const STUBS = `file://${TESTS_DIR}/helpers/gnome-stubs.js`;
const cache = new Map();

function rewrite(src) {
    return src
        .replace(/^import (\w+) from 'gi:\/\/(Clutter|Shell|St)';$/gm, (m, v, n) => `import {${n} as ${v}} from '${STUBS}';`)
        .replace(/^import \{Extension\} from 'resource:\/\/\/org\/gnome\/shell\/extensions\/extension\.js';$/m, `import {Extension} from '${STUBS}';`)
        .replace(/^import \* as (Main|PanelMenu) from 'resource:\/\/\/org\/gnome\/shell\/ui\/\w+\.js';$/gm, (m, v) => `import {${v}} from '${STUBS}';`)
        .replace(/^import \{ExtensionPreferences\} from 'resource:\/\/\/org\/gnome\/Shell\/Extensions\/js\/extensions\/prefs\.js';$/m, `import {ExtensionPreferences} from '${STUBS}';`)
        .replace(/from '\.\/(\w+\.js)'/g, (m, f) => `from 'file://${EXT_DIR}/${f}'`);
}

async function load(file) {
    if (!cache.has(file)) {
        const out = `${world.root}/loaded/${file}`;
        writeFile(out, rewrite(readFile(`${EXT_DIR}/${file}`)));
        cache.set(file, import(`file://${out}`));
    }
    return cache.get(file);
}

export const loadExtension = async () => (await load('extension.js')).default;
export const loadPrefs = async () => (await load('prefs.js')).default;
// pure modules need no rewriting
export const loadModule = name => import(`file://${EXT_DIR}/${name}`);

// what extension.js expects from the shell at runtime
export function installShellGlobals() {
    globalThis.global = {create_app_launch_context: () => new Gio.AppLaunchContext()};
}
