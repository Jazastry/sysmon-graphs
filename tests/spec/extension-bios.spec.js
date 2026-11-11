import {createExtension, item, byClass, find, labelsIn, clickButton, fakeGpus, NV, AMD} from '../helpers/ext-harness.js';
import {makeFakeBios} from '../helpers/fake-bios.js';
import {waitFor} from '../helpers/world.js';

// the "BIOS graphics mode" section of the GPU popovers
describe('extension: BIOS graphics mode', () => {
    let ext, nv, igpu, bios;
    const open = async (opts, gpus) => {
        ext = await createExtension();             // first: it resets the BIOS module to "nothing here"
        bios = await makeFakeBios(opts);
        fakeGpus(ext, gpus);
        ext._sample();
        nv = item(ext, 'gpu'); igpu = item(ext, 'igpu');
    };
    afterEach(() => ext && ext.disable());
    const buttons = it => byClass(it.gfxBox, 'sysmon-perm');
    const labelOf = b => find(b, n => typeof n.text === 'string').map(n => n.text)[0];
    const pick = (it, text) => buttons(it).find(b => labelOf(b).includes(text));

    it('shows nothing on a machine without the BIOS setting', async () => {
        ext = await createExtension();
        fakeGpus(ext); ext._sample();
        item(ext, 'gpu').show();
        expect(item(ext, 'gpu').gfxBox._kids.length).toBe(0);
    });

    it('shows the current mode and one button per BIOS mode, in the NVIDIA popover only', async () => {
        await open();
        nv.show();
        expect(labelsIn(nv.gfxBox)).toContain('BIOS GRAPHICS MODE');
        expect(labelsIn(nv.gfxBox)).toContain('Switchable Graphics');       // the "Current" row
        expect(buttons(nv).map(labelOf)).toEqual(['✔ Switchable Graphics', 'Discrete Graphics', 'UMA Graphics']);
        igpu.show();
        expect(igpu.gfxBox._kids.length).toBe(0);
    });

    it('moves to the integrated GPU popover when there is no NVIDIA GPU (UMA mode), so the way back stays reachable', async () => {
        await open({nvidia: false}, [AMD()]);
        igpu.show();
        expect(buttons(igpu).map(labelOf)).toContain('✔ UMA Graphics');
        expect(nv.gfxBox._kids.length).toBe(0);
    });

    it('clicking a mode asks first: nothing runs, a warning and Change/Cancel appear, the popover stays pinned', async () => {
        await open();
        nv.show();
        clickButton(pick(nv, 'Discrete'));
        expect(bios.calls.length).toBe(0);
        expect(labelsIn(nv.gfxBox).some(t => t.includes('NVIDIA will draw the whole desktop'))).toBeTrue();
        expect(labelsIn(nv.gfxBox)).toContain('Change to Discrete Graphics');
        expect(nv._pinned).toBeTrue();
    });

    it('the UMA warning says NVIDIA will be switched off', async () => {
        await open();
        nv.show();
        clickButton(pick(nv, 'UMA'));
        expect(labelsIn(nv.gfxBox).some(t => t.includes('switched off completely'))).toBeTrue();
    });

    it('Cancel drops the choice without running anything', async () => {
        await open();
        nv.show();
        clickButton(pick(nv, 'Discrete'));
        clickButton(byClass(nv.gfxBox, 'sysmon-link')[0]);
        expect(labelsIn(nv.gfxBox).some(t => t.startsWith('Change to'))).toBeFalse();
        expect(bios.calls.length).toBe(0);
    });

    it('closing the popover also drops a half-made choice', async () => {
        await open();
        nv.show();
        clickButton(pick(nv, 'Discrete'));
        nv.hide();
        expect(nv._gfx.pending).toBeNull();
        expect(bios.calls.length).toBe(0);
    });

    it('confirming runs the privileged change once and then says to reboot', async () => {
        await open();
        nv.show();
        clickButton(pick(nv, 'Discrete'));
        clickButton(byClass(nv.gfxBox, 'sysmon-perm-on').find(b => labelOf(b).startsWith('Change to')));
        expect(await waitFor(() => labelsIn(nv.gfxBox).some(t => t.includes('Reboot to apply')))).toBeTrue();
        expect(bios.calls.length).toBe(1);
        expect(bios.calls[0].slice(-1)[0]).toBe('Discrete Graphics');
    });

    it('a dismissed password dialog changes nothing and says so', async () => {
        await open();
        bios.exitStatus = 126;
        nv.show();
        clickButton(pick(nv, 'Discrete'));
        clickButton(byClass(nv.gfxBox, 'sysmon-perm-on').find(b => labelOf(b).startsWith('Change to')));
        expect(await waitFor(() => labelsIn(nv.gfxBox).includes('Cancelled: nothing was changed.'))).toBeTrue();
    });

    it('a failed write says it failed', async () => {
        await open();
        bios.exitStatus = 1;
        nv.show();
        clickButton(pick(nv, 'Discrete'));
        clickButton(byClass(nv.gfxBox, 'sysmon-perm-on').find(b => labelOf(b).startsWith('Change to')));
        expect(await waitFor(() => labelsIn(nv.gfxBox).some(t => t.startsWith('The change failed')))).toBeTrue();
    });

    it('with a BIOS administrator password there are no buttons, only an explanation', async () => {
        await open({locked: true});
        nv.show();
        expect(buttons(nv).length).toBe(0);
        expect(labelsIn(nv.gfxBox).some(t => t.includes('administrator password'))).toBeTrue();
    });

    it('reminds you of a change that is still waiting for a reboot', async () => {
        await open({pendingReboot: true});
        nv.show();
        expect(labelsIn(nv.gfxBox)).toContain('A BIOS change is waiting for a reboot.');
    });

    it('re-reads the BIOS state every time the popover opens', async () => {
        await open();
        nv.show();
        expect(labelsIn(nv.gfxBox)).not.toContain('A BIOS change is waiting for a reboot.');
        nv.hide();
        bios.setPendingReboot(true);
        nv.show();
        expect(labelsIn(nv.gfxBox)).toContain('A BIOS change is waiting for a reboot.');
    });
});
