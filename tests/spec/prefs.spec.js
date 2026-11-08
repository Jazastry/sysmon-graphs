// The settings window (prefs.js) built for real with GTK 4 / libadwaita. Needs a display: run.sh starts one
// with xvfb-run when there is none; without any display these specs are skipped.
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import {loadPrefs} from '../helpers/load.js';
import {resetAllSettings} from '../helpers/ext-harness.js';

const hasDisplay = Gtk.init_check();

function walk(w, f) {
    f(w);
    for (let c = w.get_first_child && w.get_first_child(); c; c = c.get_next_sibling()) walk(c, f);
}
const all = (root, type) => { const r = []; walk(root, w => { if (w instanceof type) r.push(w); }); return r; };

describe('settings window (prefs.js)', () => {
    let win, settings;

    beforeAll(async function () {
        if (!hasDisplay) return;
        Adw.init();
    });
    beforeEach(async function () {
        if (!hasDisplay) return pending('no display (run through run.sh, which uses xvfb-run)');
        resetAllSettings();
        const Prefs = await loadPrefs();
        const p = new Prefs();
        win = new Adw.PreferencesWindow();
        p.fillPreferencesWindow(win);
        settings = p.getSettings();
    });

    const expanders = () => all(win, Adw.ExpanderRow);
    const itemExpander = title => expanders().find(e => e.title === title);
    const spinsIn = e => all(e, Adw.SpinRow);
    const spinTitled = (e, title) => spinsIn(e).find(r => r.title === title);
    const orderRows = () => all(win, Adw.ActionRow).filter(r => !(r instanceof Adw.SpinRow) && !(r instanceof Adw.ExpanderRow) && /^Position \d/.test(r.subtitle || ''));
    const buttonTitled = (row, tip) => all(row, Gtk.Button).find(b => b.tooltip_text === tip);

    describe('structure', () => {
        it('has a per-item section for each of the seven items', () => {
            const titles = expanders().map(e => e.title);
            for (const t of ['CPU', 'RAM', 'NVIDIA GPU', 'Integrated GPU', 'Temperature', 'Network', 'Disk']) expect(titles).toContain(t);
        });
        it('has no global "Graph width" any more, but one per item', () => {
            const spins = all(win, Adw.SpinRow).filter(r => r.title === 'Graph width');
            expect(spins.length).toBe(7);
            for (const e of ['CPU', 'RAM', 'NVIDIA GPU', 'Integrated GPU', 'Temperature', 'Network', 'Disk'])
                expect(spinTitled(itemExpander(e), 'Graph width')).withContext(e).toBeDefined();
        });
        it('has no apps group (the apps live in the GPU popover)', () => {
            const groups = [];
            walk(win, w => { if (w instanceof Adw.PreferencesGroup) groups.push(w.title); });
            expect(groups).not.toContain('Apps on the dedicated GPU');
        });
    });

    describe('per-item numbers', () => {
        it('graph width writes chart-width-<id>', () => {
            const spin = spinTitled(itemExpander('Integrated GPU'), 'Graph width');
            spin.value = 90;
            expect(settings.get_int('chart-width-igpu')).toBe(90);
            expect(settings.get_int('chart-width-cpu')).toBe(0);
        });
        it('text size and text box width write their per-item keys', () => {
            spinTitled(itemExpander('Network'), 'Text size').value = 13;
            spinTitled(itemExpander('Network'), 'Text box width').value = 75;
            expect(settings.get_int('font-size-net')).toBe(13);
            expect(settings.get_int('text-width-net')).toBe(75);
        });
    });

    describe('items in the top bar (order and on/off)', () => {
        it('lists the seven items in the saved order', () => {
            expect(orderRows().map(r => r.title)).toEqual(['CPU', 'RAM', 'NVIDIA GPU', 'Integrated GPU', 'Temperature', 'Network', 'Disk']);
        });
        it('has a show/hide switch on every row except the two GPU rows', () => {
            expect(orderRows().map(r => all(r, Gtk.Switch).length)).toEqual([1, 1, 0, 0, 1, 1, 1]);
        });
        it('the switch reads and writes show-<id>', () => {
            const sw = all(orderRows()[1], Gtk.Switch)[0];        // RAM
            expect(sw.active).toBeTrue();
            sw.active = false;
            expect(settings.get_boolean('show-ram')).toBeFalse();
            sw.active = true;
            expect(settings.get_boolean('show-ram')).toBeTrue();
        });
        it('"Move right" / "Move left" save the new order and rebuild the rows', () => {
            buttonTitled(orderRows()[0], 'Move right').emit('clicked');
            expect(settings.get_strv('item-order').join()).toBe('ram,cpu,gpu,igpu,temp,net,disk');
            expect(orderRows().map(r => r.title).slice(0, 2)).toEqual(['RAM', 'CPU']);
            buttonTitled(orderRows()[6], 'Move left').emit('clicked');
            expect(settings.get_strv('item-order').join()).toBe('ram,cpu,gpu,igpu,temp,disk,net');
        });
        it('the end buttons are disabled', () => {
            const rows = orderRows();
            expect(buttonTitled(rows[0], 'Move left').sensitive).toBeFalse();
            expect(buttonTitled(rows[6], 'Move right').sensitive).toBeFalse();
        });
        it('rows follow changes made elsewhere (reset, other windows)', () => {
            buttonTitled(orderRows()[0], 'Move right').emit('clicked');
            settings.reset('item-order');
            expect(orderRows()[0].title).toBe('CPU');
            settings.set_boolean('show-disk', false);
            const disk = orderRows().find(r => r.title === 'Disk');
            expect(all(disk, Gtk.Switch)[0].active).toBeFalse();
        });
    });

    describe('threshold alerts', () => {
        const alerts = () => expanders().filter(e => / alert$/.test(e.title));
        const alertTitled = t => alerts().find(a => a.title === t);

        it('has an alert row for every graph: 10 in total', () => {
            expect(alerts().map(a => a.title).sort()).toEqual(
                ['CPU load alert', 'Disk activity (read + write) alert', 'Download alert', 'Load alert', 'Load alert', 'Memory alert',
                 'Memory alert', 'RAM used alert', 'Temperature alert', 'Upload alert']);
        });
        it('is off by default and the switch writes alert-<key>-on', () => {
            const cpu = alertTitled('CPU load alert');
            expect(cpu.show_enable_switch).toBeTrue();
            expect(cpu.enable_expansion).toBeFalse();
            cpu.enable_expansion = true;
            expect(settings.get_boolean('alert-cpu-on')).toBeTrue();
        });
        it('threshold writes the value; network thresholds are MB/s with one decimal', () => {
            const sp = spinsIn(alertTitled('CPU load alert'))[0];
            expect(sp.value).toBe(80);
            sp.value = 65;
            expect(settings.get_double('alert-cpu-value')).toBe(65);
            const dl = spinsIn(alertTitled('Download alert'))[0];
            expect(dl.digits).toBe(1);
            dl.value = 2.5;
            expect(settings.get_double('alert-net-down-value')).toBe(2.5);
        });
        it('the two graphs of the network item are independent', () => {
            alertTitled('Upload alert').enable_expansion = true;
            expect(settings.get_boolean('alert-net-up-on')).toBeTrue();
            expect(settings.get_boolean('alert-net-down-on')).toBeFalse();
        });
        it('the colour button shows the default and writes the picked colour', () => {
            const btn = all(alertTitled('Temperature alert'), Gtk.ColorDialogButton)[0];
            expect([btn.rgba.red, btn.rgba.green, btn.rgba.blue].map(v => Math.round(v * 255))).toEqual([255, 77, 77]);
            const c = btn.rgba.copy();
            c.red = 0; c.green = 1; c.blue = 0;
            btn.rgba = c;
            expect(settings.get_string('alert-temp-color')).toBe('#00ff00');
        });
    });
});
