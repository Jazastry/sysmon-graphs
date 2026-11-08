// SysMon Graphs - smooth CPU / RAM / temperature / network / disk graphs in the top bar,
// each with a hover popover. GNOME Shell 45+ (ESM) extension.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import {drawChart, lighten} from './chart.js';
import * as Perm from './perm.js';
import {Sampler} from './sampler.js';
import * as S from './stats.js';

// Apps that must be started differently to render on NVIDIA while the desktop (Wayland) is drawn by the
// integrated GPU: native Wayland windows cannot be fed by the NVIDIA GPU here, XWayland windows can.
const FIELD_CODE_RE = /^%[fFuUdDnNickvm]$/;

function launchPlan(info) {
    let argv = [];
    try { argv = GLib.shell_parse_argv(info.get_commandline() || '')[1] || []; } catch (e) { argv = []; }
    const env = Perm.nvidiaOffloadEnv();
    const kind = Perm.classify(argv);
    let extra = [];
    if (kind === 'chromium') extra = ['--ozone-platform=x11'];     // Chromium-based browsers
    else if (kind === 'firefox') env['MOZ_ENABLE_WAYLAND'] = '0';  // Firefox
    // GTK/Qt apps: offload variables only (tested on GTK4)
    const cmd = extra.length
        ? [...argv.filter(a => !FIELD_CODE_RE.test(a)), ...extra].map(a => GLib.shell_quote(a)).join(' ')
        : null;
    return {env, cmd};
}


// ---- tweakables ----------------------------------------------------------------------
// Top bar font, graph size and history length are now set in the Extensions app (preferences).
const BIG_W = 300;           // popover chart size
const BIG_H = 72;
const BIG_POINTS = 60;       // seconds of history shown in the popover chart
const HISTORY = BIG_POINTS + 3;
const SAMPLE_SEC = 1;        // sampling interval
const ANIM_MS = 100;         // chart scroll refresh (smooth sliding between samples)

const COLORS = {
    cpu: '#2ec4b6',   // teal
    ram: '#b388ff',   // purple
    temp: '#ff9f43',  // orange
    down: '#4cd964',  // green
    up: '#4aa3ff',    // blue
    disk: '#ffd93d',  // yellow
    gpu: '#ff6bb5',   // pink
    gpumem: '#ffd6ea',// light pink (GPU memory line)
};
// Default colours (the colours themselves are chosen in the Extensions app); keys match colour-<key> settings.
// graph layers that can switch color above a threshold: key -> unit ('rate' thresholds are MB/s, graphs hold bytes/s)
const ALERT_KEYS = {
    'cpu': 'pct', 'ram': 'pct', 'gpu-load': 'pct', 'gpu-mem': 'pct', 'igpu-load': 'pct', 'igpu-mem': 'pct',
    'temp': 'temp', 'net-down': 'rate', 'net-up': 'rate', 'disk': 'rate',
};
const TOGGLE_IDS = ['cpu', 'ram', 'temp', 'net', 'disk'];   // GPU items are shown or hidden by the GPU settings

const DEFAULT_COLORS = {
    cpu: COLORS.cpu, ram: COLORS.ram, gpu: COLORS.gpu, temp: COLORS.temp,
    net: COLORS.down, 'net-up': COLORS.up, disk: COLORS.disk, 'gpu-igpu': '#5ec8ff',
};
// ---------------------------------------------------------------------------------------

const CENTER = Clutter.ActorAlign.CENTER;

class History {
    constructor() { this.v = []; }
    push(x) {
        if (!this.v.length) this.v = new Array(HISTORY).fill(x);
        this.v.push(x);
        if (this.v.length > HISTORY) this.v.shift();
    }
    get max() { return this.v.length ? Math.max(...this.v) : 0; }
}

// ---- small widget helpers ----------------------------------------------------------------
function mkLabel(text, cls, extra = {}) {
    return new St.Label({text, style_class: cls, y_align: CENTER, ...extra});
}

function listRow(left, right, color = null) {
    const row = new St.BoxLayout({style_class: 'sysmon-kv'});
    row.add_child(mkLabel(left, 'sysmon-key', {x_expand: true}));
    const r = mkLabel(right, 'sysmon-val');
    if (color) r.set_style(`color: ${color};`);
    row.add_child(r);
    return row;
}

class KV {
    constructor(key) {
        this.actor = new St.BoxLayout({style_class: 'sysmon-kv'});
        this.actor.add_child(mkLabel(key, 'sysmon-key', {x_expand: true}));
        this.val = mkLabel('-', 'sysmon-val');
        this.actor.add_child(this.val);
    }
    set(text) { this.val.text = text; }
}

class Bar {
    constructor(color, width) {
        this.width = width;
        this.actor = new St.BoxLayout({style_class: 'sysmon-bar-track', width, y_align: CENTER});
        this.fill = new St.Widget({style_class: 'sysmon-bar-fill'});
        this.setColor(color);
        this.actor.add_child(this.fill);
        this.set(0);
    }
    setColor(color) { this.fill.set_style(`background-color: ${color};`); }
    set(frac) { this.fill.set_width(Math.round(Math.max(0, Math.min(1, frac)) * this.width)); }
}

const DEFAULT_ORDER = ['cpu', 'ram', 'gpu', 'igpu', 'temp', 'net', 'disk'];
// the saved order, repaired: unknown ids and repeats dropped, missing items appended in the default order
function normalizeOrder(list) {
    const out = [];
    for (const id of [...list, ...DEFAULT_ORDER])
        if (DEFAULT_ORDER.includes(id) && !out.includes(id)) out.push(id);
    return out;
}

const pct = v => `${Math.round(v)}%`;

