// Creates a fresh, enabled extension on top of the stubs, and a few tiny helpers to poke at it.
import Gio from 'gi://Gio';
import {world} from './world.js';
import {loadExtension, installShellGlobals} from './load.js';
import {resetPanel, rightBox, runningApps} from './gnome-stubs.js';

// the memory settings backend is shared inside one process: put every key back to its default
export function resetAllSettings() {
    const src = Gio.SettingsSchemaSource.new_from_directory(world.schemas, Gio.SettingsSchemaSource.get_default(), false);
    const schema = src.lookup('org.gnome.shell.extensions.sysmon-graphs', true);
    const s = new Gio.Settings({settings_schema: schema});
    for (const k of schema.list_keys()) s.reset(k);
}

export async function createExtension() {
    installShellGlobals();
    resetPanel();
    runningApps.clear();
    resetAllSettings();
    const Ext = await loadExtension();
    const ext = new Ext();
    ext.enable();
    return ext;
}

export const item = (ext, id) => ext.items.find(i => i.id === id);
export const panelOrder = ext => rightBox.children.map(c => ext.items.find(i => i.button.container === c).id);

// ---- poking at the fake actors ----
export const fire = (obj, sig, ...args) => (obj._signals[sig] || []).forEach(f => f(obj, ...args));
export const hover = (it, on) => { it.button.hover = on; fire(it.button, 'notify::hover'); };
export const click = (it, button = 1) => fire(it.button, 'button-press-event', {get_button: () => button});
export const clickButton = b => (b._signals['clicked'] || []).forEach(f => f(b));      // St.Button 'clicked'
export function find(root, pred, out = []) {
    if (pred(root)) out.push(root);
    for (const k of [...(root._kids || []), ...(root.child ? [root.child] : [])]) find(k, pred, out);
    return out;
}
export const byClass = (root, cls) => find(root, n => typeof n.style_class === 'string' && n.style_class.split(' ').includes(cls));
export const labelsIn = root => find(root, n => typeof n.text === 'string' && n.text !== '').map(n => n.text);

// ---- fake GPU readings ----
export const NV = (o = {}) => ({kind: 'nvidia', slot: 'nv', driver: 'nvidia', name: 'NVIDIA GeForce RTX 5060', state: 'active', load: 40, memUsed: 2 * 2 ** 30, memTotal: 8 * 2 ** 30, temp: 55, power: 20, extra: {}, ...o});
export const AMD = (o = {}) => ({kind: 'amd', slot: 'amd', driver: 'amdgpu', name: 'AMD Radeon 610M', state: 'active', load: 10, memUsed: 256 * 2 ** 20, memTotal: 512 * 2 ** 20, temp: 48, power: null, extra: {gttUsed: 2 ** 30, gttTotal: 8 * 2 ** 30}, ...o});

// make the extension's GPU sampler return whatever `current.gpus` holds; call ext._sample() to take a reading
export function fakeGpus(ext, initial = [NV(), AMD()]) {
    const state = {gpus: initial};
    ext.sampler.gpu.poll = () => state.gpus;
    return state;
}
export const MB = 1048576;
export const setHist = (h, v) => { h.v = new Array(5).fill(v); };
