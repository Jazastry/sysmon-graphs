import {createExtension, item, panelOrder, fakeGpus, NV, AMD, MB, setHist, labelsIn} from '../helpers/ext-harness.js';
import {runningApps} from '../helpers/gnome-stubs.js';

describe('extension: top bar items', () => {
    let ext;
    beforeEach(async () => { ext = await createExtension(); });
    afterEach(() => ext.disable());

    const visible = id => item(ext, id).button.container.visible;

    describe('order', () => {
        it('starts in the default order', () => {
            expect(panelOrder(ext)).toEqual(['cpu', 'ram', 'gpu', 'igpu', 'temp', 'net', 'disk']);
        });
        it('follows the item-order setting live', () => {
            ext.settings.set_strv('item-order', ['net', 'cpu', 'disk', 'gpu', 'igpu', 'ram', 'temp']);
            expect(panelOrder(ext)).toEqual(['net', 'cpu', 'disk', 'gpu', 'igpu', 'ram', 'temp']);
        });
        it('repairs a damaged list: unknown and duplicate ids dropped, missing ones appended', () => {
            ext.settings.set_strv('item-order', ['disk', 'bogus', 'disk', 'cpu']);
            expect(panelOrder(ext)).toEqual(['disk', 'cpu', 'ram', 'gpu', 'igpu', 'temp', 'net']);
        });
        it('goes back to the default on reset', () => {
            ext.settings.set_strv('item-order', ['disk', 'net']);
            ext.settings.reset('item-order');
            expect(panelOrder(ext)).toEqual(['cpu', 'ram', 'gpu', 'igpu', 'temp', 'net', 'disk']);
        });
    });

    describe('show / hide', () => {
        it('shows the five non-GPU items by default', () => {
            for (const id of ['cpu', 'ram', 'temp', 'net', 'disk']) expect(visible(id)).withContext(id).toBeTrue();
        });
        it('hides and shows items independently', () => {
            ext.settings.set_boolean('show-ram', false);
            ext.settings.set_boolean('show-net', false);
            expect(['ram', 'net', 'cpu', 'temp', 'disk'].map(visible)).toEqual([false, false, true, true, true]);
            ext.settings.set_boolean('show-ram', true);
            expect(visible('ram')).toBeTrue();
        });
        it('a hidden item keeps its place in the order and stays hidden after reordering', () => {
            ext.settings.set_boolean('show-ram', false);
            expect(panelOrder(ext)).toEqual(['cpu', 'ram', 'gpu', 'igpu', 'temp', 'net', 'disk']);
            ext.settings.set_strv('item-order', ['ram', 'cpu']);
            expect(visible('ram')).toBeFalse();
            expect(panelOrder(ext).slice(0, 2)).toEqual(['ram', 'cpu']);
        });
        it('hiding an item closes its open popover', () => {
            const cpu = item(ext, 'cpu');
            cpu.show();
            expect(cpu.shown).toBeTrue();
            ext.settings.set_boolean('show-cpu', false);
            expect(cpu.shown).toBeFalse();
        });
        it('the GPU switch hides both GPU items and leaves the others', () => {
            ext.settings.set_boolean('show-gpu', false);
            ext._sample();
            expect(visible('gpu') || visible('igpu')).toBeFalse();
            expect(visible('cpu')).toBeTrue();
        });
    });

    describe('sizes and text', () => {
        it('graph width is per item; 0 = the default width; below 20 is clamped to 20', () => {
            expect(ext.items.every(i => i.chart._w === 44)).toBeTrue();
            ext.settings.set_int('chart-width-cpu', 100);
            ext.settings.set_int('chart-width-igpu', 30);
            ext.settings.set_int('chart-width-ram', 5);
            const w = id => item(ext, id).chart._w;
            expect([w('cpu'), w('igpu'), w('ram'), w('gpu')]).toEqual([100, 30, 20, 44]);
            ext.settings.set_int('chart-width-cpu', 0);
            expect(w('cpu')).toBe(44);
        });
        it('an existing global chart-width keeps applying to items left at 0', () => {
            ext.settings.set_int('chart-width', 70);
            expect(ext.items.every(i => i.chart._w === 70)).toBeTrue();
        });
        it('graph height is global and does not disturb the widths', () => {
            ext.settings.set_int('chart-width-igpu', 30);
            ext.settings.set_int('chart-height', 22);
            expect(ext.items.every(i => i.chart._h === 22)).toBeTrue();
            expect(item(ext, 'igpu').chart._w).toBe(30);
        });
        it('text box width and text size are per item', () => {
            ext.settings.set_int('text-width-cpu', 20);
            ext.settings.set_int('text-width-net', 80);
            ext.settings.set_int('font-size-ram', 14);
            expect(item(ext, 'cpu').value.width).toBe(20);
            expect(item(ext, 'net').value.width).toBe(80);
            expect(item(ext, 'ram').value.style).toMatch(/font-size: 14px/);
            const before = item(ext, 'cpu').value.width;
            ext.settings.reset('text-width-cpu');
            expect(item(ext, 'cpu').value.width).not.toBe(before);          // back to automatic
        });
    });

    describe('GPU items', () => {
        let gpus;
        beforeEach(() => { gpus = fakeGpus(ext); });
        const sample = () => ext._sample();
        const last = h => h.v[h.v.length - 1];

        it('shows one item per GPU, each with its own text, history, layers and colour', () => {
            sample();
            const nv = item(ext, 'gpu'), ig = item(ext, 'igpu');
            expect(nv.button.container.visible && ig.button.container.visible).toBeTrue();
            expect(nv.value.text).toMatch(/^40%\n/);
            expect(ig.value.text).toMatch(/^10%\n/);
            expect([last(ext.hist.gpu), last(ext.hist.gpumem), last(ext.hist.igpu), last(ext.hist.igpumem)]).toEqual([40, 25, 10, 50]);
            for (const it of [nv, ig]) {
                const l = it.layers();
                expect(l.length).toBe(2);
                expect(l[0].fill).not.toBe(false);          // load: filled area
                expect(l[1].fill).toBe(false);              // memory: line
            }
            expect(nv.color).not.toBe(ig.color);
            expect(ig.color).toBe('#5ec8ff');
        });
        it('popovers show only their own GPU; the apps list lives in the NVIDIA one', () => {
            sample();
            const nv = item(ext, 'gpu'), ig = item(ext, 'igpu');
            nv.setPopover(ext.lastSnap);
            ig.setPopover(ext.lastSnap);
            const a = labelsIn(nv.pop).join(' | '), b = labelsIn(ig.pop).join(' | ');
            expect(a).toContain('RTX 5060');
            expect(a).toContain('APPS ON THE DEDICATED GPU');
            expect(a).not.toContain('Radeon');
            expect(b).toContain('Radeon 610M');
            expect(b).toContain('GTT');
            expect(b).not.toContain('APPS ON');
            expect(b).not.toContain('RTX');
            expect([nv.title.text, ig.title.text]).toEqual(['NVIDIA GPU', 'INTEGRATED GPU']);
        });
        it('a sleeping NVIDIA card shows "sleep" and a flat graph; the integrated item is unaffected', () => {
            gpus.gpus = [NV({state: 'asleep', load: null, memUsed: null, memTotal: null}), AMD()];
            sample();
            expect(item(ext, 'gpu').value.text).toMatch(/^sleep/);
            expect(item(ext, 'igpu').value.text).toMatch(/^10%/);
            expect(last(ext.hist.gpu)).toBe(0);
        });
        it('source setting: auto = both, nvidia = dedicated only, amd = integrated only', () => {
            const vis = () => [item(ext, 'gpu'), item(ext, 'igpu')].map(i => i.button.container.visible);
            sample();
            expect(vis()).toEqual([true, true]);
            ext.settings.set_string('gpu-source', 'nvidia'); sample();
            expect(vis()).toEqual([true, false]);
            ext.settings.set_string('gpu-source', 'amd'); sample();
            expect(vis()).toEqual([false, true]);
            ext.settings.set_string('gpu-source', 'auto'); sample();
            expect(vis()).toEqual([true, true]);
        });
        it('hides the item of a GPU the machine does not have', () => {
            gpus.gpus = [NV()]; sample();
            expect([item(ext, 'gpu').button.container.visible, item(ext, 'igpu').button.container.visible]).toEqual([true, false]);
            gpus.gpus = [AMD()]; sample();
            expect([item(ext, 'gpu').button.container.visible, item(ext, 'igpu').button.container.visible]).toEqual([false, true]);
        });
        it('copes with an integrated GPU that reports no load or memory (Intel)', () => {
            gpus.gpus = [NV(), {kind: 'intel', name: 'Intel UHD', state: 'active', load: null, memUsed: null, memTotal: null, temp: null, power: null, extra: {}}];
            expect(() => sample()).not.toThrow();
            expect(item(ext, 'igpu').value.text).toMatch(/^n\/a/);
        });
        it('the integrated item has its own colour and text settings', () => {
            ext.settings.set_int('font-size-igpu', 14);
            ext.settings.set_int('text-width-igpu', 70);
            ext.settings.set_string('color-gpu-igpu', '#ff0000');
            const ig = item(ext, 'igpu');
            expect(ig.value.width).toBe(70);
            expect(ig.value.style).toMatch(/font-size: 14px/);
            expect(ig.color).toBe('#ff0000');
            expect(item(ext, 'gpu').color).not.toBe('#ff0000');
        });
    });

    describe('threshold alerts', () => {
        const colors = id => item(ext, id)._alertLayers().map(l => l.color);
        const normal = id => item(ext, id).layers().map(l => l.color);
        const on = (key, value, color) => {
            ext.settings.set_boolean(`alert-${key}-on`, true);
            ext.settings.set_double(`alert-${key}-value`, value);
            if (color) ext.settings.set_string(`alert-${key}-color`, color);
        };

        it('are off by default', () => {
            setHist(ext.hist.cpu, 99); setHist(ext.hist.temp, 99);
            expect(colors('cpu')).toEqual(normal('cpu'));
            expect(colors('temp')).toEqual(normal('temp'));
        });
        it('switch the color only while the value is strictly above the threshold', () => {
            on('cpu', 80, '#ff0000');
            setHist(ext.hist.cpu, 99); expect(colors('cpu')[0]).toBe('#ff0000');
            setHist(ext.hist.cpu, 80); expect(colors('cpu')[0]).toBe(normal('cpu')[0]);
            setHist(ext.hist.cpu, 81); expect(colors('cpu')[0]).toBe('#ff0000');
            setHist(ext.hist.cpu, 10); expect(colors('cpu')[0]).toBe(normal('cpu')[0]);
        });
        it('look at the latest value only, not at old spikes', () => {
            on('cpu', 80, '#ff0000');
            ext.hist.cpu.v = [95, 95, 95, 20];
            expect(colors('cpu')[0]).toBe(normal('cpu')[0]);
        });
        it('use the graph units: degrees for temperature, MB/s for network and disk', () => {
            on('temp', 70, '#ff8800');
            setHist(ext.hist.temp, 71); expect(colors('temp')[0]).toBe('#ff8800');
            setHist(ext.hist.temp, 65); expect(colors('temp')[0]).toBe(normal('temp')[0]);
            on('disk', 20.5, '#abcdef');
            setHist(ext.hist.io, 20 * MB); expect(colors('disk')[0]).toBe(normal('disk')[0]);
            setHist(ext.hist.io, 21 * MB); expect(colors('disk')[0]).toBe('#abcdef');
        });
        it('treat the two graphs of a double item independently (network)', () => {
            on('net-down', 5, '#aa0000'); on('net-up', 1, '#0000aa');
            setHist(ext.hist.down, 6 * MB); setHist(ext.hist.up, 0.5 * MB);
            expect(colors('net')).toEqual(['#aa0000', normal('net')[1]]);
            setHist(ext.hist.down, 1 * MB); setHist(ext.hist.up, 2 * MB);
            expect(colors('net')).toEqual([normal('net')[0], '#0000aa']);
            setHist(ext.hist.down, 9 * MB); setHist(ext.hist.up, 9 * MB);
            expect(colors('net')).toEqual(['#aa0000', '#0000aa']);
            ext.settings.set_boolean('alert-net-up-on', false);
            expect(colors('net')).toEqual(['#aa0000', normal('net')[1]]);
        });
        it('treat load and memory of each GPU separately', () => {
            on('gpu-load', 50, '#112233'); on('gpu-mem', 90, '#445566'); on('igpu-load', 10, '#778899');
            setHist(ext.hist.gpu, 60); setHist(ext.hist.gpumem, 40); setHist(ext.hist.igpu, 5); setHist(ext.hist.igpumem, 95);
            expect(colors('gpu')).toEqual(['#112233', normal('gpu')[1]]);
            expect(colors('igpu')).toEqual(normal('igpu'));                  // igpu memory alert is off even at 95
            setHist(ext.hist.gpumem, 91); setHist(ext.hist.igpu, 11);
            expect(colors('gpu')[1]).toBe('#445566');
            expect(colors('igpu')[0]).toBe('#778899');
        });
        it('default alert colour is red and changing it applies at once', () => {
            on('ram', 85);
            setHist(ext.hist.ram, 90);
            expect(colors('ram')[0]).toBe('#ff4d4d');
            ext.settings.set_string('alert-ram-color', '#00ff00');
            expect(colors('ram')[0]).toBe('#00ff00');
        });
        it('never modify the item\'s own layers', () => {
            on('cpu', 1, '#ff0000'); setHist(ext.hist.cpu, 50);
            colors('cpu');
            expect(item(ext, 'cpu').layers()[0].color).toBe(item(ext, 'cpu').color);
        });
        it('painting works with alert layers', () => {
            on('cpu', 1); on('net-down', 0); setHist(ext.hist.cpu, 50);
            const cr = new Proxy({$dispose() {}}, {get: (t, k) => k in t ? t[k] : () => undefined});
            for (const id of ['cpu', 'net', 'gpu'])
                expect(() => item(ext, id)._paint({get_surface_size: () => [44, 18], get_context: () => cr}, false)).not.toThrow();
        });
    });
});