// ---- one metric: panel chart + value + hover popover -----------------------------------
class Item {
    constructor(ext, id, color, baseWidth, small = false, opts = {}) {
        Object.assign(this, opts);    // e.g. role / colorKey: needed before buildBody() runs below
        this.ext = ext;
        this.id = id;
        this.color = color;
        this.baseWidth = baseWidth;   // value label width at the reference font size
        this.small = small;           // two-line label (network): uses a smaller font
        this.needsProcs = false;
        this._shown = false;
        this._pinned = false;     // opened by a click: stays open until clicked again
        this._showId = 0;
        this._hideId = 0;

        // panel button
        this.button = new PanelMenu.Button(0.5, `SysMon ${id}`, true);
        this.button.style = '-natural-hpadding: 4px; -minimum-hpadding: 4px;';
        const box = this.box = new St.BoxLayout({style_class: 'sysmon-box', y_align: CENTER});
        this.chart = new St.DrawingArea({style_class: 'sysmon-chart', y_align: CENTER});
        this.chart.connect('repaint', area => this._paint(area, false));
        this.value = new St.Label({text: '--', style_class: 'sysmon-value', y_align: CENTER});
        box.add_child(this.chart);
        box.add_child(this.value);
        this.button.add_child(box);

        // popover (plain actor in the top chrome: hover only, no modal grab)
        this.pop = new St.BoxLayout({
            vertical: true, style_class: 'sysmon-popover',
            reactive: true, track_hover: true, visible: false, opacity: 0,
        });
        Main.layoutManager.addTopChrome(this.pop);

        const head = new St.BoxLayout({style_class: 'sysmon-head'});
        const titles = new St.BoxLayout({vertical: true, x_expand: true, y_align: CENTER});
        this.title = mkLabel(this.titleText(), 'sysmon-title');
        this.title.set_style(`color: ${color};`);
        this.subtitle = mkLabel('', 'sysmon-subtitle');
        titles.add_child(this.title);
        titles.add_child(this.subtitle);
        this.bigValue = mkLabel('--', 'sysmon-bigvalue');
        head.add_child(titles);
        head.add_child(this.bigValue);
        this.pop.add_child(head);

        this.big = new St.DrawingArea({style_class: 'sysmon-bigchart', width: BIG_W, height: BIG_H});
        this.big.connect('repaint', area => this._paint(area, true));
        this.pop.add_child(this.big);
        this.caption = mkLabel(this.captionText(), 'sysmon-caption');
        this.pop.add_child(this.caption);

        this.body = new St.BoxLayout({vertical: true, style_class: 'sysmon-body'});
        this.pop.add_child(this.body);
        this.buildBody();

        this.applyCfg(ext.cfg);

        this._hoverIds = [
            [this.button, this.button.connect('notify::hover', () => this._hoverChanged())],
            [this.button, this.button.connect('button-press-event', (_a, event) => {
                if (event.get_button() === Clutter.BUTTON_PRIMARY) this._toggleClick();
                return Clutter.EVENT_PROPAGATE;
            })],
            [this.pop, this.pop.connect('notify::hover', () => this._hoverChanged())],
        ];
    }

    // ---- to be provided by each metric ----
    titleText() { return this.id.toUpperCase(); }
    captionText() { return 'Last 60 seconds'; }
    layers() { return []; }
    alertKeys() { return []; }          // one key per layer, same order as layers()
    range() { return {lo: 0, hi: 100}; }
    setPanel(_snap) {}
    setPopover(_snap) {}
    buildBody() {}

    // ---- settings (font, graph size) ----
    onColor(_color) {}

