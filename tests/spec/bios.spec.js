import GLib from 'gi://GLib';
import {makeFakeBios} from '../helpers/fake-bios.js';
import {isolateBios} from '../helpers/ext-harness.js';
import {world} from '../helpers/world.js';

// src/bios.js: reading the BIOS graphics mode and the (never executed here) command that changes it
describe('bios graphics mode', () => {
    describe('without the setting', () => {
        it('info() is null on a machine with no think-lmi attribute', async () => {
            const Bios = await isolateBios();
            expect(Bios.info()).toBeNull();
        });
        it('apply() refuses', async () => {
            const Bios = await isolateBios();
            expect(await Bios.apply('Discrete Graphics')).toBe('invalid');
        });
    });

    describe('info()', () => {
        it('lists the BIOS modes', async () => {
            const m = await makeFakeBios();
            expect(m.Bios.info().modes).toEqual(['Switchable Graphics', 'Discrete Graphics', 'UMA Graphics']);
        });
        it('detects switchable mode: panel on the integrated GPU, NVIDIA present', async () => {
            const m = await makeFakeBios({panel: 'amd'});
            expect(m.Bios.info().detected).toBe('Switchable Graphics');
        });
        it('detects discrete mode: panel on NVIDIA (an external screen on NVIDIA does not matter)', async () => {
            const m = await makeFakeBios({panel: 'nvidia'});
            expect(m.Bios.info().detected).toBe('Discrete Graphics');
        });
        it('detects UMA mode: no NVIDIA GPU at all', async () => {
            const m = await makeFakeBios({nvidia: false});
            expect(m.Bios.info().detected).toBe('UMA Graphics');
        });
        it('reports unknown (null) when no panel is connected', async () => {
            const m = await makeFakeBios();
            GLib.spawn_command_line_sync(`sh -c "echo disconnected > '${m.root}/drm/card2-eDP-1/status'"`);
            expect(m.Bios.info().detected).toBeNull();
        });
        it('reports an administrator password and a pending reboot', async () => {
            const m = await makeFakeBios({locked: true, pendingReboot: true});
            expect(m.Bios.info().locked).toBeTrue();
            expect(m.Bios.info().pendingReboot).toBeTrue();
        });
        it('drops mode names with unsafe characters (they would end up in a root command)', async () => {
            const m = await makeFakeBios({modes: 'Switchable Graphics;x"; rm -rf /;Discrete Graphics'});
            expect(m.Bios.info().modes).toEqual(['Switchable Graphics', 'Discrete Graphics']);
        });
    });

    describe('kind()', () => {
        it('classifies the mode names', async () => {
            const Bios = await isolateBios();
            expect(Bios.kind('Discrete Graphics')).toBe('discrete');
            expect(Bios.kind('UMA Graphics')).toBe('uma');
            expect(Bios.kind('Integrated Graphics')).toBe('uma');
            expect(Bios.kind('Switchable Graphics')).toBe('switchable');
            expect(Bios.kind('Something else')).toBe('other');
        });
    });

    describe('apply()', () => {
        it('asks pkexec to run one fixed script with the mode as an argument, and reports ok', async () => {
            const m = await makeFakeBios();
            expect(await m.Bios.apply('Discrete Graphics')).toBe('ok');
            expect(m.calls.length).toBe(1);
            const argv = m.calls[0];
            expect(argv.slice(0, 3)).toEqual(['pkexec', '/bin/sh', '-c']);
            expect(argv.slice(4)).toEqual(['sysmon-bios', 'Discrete Graphics']);
            expect(argv[3]).toContain(`${m.root}/fw/attributes/GraphicsDevice`);
            expect(argv[3]).not.toContain('Discrete');                // the value is never pasted into the script
        });
        it('the root script itself writes only a value from the BIOS list', async () => {
            const m = await makeFakeBios();
            await m.Bios.apply('UMA Graphics');
            const script = m.calls[0][3];
            const run = value => GLib.spawn_sync(null, ['/bin/sh', '-c', script, 'sysmon-bios', value], null, GLib.SpawnFlags.SEARCH_PATH, null)[3] >> 8;   // wait status -> exit code
            const cur = () => m.read('attributes/GraphicsDevice/current_value').trim();
            expect(run('Discrete Graphics')).toBe(0);
            expect(cur()).toBe('Discrete Graphics');
            expect(run('Bogus; echo hi')).toBe(2);
            expect(run('')).toBe(2);
            expect(run('Discrete')).toBe(2);                           // only whole entries
            expect(cur()).toBe('Discrete Graphics');
        });
        it('refuses a mode the BIOS does not list, without running anything', async () => {
            const m = await makeFakeBios();
            expect(await m.Bios.apply('Turbo Graphics')).toBe('invalid');
            expect(m.calls.length).toBe(0);
        });
        it('refuses when a BIOS administrator password is set, without running anything', async () => {
            const m = await makeFakeBios({locked: true});
            expect(await m.Bios.apply('Discrete Graphics')).toBe('locked');
            expect(m.calls.length).toBe(0);
        });
        it('maps pkexec exit codes: 126 and 127 mean cancelled, 2 invalid, anything else an error', async () => {
            const m = await makeFakeBios();
            for (const [status, result] of [[126, 'cancelled'], [127, 'cancelled'], [2, 'invalid'], [1, 'error'], [-1, 'error']]) {
                m.exitStatus = status;
                expect(await m.Bios.apply('Discrete Graphics')).withContext(`status ${status}`).toBe(result);
            }
        });
        it('says so when pkexec does not exist', async () => {
            const m = await makeFakeBios();
            m.Bios.cfg.pkexec = null;
            const saved = GLib.getenv('PATH');
            GLib.setenv('PATH', `${world.root}/empty`, true);
            try { expect(await m.Bios.apply('Discrete Graphics')).toBe('no-pkexec'); }
            finally { GLib.setenv('PATH', saved, true); }
            expect(m.calls.length).toBe(0);
        });
    });
});
