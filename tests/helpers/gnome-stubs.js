// Minimal stand-ins for the GNOME Shell / Clutter / St pieces the extension uses. They record what the
// extension does (children, signals, sizes, styles) so specs can assert on it without a running shell.
import Gio from 'gi://Gio';
import {world} from './world.js';

function fake(cls) {
    return class extends cls {
        constructor(props = {}) {
            super();
            Object.assign(this, props);
            this._kids = []; this._signals = {};
            this.hover = false; this.visible = props.visible ?? true;
            // any other method an actor is asked for becomes a harmless no-op
            return new Proxy(this, {get: (t, k, r) => (k in t) ? Reflect.get(t, k, r) : (typeof k === 'string' && !k.startsWith('_') ? () => undefined : undefined)});
        }
        add_child(c) { this._kids.push(c); }
        set_child(c) { this._kids = [c]; this.child = c; }
        destroy_all_children() { this._kids = []; }
        connect(sig, fn) { (this._signals[sig] ||= []).push(fn); return 1; }
        get_transformed_position() { return [100, 0]; }
        get_preferred_width() { return [300, 320]; }
        get_surface_size() { return [this._w || 44, this._h || 18]; }
        set_size(w, h) { this._w = w; this._h = h; }
        set_style(s) { this.style = s; }
        set_width(w) { this.width = w; }
        get_context() { return this._cr; }
    };
}
const A = fake(Object);

export const Clutter = {ActorAlign: {CENTER: 1}, AnimationMode: {EASE_OUT_QUAD: 1}, BUTTON_PRIMARY: 1, EVENT_PROPAGATE: false, EVENT_STOP: true};
export const St = {
    ScrollView: A, PolicyType: {NEVER: 1, AUTOMATIC: 2}, Button: A, Icon: A, BoxLayout: A, DrawingArea: A, Widget: A,
    Label: class extends A { constructor(p) { super(p); this.clutter_text = {set_markup(m) { this.markup = m; }}; } },
};

// the right-hand box of the top panel, in which the extension orders its buttons
export const rightBox = new A();
rightBox.children = [];
rightBox.get_child_at_index = i => rightBox.children[i];
rightBox.set_child_at_index = (c, i) => { rightBox.children = rightBox.children.filter(x => x !== c); rightBox.children.splice(i, 0, c); };
export const resetPanel = () => { rightBox.children = []; };

export const PanelMenu = {Button: class extends A {
    constructor() { super(); this.container = new A(); this.container.get_parent = () => rightBox; }
}};
export const Main = {
    panel: {height: 32, get_transformed_position: () => [0, 0],
        addToStatusArea(role, ind, pos) { rightBox.children.splice(pos, 0, ind.container); }},
    layoutManager: {addTopChrome() {}, removeChrome() {}, primaryMonitor: {x: 0, width: 1920}},
};

function schemaSettings() {
    const src = Gio.SettingsSchemaSource.new_from_directory(world.schemas, Gio.SettingsSchemaSource.get_default(), false);
    return new Gio.Settings({settings_schema: src.lookup('org.gnome.shell.extensions.sysmon-graphs', true)});
}
export class Extension {
    get uuid() { return 'sysmon-graphs@jazastry'; }
    getSettings() { return schemaSettings(); }
}
export class ExtensionPreferences {
    getSettings() { return schemaSettings(); }
}

// which apps the fake Shell.AppSystem reports as running
export const runningApps = new Set();
export const Shell = {
    AppState: {STOPPED: 0, RUNNING: 2},
    AppSystem: {get_default() { return {lookup_app: id => runningApps.has(id) ? {get_state: () => 2} : null}; }},
};