    applyCfg(cfg) {
        const on = cfg.show[this.id];                  // undefined for the GPU items (they manage it themselves)
        if (on !== undefined) {
            this.button.container.visible = on;
            if (!on && this._shown) this.hide();
        }
        this.color = cfg.colors[this.colorKey || this.id];
        this.title.set_style(`color: ${this.color};`);
        this.onColor(this.color);
        const own = cfg.itemFont[this.id];     // per-item size; below 7 means "use the global size"
        const fs = own >= 7 ? own : (this.small ? Math.max(7, cfg.fontSize - 2) : cfg.fontSize);
        const ref = this.small ? 9 : 11;
        const family = cfg.fontFamily.replace(/["'`;{}\\]/g, '');
        let style = `color: ${this.color}; font-size: ${fs}px; font-weight: ${cfg.bold ? 'bold' : 'normal'};`;
        if (family) style += ` font-family: "${family}";`;
        this.value.set_style(style);
        const own_w = cfg.itemWidth[this.id];  // per-item text box width; 0 = automatic
        this.value.set_width(own_w > 0 ? own_w : Math.round(this.baseWidth * fs / ref));   // constant width: nothing shifts
        const own_cw = cfg.itemChartWidth[this.id];   // per-item graph width; 0 = default width
        this.chart.set_size(own_cw > 0 ? Math.max(20, own_cw) : cfg.chartWidth, cfg.chartHeight);
        this.box.set_style(`spacing: ${cfg.gap}px;`);
        this.chart.queue_repaint();
    }

    // ---- drawing ----
    _paint(area, big) {
        const [w, h] = area.get_surface_size();
        const cr = area.get_context();
        try {
            const {lo, hi} = this.range();
            drawChart(cr, w, h, this._alertLayers(), {
                lo, hi, frac: this.ext.frac(),
                points: big ? BIG_POINTS : this.ext.cfg.points,
                radius: big ? 9 : 4, grid: big,
            });
        } catch (e) {
            logError(e, 'SysMon paint');
        } finally {
            cr.$dispose();
        }
    }

    // layers, with the color of any layer whose current value is above its threshold replaced by the alert color
    _alertLayers() {
        const layers = this.layers(), keys = this.alertKeys(), al = this.ext.cfg.alerts;
        return layers.map((l, i) => {
            const a = al[keys[i]];
            if (!a || !a.on || !l.values.length) return l;
            return l.values[l.values.length - 1] > a.limit ? {...l, color: a.color} : l;
        });
    }

    repaint() {
        this.chart.queue_repaint();
        if (this._shown) this.big.queue_repaint();
    }

    // ---- hover handling ----
    _clear(prop) {
        if (this[prop]) { GLib.Source.remove(this[prop]); this[prop] = 0; }
    }

    _hoverChanged() {
        const hovering = this.button.hover || this.pop.hover;
        if (hovering) {
            this._clear('_hideId');
            if (!this._shown && !this._showId && !this.ext.pinnedOther(this)) {
                this._showId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 120, () => {
                    this._showId = 0;
                    if (!this.ext.pinnedOther(this)) this.show();
                    return GLib.SOURCE_REMOVE;
                });
            }
        } else {
            this._clear('_showId');
            if (this._shown && !this._pinned && !this._hideId) {
                this._hideId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
                    this._hideId = 0;
                    if (!this._pinned && !(this.button.hover || this.pop.hover)) this.hide();
                    return GLib.SOURCE_REMOVE;
                });
            }
        }
    }

    // Click: pin the popover open; click again: close it.
    _toggleClick() {
        this._clear('_showId');
        this._clear('_hideId');
        if (this._shown && this._pinned) {
            this.hide();                       // also clears the pin
        } else {
            this._pinned = true;
            if (this._shown) return;           // already open from hovering: just keep it
            this.show();
        }
    }

    show() {
        if (this._shown) return;
        this.ext.hideOthers(this);
        this._shown = true;
        this.ext.updateDetail();                 // fills this popover with fresh data
        this.pop.remove_all_transitions();
        this.pop.opacity = 0;
        this.pop.show();

        const [bx] = this.button.get_transformed_position();
        const by = Main.panel.get_transformed_position()[1] + Main.panel.height;
        const [, pw] = this.pop.get_preferred_width(-1);
        const mon = Main.layoutManager.primaryMonitor;
        let x = bx + this.button.width / 2 - pw / 2;
        x = Math.max(mon.x + 8, Math.min(x, mon.x + mon.width - pw - 8));
        this.pop.set_position(Math.round(x), Math.round(by + 4));
        this.pop.ease({opacity: 255, duration: 140, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        this.big.queue_repaint();
    }

    hide() {
        if (!this._shown) return;
        this._shown = false;
        this._pinned = false;
        this.pop.remove_all_transitions();
        this.pop.ease({
            opacity: 0, duration: 100, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => { if (!this._shown) this.pop.hide(); },
        });
        this.ext.popoverHidden();
    }

    get shown() { return this._shown; }

    destroy() {
        this._clear('_showId');
        this._clear('_hideId');
        for (const [obj, id] of this._hoverIds) obj.disconnect(id);
        this._hoverIds = [];
        this.pop.remove_all_transitions();
        Main.layoutManager.removeChrome(this.pop);
        this.pop.destroy();
        this.button.destroy();
    }
}

// ---- shared popover piece: "top processes" list --------------------------------------------
class ProcList {
    constructor(title, fmt) {
        this.fmt = fmt;
        this.actor = new St.BoxLayout({vertical: true});
        this.actor.add_child(mkLabel(title, 'sysmon-section'));
        this.list = new St.BoxLayout({vertical: true});
        this.actor.add_child(this.list);
    }
    set(rows, measured = true) {
        this.list.destroy_all_children();
        if (!measured) {
            this.list.add_child(mkLabel('measuring…', 'sysmon-key'));
            return;
        }
        for (const p of rows)
            this.list.add_child(listRow(p.name + (p.count > 1 ? `  ×${p.count}` : ''), this.fmt(p)));
    }
}

// ---- CPU ------------------------------------------------------------------------------------
class CpuItem extends Item {
    constructor(ext) {
        super(ext, 'cpu', COLORS.cpu, 34);
        this.needsProcs = true;
    }
    titleText() { return 'CPU'; }
    layers() { return [{values: this.ext.hist.cpu.v, color: this.color}]; }
    alertKeys() { return ['cpu']; }
    onColor(c) { for (const core of this._cores || []) core.bar.setColor(c); }
    buildBody() {
        this.load = new KV('Load average');
        this.freq = new KV('Frequency');
        this.up = new KV('Uptime');
        for (const kv of [this.load, this.freq, this.up]) this.body.add_child(kv.actor);
        this.body.add_child(mkLabel('CORES', 'sysmon-section'));
        this.coreBox = new St.BoxLayout({vertical: true});
        this.body.add_child(this.coreBox);
        this._cores = [];
        this.procs = new ProcList('TOP PROCESSES (% OF TOTAL CPU)', p => `${p.cpu.toFixed(1)}%`);
        this.body.add_child(this.procs.actor);
    }
    _ensureCores(n) {
        if (this._cores.length === n) return;
        this.coreBox.destroy_all_children();
        this._cores = [];
        const cols = n > 16 ? 4 : 2;
        const cellW = Math.floor((BIG_W - (cols - 1) * 14) / cols);
        let row = null;
        for (let i = 0; i < n; i++) {
            if (i % cols === 0) {
                row = new St.BoxLayout({style_class: 'sysmon-corerow'});
                this.coreBox.add_child(row);
            }
            const cell = new St.BoxLayout({width: cellW, style_class: 'sysmon-core'});
            cell.add_child(mkLabel(`${i}`, 'sysmon-key', {width: 16}));
            const bar = new Bar(this.color, cellW - 16 - 34);
            cell.add_child(bar.actor);
            const val = mkLabel('0%', 'sysmon-val');
            val.set_width(34);
            cell.add_child(val);
            row.add_child(cell);
            this._cores.push({bar, val});
        }
    }
    setPanel(snap) { this.value.text = pct(snap.cpu.pct); }
    setPopover(snap) {
        this.bigValue.text = pct(snap.cpu.pct);
        this.subtitle.text = snap.cpu.model;
        const d = snap.cpu;
        this.load.set(d.load ? d.load.map(x => x.toFixed(2)).join('  ·  ') : '-');
        this.freq.set(d.freqGHz ? `${d.freqGHz.toFixed(2)} GHz avg` : 'n/a');
        this.up.set(snap.uptime ? S.fmtUptime(snap.uptime) : '-');
        this._ensureCores(d.cores.length);
        d.cores.forEach((c, i) => {
            this._cores[i].bar.set(c / 100);
            this._cores[i].val.text = pct(c);
        });
        if (snap.procs) this.procs.set(snap.procs.byCpu, snap.procs.measured);
    }
}

// ---- RAM ------------------------------------------------------------------------------------
class RamItem extends Item {
    constructor(ext) {
        super(ext, 'ram', COLORS.ram, 34);
        this.needsProcs = true;
    }
    titleText() { return 'Memory'; }
    layers() { return [{values: this.ext.hist.ram.v, color: this.color}]; }
    alertKeys() { return ['ram']; }
    onColor(c) { if (this.bar) this.bar.setColor(c); }
    buildBody() {
        this.bar = new Bar(this.color, BIG_W);
        this.body.add_child(this.bar.actor);
        this.used = new KV('Used');
        this.avail = new KV('Available');
        this.cached = new KV('Cached');
        this.buffers = new KV('Buffers');
        this.swap = new KV('Swap');
        for (const kv of [this.used, this.avail, this.cached, this.buffers, this.swap]) this.body.add_child(kv.actor);
        this.procs = new ProcList('TOP PROCESSES (RESIDENT MEMORY)', p => S.fmtBytes(p.rss));
        this.body.add_child(this.procs.actor);
    }
    setPanel(snap) { this.value.text = pct(snap.mem.percent); }
    setPopover(snap) {
        const m = snap.mem;
        this.bigValue.text = pct(m.percent);
        this.subtitle.text = `${S.fmtBytes(m.used)} of ${S.fmtBytes(m.total)}`;
        this.bar.set(m.percent / 100);
        this.used.set(S.fmtBytes(m.used));
        this.avail.set(S.fmtBytes(m.available));
        this.cached.set(S.fmtBytes(m.cached));
        this.buffers.set(S.fmtBytes(m.buffers));
        this.swap.set(m.swapTotal ? `${S.fmtBytes(m.swapUsed)} of ${S.fmtBytes(m.swapTotal)}` : 'none');
        if (snap.procs) this.procs.set(snap.procs.byMem, true);
    }
}

// ---- Temperature --------------------------------------------------------------------------------
class TempItem extends Item {
    constructor(ext) { super(ext, 'temp', COLORS.temp, 34); }
    titleText() { return 'CPU temperature'; }
    layers() { return [{values: this.ext.hist.temp.v, color: this.color}]; }
    alertKeys() { return ['temp']; }
    range() { return {lo: 20, hi: 100}; }
    buildBody() {
        this.sensorBox = new St.BoxLayout({vertical: true});
        this.body.add_child(mkLabel('SENSORS', 'sysmon-section'));
        this.body.add_child(this.sensorBox);
        this.fanTitle = mkLabel('FANS', 'sysmon-section');
        this.fanBox = new St.BoxLayout({vertical: true});
        this.body.add_child(this.fanTitle);
        this.body.add_child(this.fanBox);
    }
    setPanel(snap) {
        const t = snap.temp.cpu;
        this.value.text = t === null ? 'n/a' : `${Math.round(t)}°`;
    }
    setPopover(snap) {
        const t = snap.temp.cpu;
        this.bigValue.text = t === null ? 'n/a' : `${t.toFixed(0)}°C`;
        this.subtitle.text = t === null ? 'No CPU sensor found' : 'CPU package';
        this.sensorBox.destroy_all_children();
        const sensors = snap.temp.sensors || [];
        if (!sensors.length) this.sensorBox.add_child(mkLabel('no sensors found', 'sysmon-key'));
        for (const s of sensors.slice(0, 10))
            this.sensorBox.add_child(listRow(`${s.chip} · ${s.label}`, `${s.value.toFixed(0)}°C`));
        this.fanBox.destroy_all_children();
        const fans = snap.temp.fans || [];
        this.fanTitle.visible = this.fanBox.visible = fans.length > 0;
        for (const f of fans) this.fanBox.add_child(listRow(`${f.chip} · ${f.label}`, `${f.rpm} rpm`));
    }
}

// ---- Network ------------------------------------------------------------------------------------
class NetItem extends Item {
    constructor(ext) { super(ext, 'net', COLORS.down, 46, true); }
    titleText() { return 'Network'; }
    layers() {
        return [
            {values: this.ext.hist.down.v, color: this.color},
            {values: this.ext.hist.up.v, color: this.ext.cfg.colors['net-up'], fill: false},
        ];
    }
    alertKeys() { return ['net-down', 'net-up']; }
    range() { return {lo: 0, hi: this.ext.autoHi([this.ext.hist.down, this.ext.hist.up], 128 * 1024)}; }
    captionText() { return 'Last 60 seconds  ·  filled: download  ·  line: upload'; }
    buildBody() {
        this.dl = new KV('Download');
        this.ul = new KV('Upload');
        this.rx = new KV('Received since boot');
        this.tx = new KV('Sent since boot');
        for (const kv of [this.dl, this.ul, this.rx, this.tx]) this.body.add_child(kv.actor);
        this.body.add_child(mkLabel('INTERFACES', 'sysmon-section'));
        this.ifBox = new St.BoxLayout({vertical: true});
        this.body.add_child(this.ifBox);
    }
    setPanel(snap) {
        this.value.text = `↓${S.fmtRate(snap.net.down)}\n↑${S.fmtRate(snap.net.up)}`;
    }
    setPopover(snap) {
        const n = snap.net;
        this.bigValue.text = `↓${S.fmtRate(n.down)}  ↑${S.fmtRate(n.up)}`;
        this.bigValue.set_style('font-size: 15px;');
        this.subtitle.text = 'bytes per second';
        this.dl.set(`${S.fmtBytes(n.down)}/s`);
        this.ul.set(`${S.fmtBytes(n.up)}/s`);
        this.rx.set(S.fmtBytes(n.totalRx));
        this.tx.set(S.fmtBytes(n.totalTx));
        this.ifBox.destroy_all_children();
        const list = n.ifaces.filter(i => i.name !== 'lo' && (i.rx || i.tx))
            .sort((a, b) => (b.rxRate + b.txRate) - (a.rxRate + a.txRate)).slice(0, 6);
        for (const i of list)
            this.ifBox.add_child(listRow(i.name, `↓${S.fmtRate(i.rxRate)}   ↑${S.fmtRate(i.txRate)}`));
    }
}

// ---- Disk ---------------------------------------------------------------------------------------
class DiskItem extends Item {
    constructor(ext) { super(ext, 'disk', COLORS.disk, 34); }
    titleText() { return 'Disk'; }
    captionText() { return 'Disk activity (read + write), last 60 seconds'; }
    layers() { return [{values: this.ext.hist.io.v, color: this.color}]; }
    alertKeys() { return ['disk']; }
    range() { return {lo: 0, hi: this.ext.autoHi([this.ext.hist.io], 512 * 1024)}; }
    buildBody() {
        this.rd = new KV('Read');
        this.wr = new KV('Write');
        this.body.add_child(this.rd.actor);
        this.body.add_child(this.wr.actor);
        this.body.add_child(mkLabel('FILESYSTEMS', 'sysmon-section'));
        this.mountBox = new St.BoxLayout({vertical: true});
        this.body.add_child(this.mountBox);
    }
    setPanel(snap) {
        const r = snap.disk.root;
        this.value.text = r ? pct(r.percent) : 'n/a';
    }
    setPopover(snap) {
        const d = snap.disk, r = d.root;
        this.bigValue.text = r ? pct(r.percent) : 'n/a';
        this.subtitle.text = r ? `/ is ${S.fmtBytes(r.used)} of ${S.fmtBytes(r.total)}` : '';
        this.rd.set(`${S.fmtBytes(d.readRate)}/s`);
        this.wr.set(`${S.fmtBytes(d.writeRate)}/s`);
        this.mountBox.destroy_all_children();
        for (const m of d.mounts || []) {
            const color = m.percent > 95 ? '#ff5555' : m.percent > 85 ? '#ff9f43' : this.color;
            this.mountBox.add_child(listRow(m.mount, `${S.fmtBytes(m.used)} / ${S.fmtBytes(m.total)}  ·  ${pct(m.percent)}`, color));
            const bar = new Bar(color, BIG_W);
            bar.set(m.percent / 100);
            this.mountBox.add_child(bar.actor);
        }
    }
}

// ---- GPU ----------------------------------------------------------------------------------------
const GPU_STATE_TEXT = {
    asleep: 'Sleeping. Hybrid mode powered the card down, so it is not being polled (polling would wake it).',
    off: 'No driver bound to this card (Integrated mode, or the driver is not loaded).',
    nouveau: 'Using the open-source nouveau driver, which exposes no load or memory counters.',
    'no-tools': 'Driver is loaded but nvidia-smi was not found. Install the nvidia-utils package that matches your driver.',
    other: 'Using a driver this extension has no counters for.',
};

// One top bar item per GPU: role 'nvidia' = the dedicated card (id 'gpu'), role 'other' = the integrated GPU (id 'igpu').
class GpuItem extends Item {
    constructor(ext, role) {
        super(ext, role === 'nvidia' ? 'gpu' : 'igpu', role === 'nvidia' ? COLORS.gpu : DEFAULT_COLORS['gpu-igpu'], 50, true,
              {role, colorKey: role === 'nvidia' ? 'gpu' : 'gpu-igpu'});
    }
    titleText() { return this.role === 'nvidia' ? 'NVIDIA GPU' : 'INTEGRATED GPU'; }
    captionText() { return 'Last 60 seconds  \u00b7  filled: load  \u00b7  line: memory'; }
    alertKeys() { return this.role === 'nvidia' ? ['gpu-load', 'gpu-mem'] : ['igpu-load', 'igpu-mem']; }
    gpuOf(snap) { const p = this.ext.gpuPair(snap); return this.role === 'nvidia' ? p.nv : p.other; }
    layers() {
        const h = this.ext.hist;
        const [load, mem] = this.role === 'nvidia' ? [h.gpu, h.gpumem] : [h.igpu, h.igpumem];
        return [
            {values: load.v, color: this.color},
            {values: mem.v, color: lighten(this.color), fill: false},
        ];
    }
    applyCfg(cfg) {
        super.applyCfg(cfg);
        this._applyVisible();
        if (this.appBox) this._rebuildApps(cfg);
    }
    // shown when GPUs are enabled, this role is selected, and (once known) the machine has such a GPU
    _applyVisible() {
        const cfg = this.ext.cfg;
        const sel = cfg.gpuSource === 'auto' || (cfg.gpuSource === 'nvidia') === (this.role === 'nvidia');
        const vis = cfg.showGpu && sel && this._present !== false;
        this.button.container.visible = vis;
        if (!vis && this._shown) this.hide();
    }
    buildBody() {
        this.modeRow = new KV('Graphics mode');
        this.body.add_child(this.modeRow.actor);
        this.modeRow.actor.visible = false;
        this.gpuBox = new St.BoxLayout({vertical: true});
        this.body.add_child(this.gpuBox);
        if (this.role !== 'nvidia') return;       // the app launcher belongs to the dedicated GPU

        this.body.add_child(mkLabel('APPS ON THE DEDICATED GPU', 'sysmon-section'));
        this.appBox = new St.BoxLayout({vertical: true});
        this.body.add_child(this.appBox);
    }

    // ---- apps to start on the dedicated GPU: listed, added and removed right here in the popover ----
    _apps() { return this.ext.settings.get_strv('gpu-apps'); }

    _setApps(list) { this.ext.settings.set_strv('gpu-apps', list); }   // 'changed' rebuilds the list

    _rebuildApps(cfg) {
        if (!this.appBox) return;
        this.appBox.destroy_all_children();
        let count = 0;
        for (const id of cfg.gpuApps) {
            const info = Gio.DesktopAppInfo.new(id);
            if (!info) continue;                                   // uninstalled since it was added
            count++;
            const line = new St.BoxLayout({style_class: 'sysmon-app-line'});
            const row = new St.BoxLayout({style_class: 'sysmon-app-row'});
            const gicon = info.get_icon();
            if (gicon) row.add_child(new St.Icon({gicon, icon_size: 18, y_align: CENTER}));
            row.add_child(mkLabel(info.get_name(), 'sysmon-app-name', {x_expand: true}));
            row.add_child(mkLabel('Run on NVIDIA', 'sysmon-app-run'));
            const run = new St.Button({style_class: 'sysmon-app', child: row, can_focus: true, x_expand: true});
            run.connect('clicked', () => this._launch(info));
            const perm = Perm.isPermanent(id);
            const always = new St.Button({style_class: perm ? 'sysmon-perm sysmon-perm-on' : 'sysmon-perm', can_focus: true, y_align: CENTER,
                child: mkLabel(perm ? '\u2714 Always' : 'Always', 'sysmon-perm-text')});
            always.connect('clicked', () => this._togglePerm(info));
            const rm = new St.Button({style_class: 'sysmon-app-remove', can_focus: true, y_align: CENTER,
                child: new St.Icon({icon_name: 'window-close-symbolic', icon_size: 12})});
            rm.connect('clicked', () => this._removeApp(id));
            line.add_child(run);
            line.add_child(always);
            line.add_child(rm);
            this.appBox.add_child(line);
        }
        if (!count && !this._picking)
            this.appBox.add_child(mkLabel('No apps added yet.', 'sysmon-key'));

        if (this._picking) {
            this.appBox.add_child(this._buildPicker(cfg.gpuApps));
        } else {
            const add = new St.Button({style_class: 'sysmon-link', can_focus: true, x_align: Clutter.ActorAlign.START,
                child: mkLabel('+ Add app…', 'sysmon-link-text')});
            add.connect('clicked', () => {
                this._picking = true;
                this._pinned = true;                               // keep the popover open while choosing
                this._rebuildApps(this.ext.cfg);
            });
            this.appBox.add_child(add);
        }
        if (this._warn) this.appBox.add_child(mkLabel(this._warn, 'sysmon-warn'));
        this.appBox.add_child(mkLabel('Quit an app completely first (browsers may keep a background process), otherwise it keeps its current GPU. Browsers are started through XWayland on NVIDIA.', 'sysmon-caption'));
        this.appBox.add_child(mkLabel('Always: the app also uses NVIDIA when started from the Dock or app grid. This edits its launcher entry in ~/.local/share/applications; switching it off (or removing the app here) restores it.', 'sysmon-caption'));
    }

    _buildPicker(chosen) {
        const wrap = new St.BoxLayout({vertical: true, style_class: 'sysmon-picker-wrap'});
        const head = new St.BoxLayout({style_class: 'sysmon-app-row'});
        head.add_child(mkLabel('Choose an app to add', 'sysmon-key', {x_expand: true}));
        const cancel = new St.Button({style_class: 'sysmon-link', can_focus: true,
            child: mkLabel('Cancel', 'sysmon-link-text')});
        cancel.connect('clicked', () => { this._picking = false; this._rebuildApps(this.ext.cfg); });
        head.add_child(cancel);
        wrap.add_child(head);

        const scroll = new St.ScrollView({
            style_class: 'sysmon-picker', hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC, overlay_scrollbars: true,
        });
        scroll.set_height(220);
        const list = new St.BoxLayout({vertical: true});
        const apps = Gio.AppInfo.get_all()
            .filter(a => a.should_show() && a.get_id() && !chosen.includes(a.get_id()))
            .sort((x, y) => x.get_name().localeCompare(y.get_name()));
        for (const info of apps) {
            const row = new St.BoxLayout({style_class: 'sysmon-app-row'});
            const gicon = info.get_icon();
            if (gicon) row.add_child(new St.Icon({gicon, icon_size: 18, y_align: CENTER}));
            row.add_child(mkLabel(info.get_name(), 'sysmon-app-name', {x_expand: true}));
            const btn = new St.Button({style_class: 'sysmon-app', child: row, can_focus: true, x_expand: true});
            btn.connect('clicked', () => {
                this._picking = false;
                this._setApps([...this._apps().filter(x => x !== info.get_id()), info.get_id()]);
            });
            list.add_child(btn);
        }
        if (!apps.length) list.add_child(mkLabel('No more apps to add.', 'sysmon-key'));
        scroll.set_child(list);
        wrap.add_child(scroll);
        return wrap;
    }

    hide() {
        if (this._picking || this._warn) {     // leave the picker and any warning closed next time
            this._picking = false;
            this._warn = null;
            this._rebuildApps(this.ext.cfg);
        }
        super.hide();
    }

    _togglePerm(info) {
        const id = info.get_id();
        this._warn = null;
        if (Perm.isPermanent(id)) {
            const r = Perm.disable(id);
            if (r === 'foreign') this._warn = `${info.get_name()}: its launcher entry was changed by something else, so it was left as it is.`;
            else if (r === 'no-backup') this._warn = `${info.get_name()}: the saved original is missing, so the entry could not be restored.`;
            else if (r === 'error') this._warn = `${info.get_name()}: could not switch it off.`;
        } else {
            const r = Perm.enable(info);
            if (r === 'error') this._warn = `${info.get_name()}: could not switch it on.`;
            else if ((info.get_categories() || '').includes('TerminalEmulator'))
                this._warn = `Programs you start from ${info.get_name()} will also use NVIDIA.`;
        }
        this._pinned = true;
        this._rebuildApps(this.ext.cfg);
    }

    _removeApp(id) {
        if (Perm.isPermanent(id)) Perm.disable(id);              // undo the launcher change together with the entry
        this._setApps(this._apps().filter(x => x !== id));
    }

    _isRunning(info) {
        try {
            const app = Shell.AppSystem.get_default().lookup_app(info.get_id());
            return !!app && app.get_state() !== Shell.AppState.STOPPED;
        } catch (e) {
            return false;
        }
    }

    _launch(info) {
        if (this._isRunning(info)) {           // would just open a window in the old process (wrong GPU)
            this._warn = `${info.get_name()} is already running. Quit it completely, then click it again.`;
            this._pinned = true;
            this._rebuildApps(this.ext.cfg);
            return;
        }
        try {
            const {env, cmd: planned} = launchPlan(info);
            // an entry that already carries the NVIDIA variables (Always is on) needs no extra flags; deciding by the
            // entry we are about to start, not by the file on disk, also covers the moment right after switching Always on,
            // when the shell may still hold the old entry
            const cmd = (info.get_commandline() || '').includes('__NV_PRIME_RENDER_OFFLOAD=') ? null : planned;
            const ctx = global.create_app_launch_context(0, -1);
            for (const [k, v] of Object.entries(env)) ctx.setenv(k, v);
            const target = cmd ? Gio.AppInfo.create_from_commandline(cmd, info.get_name(), Gio.AppInfoCreateFlags.NONE) : info;
            target.launch([], ctx);
        } catch (e) {
            logError(e, `SysMon: could not start ${info.get_id()}`);
        }
        this.hide();
    }
    setPanel(snap) {
        const g = this.gpuOf(snap);
        this._present = !!g;
        this._applyVisible();
        let t = 'n/a';
        if (!g) t = 'none';
        else if (g.state === 'asleep') t = 'sleep\n(off)';
        else if (g.state === 'off') t = 'off';
        else if (g.state === 'active' && g.load !== null)
            t = `${Math.round(g.load)}%\n${g.memUsed !== null ? S.fmtRate(g.memUsed) : '--'}`;
        else if (g.state === 'active' && g.memUsed !== null)
            t = `n/a\n${S.fmtRate(g.memUsed)}`;
        this.value.text = t;
    }
    setPopover(snap) {
        const gpu = this.gpuOf(snap);
        this.bigValue.text = gpu && gpu.state === 'active' && gpu.load !== null ? pct(gpu.load) : (gpu && gpu.state === 'asleep' ? 'sleep' : 'n/a');
        this.subtitle.text = gpu ? gpu.name : 'No such GPU found';
        const showMode = this.role === 'nvidia' && !!snap.gpu.mode;
        this.modeRow.actor.visible = showMode;
        if (showMode) this.modeRow.set(S.PRIME_MODES[snap.gpu.mode] || snap.gpu.mode || '');

        this.gpuBox.destroy_all_children();
        if (!gpu) return;
        if (gpu.state !== 'active') {
            const note = mkLabel(GPU_STATE_TEXT[gpu.state] || gpu.state, 'sysmon-key');
            note.clutter_text.line_wrap = true;
            note.set_width(BIG_W);
            this.gpuBox.add_child(note);
            return;
        }
        if (gpu.load !== null) this.gpuBox.add_child(listRow('Load', pct(gpu.load), this.color));
        else this.gpuBox.add_child(listRow('Load', 'not available'));
        if (gpu.memTotal) {
            const frac = gpu.memUsed / gpu.memTotal;
            this.gpuBox.add_child(listRow('Memory', `${S.fmtBytes(gpu.memUsed)} / ${S.fmtBytes(gpu.memTotal)}  \u00b7  ${pct(frac * 100)}`, lighten(this.color)));
            const bar = new Bar(lighten(this.color), BIG_W);
            bar.set(frac);
            this.gpuBox.add_child(bar.actor);
        }
        if (gpu.extra && gpu.extra.gttTotal)
            this.gpuBox.add_child(listRow('Shared memory (GTT)', `${S.fmtBytes(gpu.extra.gttUsed || 0)} / ${S.fmtBytes(gpu.extra.gttTotal)}`));
        if (gpu.temp !== null) this.gpuBox.add_child(listRow('Temperature', `${gpu.temp.toFixed(0)}\u00b0C`));
        if (gpu.power !== null) this.gpuBox.add_child(listRow('Power', `${gpu.power.toFixed(1)} W`));
        if (gpu.extra && gpu.extra.idleBackoff)
            this.gpuBox.add_child(mkLabel('Idle: polled every 15 s so the card can sleep.', 'sysmon-caption'));
    }
}

// ---- extension ----------------------------------------------------------------------------------
export default class SysMonGraphs extends Extension {
    enable() {
        this.settings = this.getSettings();
        this.cfg = this._readCfg();
        this._settingsId = this.settings.connect('changed', () => {
            this.cfg = this._readCfg();
            for (const item of this.items || []) item.applyCfg(this.cfg);
            if (this.items) { this._sortItems(); this._reorder(); }
        });
        this.sampler = new Sampler();
        this.hist = {cpu: new History(), ram: new History(), temp: new History(),
                     down: new History(), up: new History(), io: new History(),
                     gpu: new History(), gpumem: new History(),
                     igpu: new History(), igpumem: new History()};
        this.lastSnap = null;
        this.lastSample = GLib.get_monotonic_time();
        this._tickCount = 0;
        this._detailRefreshId = 0;

        this.items = [new CpuItem(this), new RamItem(this), new GpuItem(this, 'nvidia'), new GpuItem(this, 'other'), new TempItem(this),
                      new NetItem(this), new DiskItem(this)];
        this._sortItems();
        this.items.forEach((item, i) =>
            Main.panel.addToStatusArea(`${this.uuid}-${item.id}`, item.button, i, 'right'));

        // Keep the graphs at the far left of the top bar's right-hand side, even when other
        // extensions add their icons later.
        this._reorderId = 0;
        this._rightBox = this.items[0].button.container.get_parent();
        this._boxSignals = ['child-added', 'child-removed'].map(sig =>
            this._rightBox.connect(sig, () => this._queueReorder()));
        this._reorder();

        this._sample();
        this._sampleId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, SAMPLE_SEC, () => {
            this._sample();
            return GLib.SOURCE_CONTINUE;
        });
        this._animId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ANIM_MS, () => {
            for (const item of this.items) item.repaint();
            return GLib.SOURCE_CONTINUE;
        });
    }

    disable() {
        for (const id of [this._sampleId, this._animId, this._detailRefreshId, this._reorderId])
            if (id) GLib.Source.remove(id);
        this._sampleId = this._animId = this._detailRefreshId = this._reorderId = 0;
        if (this._rightBox && this._boxSignals)
            for (const id of this._boxSignals) this._rightBox.disconnect(id);
        this._rightBox = null;
        this._boxSignals = null;
        if (this.settings && this._settingsId) this.settings.disconnect(this._settingsId);
        this._settingsId = 0;
        this.settings = null;
        for (const item of this.items || []) item.destroy();
        this.items = null;
        if (this.sampler) this.sampler.destroy();
        this.sampler = null;
        this.hist = null;
        this.lastSnap = null;
    }

    _readCfg() {
        const s = this.settings;
        const colors = {};
        const itemFont = {};
        const itemWidth = {};
        const itemChartWidth = {};
        for (const [key, def] of Object.entries(DEFAULT_COLORS)) {
            const c = s.get_string(`color-${key}`).trim();
            colors[key] = /^#[0-9a-fA-F]{6}$/.test(c) ? c : def;
        }
        for (const id of ['cpu', 'ram', 'gpu', 'igpu', 'temp', 'net', 'disk'])
            itemFont[id] = s.get_int(`font-size-${id}`);
        for (const id of ['cpu', 'ram', 'gpu', 'igpu', 'temp', 'net', 'disk'])
            { itemWidth[id] = s.get_int(`text-width-${id}`); itemChartWidth[id] = s.get_int(`chart-width-${id}`); }
        return {
            fontSize: s.get_int('font-size'),
            bold: s.get_boolean('font-bold'),
            fontFamily: s.get_string('font-family').trim(),
            chartWidth: s.get_int('chart-width'),
            chartHeight: s.get_int('chart-height'),
            gap: s.get_int('chart-gap'),
            points: Math.min(BIG_POINTS, Math.max(10, s.get_int('history-seconds'))),
            colors,
            itemFont,
            itemWidth,
            itemChartWidth,
            order: normalizeOrder(s.get_strv('item-order')),
            gpuApps: s.get_strv('gpu-apps'),
            show: Object.fromEntries(TOGGLE_IDS.map(id => [id, s.get_boolean(`show-${id}`)])),
            alerts: Object.fromEntries(Object.entries(ALERT_KEYS).map(([k, unit]) => {
                const value = s.get_double(`alert-${k}-value`);
                return [k, {on: s.get_boolean(`alert-${k}-on`), value, color: s.get_string(`alert-${k}-color`),
                            limit: unit === 'rate' ? value * 1048576 : value}];
            })),
            showGpu: s.get_boolean('show-gpu'),
            gpuSource: s.get_string('gpu-source'),
        };
    }

    _queueReorder() {
        if (this._reorderId) return;
        this._reorderId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._reorderId = 0;
            this._reorder();
            return GLib.SOURCE_REMOVE;
        });
    }

    // items in the order chosen in the settings
    _sortItems() {
        const pos = id => this.cfg.order.indexOf(id);
        this.items.sort((a, b) => pos(a.id) - pos(b.id));
    }

    _reorder() {
        if (!this.items || !this._rightBox) return;
        this.items.forEach((item, i) => {
            const c = item.button.container;
            if (this._rightBox.get_child_at_index(i) !== c)
                this._rightBox.set_child_at_index(c, i);
        });
    }

    // phase (0..1) of the scroll animation between two samples
    frac() {
        return Math.min(1, (GLib.get_monotonic_time() - this.lastSample) / 1e6 / SAMPLE_SEC);
    }

    autoHi(histories, floor) {
        let m = floor;
        for (const h of histories) m = Math.max(m, h.max * 1.15);
        return m;
    }

    // NVIDIA GPU plus the "other" one (AMD preferred, else any non-NVIDIA GPU).
    gpuPair(snap) {
        const gpus = snap.gpu.gpus;
        const nv = gpus.find(g => g.kind === 'nvidia') || null;
        const other = gpus.find(g => g.kind === 'amd') || gpus.find(g => g.kind !== 'nvidia') || null;
        return {nv, other};
    }

    // Another item whose popover was pinned by a click (hovering must not replace it).
    pinnedOther(item) {
        return this.items.some(i => i !== item && i.shown && i._pinned);
    }

    hideOthers(except) {
        for (const item of this.items) if (item !== except && item.shown) item.hide();
    }

    popoverHidden() {
        if (!this.items.some(i => i.shown)) this.sampler.resetProcs();
    }

    _openItem() {
        return this.items.find(i => i.shown) || null;
    }

    _sample() {
        const snap = this.sampler.tick();
        this.lastSnap = snap;
        this.lastSample = GLib.get_monotonic_time();
        this._tickCount++;

        const h = this.hist;
        h.cpu.push(snap.cpu.pct);
        h.ram.push(snap.mem.percent);
        if (snap.temp.cpu !== null) h.temp.push(snap.temp.cpu);
        else h.temp.push(20);
        h.down.push(snap.net.down);
        h.up.push(snap.net.up);
        h.io.push(snap.disk.readRate + snap.disk.writeRate);
        const pair = this.gpuPair(snap);
        const live = x => !!x && x.state === 'active';
        h.gpu.push(live(pair.nv) && pair.nv.load !== null ? pair.nv.load : 0);
        h.gpumem.push(live(pair.nv) && pair.nv.memTotal ? pair.nv.memUsed / pair.nv.memTotal * 100 : 0);
        h.igpu.push(live(pair.other) && pair.other.load !== null ? pair.other.load : 0);
        h.igpumem.push(live(pair.other) && pair.other.memTotal ? pair.other.memUsed / pair.other.memTotal * 100 : 0);

        for (const item of this.items) item.setPanel(snap);
        if (this._openItem()) this.updateDetail(this._tickCount % 2 === 0);
    }

    // Collect the expensive details and refresh whichever popover is open.
    updateDetail(withProcs = true) {
        const open = this._openItem();
        if (!open || !this.lastSnap) return;
        const needProcs = open.needsProcs && (withProcs || !this.sampler.hasProcBaseline());
        const firstScan = open.needsProcs && !this.sampler.hasProcBaseline();
        this.sampler.detail(this.lastSnap, needProcs);
        open.setPopover(this.lastSnap);
        if (firstScan && !this._detailRefreshId) {
            // second scan shortly after the first one gives the per-process CPU deltas
            this._detailRefreshId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 700, () => {
                this._detailRefreshId = 0;
                this.updateDetail(true);
                return GLib.SOURCE_REMOVE;
            });
        }
    }
}
