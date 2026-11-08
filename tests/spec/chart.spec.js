import Cairo from 'cairo';
import {loadModule} from '../helpers/load.js';
import {world, readFile, writeFile} from '../helpers/world.js';
import GLib from 'gi://GLib';

describe('chart.js', () => {
    let C;
    beforeAll(async () => { C = await loadModule('chart.js'); });

    it('hexToRgb converts to 0..1', () => {
        expect(C.hexToRgb('#ff8000')).toEqual([1, 128 / 255, 0]);
    });
    it('lighten mixes towards white', () => {
        expect(C.lighten('#000000', 1)).toBe('#ffffff');
        expect(C.lighten('#ff0000', 0)).toBe('#ff0000');
        expect(C.lighten('#000000', 0.5)).toBe('#808080');
    });

    // render to a PNG and compare bytes: different input must give different pixels
    const render = (layers, opts = {}, w = 60, h = 20) => {
        const surf = new Cairo.ImageSurface(Cairo.Format.ARGB32, w, h);
        const cr = new Cairo.Context(surf);
        C.drawChart(cr, w, h, layers, {points: 30, ...opts});
        const f = `${world.root}/chart-${Math.random().toString(36).slice(2)}.png`;
        surf.writeToPNG(f);
        cr.$dispose();
        return GLib.file_get_contents(f)[1];
    };
    const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
    const ramp = Array.from({length: 40}, (_, i) => i * 2.5);

    it('draws without throwing for edge-case input', () => {
        const cases = [[], [{values: [], color: '#ff0000'}], [{values: [5], color: '#ff0000'}], [{values: [1, 1, 1, 1], color: '#00ff00'}],
                       [{values: [NaN, 1, 2, 3], color: '#00ff00'}], [{values: ramp, color: '#00ff00', fill: false}]];
        for (const layers of cases) expect(() => render(layers)).not.toThrow();
        expect(() => render([{values: ramp, color: '#00ff00'}], {lo: 5, hi: 5})).not.toThrow();      // zero span
    });
    it('is deterministic', () => {
        const l = [{values: ramp, color: '#33aaff'}];
        expect(same(render(l), render(l))).toBeTrue();
    });
    it('the layer color changes the image (what threshold alerts rely on)', () => {
        expect(same(render([{values: ramp, color: '#33aaff'}]), render([{values: ramp, color: '#ff4d4d'}]))).toBeFalse();
    });
    it('different data changes the image; a filled layer differs from a line-only layer', () => {
        const a = render([{values: ramp, color: '#33aaff'}]);
        expect(same(a, render([{values: ramp.map(v => v / 2), color: '#33aaff'}]))).toBeFalse();
        expect(same(a, render([{values: ramp, color: '#33aaff', fill: false}]))).toBeFalse();
    });
    it('draws a second layer on top of the first', () => {
        const one = render([{values: ramp, color: '#33aaff'}]);
        const two = render([{values: ramp, color: '#33aaff'}, {values: ramp.map(v => 100 - v), color: '#ffaa00', fill: false}]);
        expect(same(one, two)).toBeFalse();
    });
});
