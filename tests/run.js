// Jasmine runner for gjs.  Usage: gjs -m run.js [spec-file-substring ...]
// (Normally started through tests/run.sh, which prepares the environment.)
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import System from "system";
import {buildWorld, adoptWorld, worldEnv, teardownWorld} from './helpers/world.js';

const here = GLib.path_get_dirname(import.meta.url.replace('file://', ''));
const read = p => new TextDecoder().decode(GLib.file_get_contents(p)[1]);

// ---- bootstrap: GLib reads XDG_* once at start-up, so run the real test process with them already set ----
if (!GLib.getenv('SYSMON_TEST_ROOT')) {
    const root = buildWorld();
    const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.NONE});     // inherits stdin/stdout/stderr
    for (const [k, v] of Object.entries(worldEnv(root))) launcher.setenv(k, v, true);
    const gjs = GLib.find_program_in_path('gjs') || 'gjs';
    let status = 2;
    try {
        const proc = launcher.spawnv([gjs, '-m', `${here}/run.js`, ...ARGV]);
        proc.wait(null);
        status = proc.get_if_exited() ? proc.get_exit_status() : 2;
    } finally { teardownWorld(root); }
    System.exit(status);
}
adoptWorld(GLib.getenv('SYSMON_TEST_ROOT'));

// gjs lacks a few web APIs Jasmine can use
globalThis.queueMicrotask ??= f => Promise.resolve().then(f);
globalThis.addEventListener ??= () => {};          // Jasmine's global error hooks
globalThis.removeEventListener ??= () => {};
globalThis.structuredClone ??= v => JSON.parse(JSON.stringify(v));

// ---- load Jasmine core (the jasmine-core dev dependency, a plain script) ----
const jasminePath = `${here}/../node_modules/jasmine-core/lib/jasmine-core/jasmine.js`;
if (!GLib.file_test(jasminePath, GLib.FileTest.EXISTS)) {
    printerr('jasmine-core is not installed. Run "npm install" in the project folder first.');
    System.exit(2);
}
const mod = {exports: {}};
new Function('module', 'exports', 'global', read(jasminePath))(mod, mod.exports, globalThis);
const jasmineRequire = mod.exports;
const jasmine = jasmineRequire.core(jasmineRequire);
const env = jasmine.getEnv({suppressLoadErrors: true});
Object.assign(globalThis, jasmineRequire.interface(jasmine, env));
globalThis.jasmine = jasmine;
env.configure({random: true, stopOnSpecFailure: false, ...(GLib.getenv('SEED') ? {seed: GLib.getenv('SEED')} : {})});   // SEED=123 reruns an order

// ---- console reporter ----
const out = s => print(s);
const failures = [];
let specs = 0, passed = 0, skipped = 0;
env.addReporter({
    specDone(r) {
        specs++;
        if (r.status === 'passed') { passed++; out(`  ok    ${r.description}`); }
        else if (r.status === 'pending' || r.status === 'excluded') { skipped++; out(`  skip  ${r.description}${r.pendingReason ? ' (' + r.pendingReason + ')' : ''}`); }
        else {
            out(`  FAIL  ${r.description}`);
            failures.push(r);
        }
    },
    suiteStarted(r) { out(`\n${r.fullName}`); },
    jasmineStarted(info) { out(`Jasmine ${jasmine.version} on gjs  (random order, seed ${info.order.seed})`); },
    jasmineDone(r) {
        if (failures.length) {
            out('\n==== FAILURES ====');
            for (const f of failures) {
                out(`\n${f.fullName}`);
                for (const e of f.failedExpectations) out(`    ${e.message}${e.stack ? '\n' + e.stack.split('\n').slice(0, 3).join('\n') : ''}`);
            }
        }
        for (const e of r.failedExpectations || []) out(`\nSuite-level error: ${e.message}`);
        out(`\n${specs} specs, ${failures.length} failures, ${skipped} skipped  (${r.overallStatus})`);
        exitCode = r.overallStatus === 'passed' || r.overallStatus === 'incomplete' && !failures.length ? 0 : 1;
        loop.quit();
    },
});

// ---- find and import the specs ----
const filters = ARGV;
const specDir = Gio.File.new_for_path(`${here}/spec`);
const names = [];
const en = specDir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
for (let i = en.next_file(null); i; i = en.next_file(null))
    if (i.get_name().endsWith('.spec.js') && (!filters.length || filters.some(f => i.get_name().includes(f)))) names.push(i.get_name());
names.sort();
if (!names.length) { print('No spec files matched.'); System.exit(2); }

let exitCode = 1;
const loop = new GLib.MainLoop(null, false);
(async () => {
    for (const n of names) await import(`file://${here}/spec/${n}`);
    await env.execute();
})().catch(e => { print(`Failed to load specs: ${e}\n${e.stack}`); exitCode = 2; loop.quit(); });
loop.run();
System.exit(exitCode);
