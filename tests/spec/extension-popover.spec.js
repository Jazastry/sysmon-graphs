import {createExtension, item, hover, click} from '../helpers/ext-harness.js';
import {sleep, waitFor} from '../helpers/world.js';

// hover opens a popover, leaving closes it; a click pins it open; a second click closes it again
describe('extension: popovers', () => {
    let ext, cpu, ram;
    beforeEach(async () => { ext = await createExtension(); cpu = item(ext, 'cpu'); ram = item(ext, 'ram'); });
    afterEach(() => ext.disable());

    const state = it => ({shown: it.shown, pinned: !!it._pinned});

    it('opens on hover and closes when the pointer leaves', async () => {
        hover(cpu, true);
        expect(await waitFor(() => cpu.shown, 1500)).toBeTrue();
        hover(cpu, false);
        expect(await waitFor(() => !cpu.shown, 2000)).toBeTrue();
    });

    it('a click while hovering pins it: it stays open after the pointer leaves', async () => {
        hover(cpu, true);
        await waitFor(() => cpu.shown, 1500);
        click(cpu);
        expect(state(cpu)).toEqual({shown: true, pinned: true});
        hover(cpu, false);
        await sleep(600);
        expect(cpu.shown).toBeTrue();
    });

    it('hovering another item does not replace a pinned popover', async () => {
        click(cpu);
        hover(ram, true);
        await sleep(400);
        expect(ram.shown).toBeFalse();
        expect(cpu.shown).toBeTrue();
        hover(ram, false);
    });

    it('clicking the pinned item again closes it, and a further click opens and pins it again', () => {
        click(cpu);
        expect(state(cpu)).toEqual({shown: true, pinned: true});
        click(cpu);
        expect(cpu.shown).toBeFalse();
        click(cpu);
        expect(state(cpu)).toEqual({shown: true, pinned: true});
    });

    it('clicking another item moves the pin to it', () => {
        click(cpu);
        click(ram);
        expect(state(ram)).toEqual({shown: true, pinned: true});
        expect(cpu.shown).toBeFalse();
    });

    it('ignores clicks of other mouse buttons', () => {
        click(ram);
        click(ram, 3);
        expect(state(ram)).toEqual({shown: true, pinned: true});
    });

    it('disabling the extension while a popover is open does not throw', () => {
        click(cpu);
        expect(() => ext.disable()).not.toThrow();
        ext.enable();
    });
});
