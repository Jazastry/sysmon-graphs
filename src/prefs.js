import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

function spinRow(settings, key, title, subtitle, lower, upper) {
    const row = new Adw.SpinRow({
        title, subtitle,
        adjustment: new Gtk.Adjustment({lower, upper, step_increment: 1, page_increment: 5}),
    });
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function rgbaToHex(c) {
    return '#' + [c.red, c.green, c.blue].map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
}

function colorRow(settings, key, title) {
    const row = new Adw.ActionRow({title});
    const btn = new Gtk.ColorDialogButton({dialog: new Gtk.ColorDialog({with_alpha: false}), valign: Gtk.Align.CENTER});
    const load = () => {
        const rgba = new Gdk.RGBA();
        rgba.parse(settings.get_string(key));
        btn.rgba = rgba;
    };
    load();
    btn.connect('notify::rgba', () => {
        const hex = rgbaToHex(btn.rgba);
        if (hex !== settings.get_string(key)) settings.set_string(key, hex);
    });
    const reset = new Gtk.Button({icon_name: 'edit-undo-symbolic', valign: Gtk.Align.CENTER, tooltip_text: 'Reset to default'});
    reset.add_css_class('flat');
    reset.connect('clicked', () => { settings.reset(key); load(); });
    row.add_suffix(reset);
    row.add_suffix(btn);
    return row;
}

// graph layers with an optional alert color: [settings key, name, unit]
const ALERTS = {
    cpu: [['cpu', 'CPU load', '%']],
    ram: [['ram', 'RAM used', '%']],
    gpu: [['gpu-load', 'Load', '%'], ['gpu-mem', 'Memory', '%']],
    igpu: [['igpu-load', 'Load', '%'], ['igpu-mem', 'Memory', '%']],
    temp: [['temp', 'Temperature', '\u00b0C']],
    net: [['net-down', 'Download', 'MB/s'], ['net-up', 'Upload', 'MB/s']],
    disk: [['disk', 'Disk activity (read + write)', 'MB/s']],
};

// "<name> alert": a switch row that expands to the threshold and the alert color
function alertRow(settings, key, name, unit) {
    const row = new Adw.ExpanderRow({
        title: `${name} alert`,
        subtitle: `The ${name.toLowerCase()} graph changes color while it is above the threshold`,
        show_enable_switch: true,
    });
    settings.bind(`alert-${key}-on`, row, 'enable-expansion', Gio.SettingsBindFlags.DEFAULT);
    const spin = new Adw.SpinRow({
        title: 'Threshold', subtitle: unit === 'MB/s' ? 'In MB/s, as shown in the top bar' : `In ${unit}`,
        digits: unit === 'MB/s' ? 1 : 0,
        adjustment: new Gtk.Adjustment({lower: 0, upper: unit === 'MB/s' ? 10000 : (unit === '%' ? 100 : 150),
                                        step_increment: unit === 'MB/s' ? 0.5 : 1, page_increment: unit === 'MB/s' ? 10 : 5}),
    });
    settings.bind(`alert-${key}-value`, spin, 'value', Gio.SettingsBindFlags.DEFAULT);
    row.add_row(spin);
    row.add_row(colorRow(settings, `alert-${key}-color`, 'Color above the threshold'));
    return row;
}

const ITEMS = [
    ['cpu', 'CPU', [['color-cpu', 'Color']]],
    ['ram', 'RAM', [['color-ram', 'Color']]],
    ['gpu', 'NVIDIA GPU', [['color-gpu', 'Color (the memory line is a lighter shade)']]],
    ['igpu', 'Integrated GPU', [['color-gpu-igpu', 'Color (the memory line is a lighter shade)']]],
    ['temp', 'Temperature', [['color-temp', 'Color']]],
    ['net', 'Network', [['color-net', 'Download color'], ['color-net-up', 'Upload color']]],
    ['disk', 'Disk', [['color-disk', 'Color']]],
];

const DEFAULT_ORDER = ['cpu', 'ram', 'gpu', 'igpu', 'temp', 'net', 'disk'];
const LABELS = Object.fromEntries(ITEMS.map(([id, label]) => [id, label]));
function normalizeOrder(list) {
    const out = [];
    for (const id of [...list, ...DEFAULT_ORDER])
        if (DEFAULT_ORDER.includes(id) && !out.includes(id)) out.push(id);
    return out;
}

// "Order": one row per item with move up / move down buttons
function orderGroup(settings) {
    const group = new Adw.PreferencesGroup({
        title: 'Items in the top bar',
        description: 'Left to right. Use the switch to show or hide an item and the arrows to move it; changes apply immediately. The GPU items are shown or hidden under "GPU" below.',
    });
    const reset = new Gtk.Button({label: 'Reset', valign: Gtk.Align.CENTER});
    reset.add_css_class('flat');
    reset.connect('clicked', () => settings.reset('item-order'));
    group.set_header_suffix(reset);

    let rows = [];
    const rebuild = () => {
        for (const r of rows) group.remove(r);
        rows = [];
        const order = normalizeOrder(settings.get_strv('item-order'));
        order.forEach((id, i) => {
            const gpuItem = id === 'gpu' || id === 'igpu';
            const row = new Adw.ActionRow({title: LABELS[id], subtitle: `Position ${i + 1}`});
            if (!gpuItem) {
                const sw = new Gtk.Switch({valign: Gtk.Align.CENTER, tooltip_text: 'Show this item'});
                settings.bind(`show-${id}`, sw, 'active', Gio.SettingsBindFlags.DEFAULT);
                row.add_suffix(sw);
            }
            const mk = (icon, tip, delta) => {
                const b = new Gtk.Button({icon_name: icon, valign: Gtk.Align.CENTER, tooltip_text: tip});
                b.add_css_class('flat');
                b.sensitive = i + delta >= 0 && i + delta < order.length;
                b.connect('clicked', () => {
                    const next = [...order];
                    [next[i], next[i + delta]] = [next[i + delta], next[i]];
                    settings.set_strv('item-order', next);
                });
                return b;
            };
            row.add_suffix(mk('go-up-symbolic', 'Move left', -1));
            row.add_suffix(mk('go-down-symbolic', 'Move right', 1));
            group.add(row);
            rows.push(row);
        });
    };
    rebuild();
    settings.connect('changed::item-order', rebuild);
    return group;
}

export default class SysMonPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(560, 560);

        const page = new Adw.PreferencesPage({title: 'SysMon Graphs', icon_name: 'utilities-system-monitor-symbolic'});

        const text = new Adw.PreferencesGroup({
            title: 'Top bar text',
            description: 'The numbers next to each graph. Changes apply immediately.',
        });
        text.add(spinRow(settings, 'font-size', 'Font size', 'In pixels', 7, 20));

        const bold = new Adw.SwitchRow({title: 'Bold'});
        settings.bind('font-bold', bold, 'active', Gio.SettingsBindFlags.DEFAULT);
        text.add(bold);

        const family = new Adw.EntryRow({title: 'Font family (empty = system font)'});
        settings.bind('font-family', family, 'text', Gio.SettingsBindFlags.DEFAULT);
        text.add(family);
        page.add(text);

        const graphs = new Adw.PreferencesGroup({title: 'Top bar graphs'});
        graphs.add(spinRow(settings, 'chart-height', 'Graph height', 'In pixels', 10, 30));
        graphs.add(spinRow(settings, 'chart-gap', 'Gap between graph and text', 'In pixels', 0, 30));
        graphs.add(spinRow(settings, 'history-seconds', 'History', 'Seconds of history shown in each graph', 10, 60));
        page.add(graphs);

        page.add(orderGroup(settings));

        const per = new Adw.PreferencesGroup({
            title: 'Per item',
            description: 'Graph width, colors, threshold alerts and text of each item. Width, text size and text box width: 0 = default.',
        });
        for (const [id, label, colors] of ITEMS) {
            const exp = new Adw.ExpanderRow({title: label});
            for (const [key, title] of colors) exp.add_row(colorRow(settings, key, title));
            for (const [key, name, unit] of ALERTS[id]) exp.add_row(alertRow(settings, key, name, unit));
            exp.add_row(spinRow(settings, `chart-width-${id}`, 'Graph width', 'In pixels (20 to 160), 0 = default width', 0, 160));
            exp.add_row(spinRow(settings, `font-size-${id}`, 'Text size', '0 = use the global size above', 0, 20));
            exp.add_row(spinRow(settings, `text-width-${id}`, 'Text box width', 'In pixels, 0 = automatic (follows the text size)', 0, 200));
            per.add(exp);
        }
        page.add(per);

        const gpu = new Adw.PreferencesGroup({
            title: 'GPU',
            description: 'In Hybrid mode a sleeping NVIDIA card is never polled, so it can stay powered down.',
        });
        const show = new Adw.SwitchRow({title: 'Show GPU load and memory'});
        settings.bind('show-gpu', show, 'active', Gio.SettingsBindFlags.DEFAULT);
        gpu.add(show);

        const sources = ['auto', 'nvidia', 'amd'];
        const combo = new Adw.ComboRow({
            title: 'GPUs to show',
            subtitle: 'Auto gives each GPU in the machine its own item (graph: filled = load, line = memory)',
            model: Gtk.StringList.new(['Auto (one item per GPU)', 'NVIDIA only', 'Integrated GPU only']),
        });
        combo.selected = Math.max(0, sources.indexOf(settings.get_string('gpu-source')));
        combo.connect('notify::selected', () => settings.set_string('gpu-source', sources[combo.selected]));
        gpu.add(combo);
        page.add(gpu);

        window.add(page);
    }
}
