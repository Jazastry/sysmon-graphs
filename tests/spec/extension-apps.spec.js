import Gio from 'gi://Gio';
import {createExtension, item, byClass, find, labelsIn, clickButton} from '../helpers/ext-harness.js';
import {runningApps} from '../helpers/gnome-stubs.js';
import {world, readFile, exists, waitFor, rmrf} from '../helpers/world.js';

// the "Apps on the dedicated GPU" list in the NVIDIA popover
describe('extension: apps on NVIDIA', () => {
    let ext, g;
    const info = id => Gio.DesktopAppInfo.new(id);
    const out = name => readFile(`${world.out}/${name}.txt`);
    const appLines = () => byClass(g.appBox, 'sysmon-app-line');
    const names = () => find(g.appBox, n => n.style_class === 'sysmon-app-name').map(n => n.text);
    const clear = () => { for (const f of ['microsoft-edge-stable', 'firefox', 'sysmon-test-app']) rmrf(`${world.out}/${f}.txt`); };

    beforeEach(async () => {
        ext = await createExtension();
        g = item(ext, 'gpu');
        clear();
        rmrf(world.userApps); Gio.File.new_for_path(world.userApps).make_directory_with_parents(null);
    });
    afterEach(() => ext.disable());

    describe('list management', () => {
        it('starts empty, with a hint and an "Add app" link', () => {
            expect(labelsIn(g.appBox)).toContain('No apps added yet.');
            expect(byClass(g.appBox, 'sysmon-link').length).toBe(1);
        });
        it('"Add app" opens a picker of installed apps and keeps the popover pinned', () => {
            g.show();
            clickButton(byClass(g.appBox, 'sysmon-link')[0]);
            expect(g._picking).toBeTrue();
            expect(g._pinned).toBeTrue();
            expect(names()).toContain('Fake App');
        });
        it('choosing an app stores it and shows a row', () => {
            g.show();
            clickButton(byClass(g.appBox, 'sysmon-link')[0]);
            const pick = byClass(g.appBox, 'sysmon-app').find(b => find(b, n => n.style_class === 'sysmon-app-name').some(n => n.text === 'Fake App'));
            clickButton(pick);
            expect(ext.settings.get_strv('gpu-apps')).toEqual(['fake-app.desktop']);
            expect(g._picking).toBeFalse();
            expect(appLines().length).toBe(1);
            expect(names()).toContain('Fake App');
        });
        it('apps already in the list are not offered again', () => {
            ext.settings.set_strv('gpu-apps', ['fake-app.desktop']);
            g.show();
            clickButton(byClass(g.appBox, 'sysmon-link')[0]);
            const picker = byClass(g.appBox, 'sysmon-picker-wrap')[0] || byClass(g.appBox, 'sysmon-picker')[0];
            expect(picker).toBeDefined();
            const offered = find(picker, n => n.style_class === 'sysmon-app-name').map(n => n.text);
            expect(offered.length).toBeGreaterThan(0);
            expect(offered).not.toContain('Fake App');
            expect(offered).toContain('Fake Firefox');
        });
        it('the x button removes the app', () => {
            ext.settings.set_strv('gpu-apps', ['fake-app.desktop']);
            g.show();
            clickButton(byClass(g.appBox, 'sysmon-app-remove')[0]);
            expect(ext.settings.get_strv('gpu-apps')).toEqual([]);
            expect(appLines().length).toBe(0);
        });
        it('Cancel and closing the popover both leave the picker', () => {
            g.show();
            clickButton(byClass(g.appBox, 'sysmon-link')[0]);
            expect(g._picking).toBeTrue();
            g.hide();
            expect(g._picking).toBeFalse();
        });
    });

    describe('launching', () => {
        it('starts a generic app with the offload variables only, and closes the popover', async () => {
            ext.settings.set_strv('gpu-apps', ['fake-app.desktop']);
            g.show();
            clickButton(byClass(g.appBox, 'sysmon-app')[0]);
            expect(await waitFor(() => out('sysmon-test-app') !== null)).toBeTrue();
            const o = out('sysmon-test-app');
            expect(o).toContain('__NV_PRIME_RENDER_OFFLOAD=1');
            expect(o).toContain('__GLX_VENDOR_LIBRARY_NAME=nvidia');
            expect(o).not.toContain('GDK_BACKEND');
            expect(g.shown).toBeFalse();
        });
        it('starts a Chromium-based browser through XWayland (exactly one flag)', async () => {
            g._launch(info('fake-edge.desktop'));
            expect(await waitFor(() => out('microsoft-edge-stable') !== null)).toBeTrue();
            const o = out('microsoft-edge-stable');
            expect(o).toContain('__NV_PRIME_RENDER_OFFLOAD=1');
            expect((o.match(/--ozone-platform=x11/g) || []).length).toBe(1);
        });
        it('starts Firefox with Wayland switched off', async () => {
            g._launch(info('fake-firefox.desktop'));
            expect(await waitFor(() => out('firefox') !== null)).toBeTrue();
            const o = out('firefox');
            expect(o).toContain('MOZ_ENABLE_WAYLAND=0');
            expect(o).toContain('--new-window');
        });
        it('does not launch an app that is already running; it shows a warning instead', async () => {
            runningApps.add('fake-edge.desktop');
            g.show();
            g._launch(info('fake-edge.desktop'));
            expect(labelsIn(g.appBox).some(t => t.includes('already running'))).toBeTrue();
            expect(g.shown).toBeTrue();
            expect(out('microsoft-edge-stable')).toBeNull();
            g.hide();
            expect(labelsIn(g.appBox).some(t => t.includes('already running'))).toBeFalse();
        });
    });

    describe('"Always" toggle', () => {
        const always = () => byClass(g.appBox, 'sysmon-perm');
        const userEntry = id => readFile(`${world.userApps}/${id}`);

        beforeEach(() => ext.settings.set_strv('gpu-apps', ['fake-edge.desktop', 'fake-app.desktop']));

        it('every listed app gets an Always button, off at first', () => {
            expect(always().length).toBe(2);
            expect(byClass(g.appBox, 'sysmon-perm-on').length).toBe(0);
        });
        it('switching on writes the launcher entry; switching off removes it', () => {
            clickButton(always()[0]);
            expect(userEntry('fake-edge.desktop')).toContain('X-SysMon-NVIDIA=created');
            expect(byClass(g.appBox, 'sysmon-perm-on').length).toBe(1);
            expect(labelsIn(g.appBox)).toContain('✔ Always');
            clickButton(always()[0]);
            expect(userEntry('fake-edge.desktop')).toBeNull();
            expect(byClass(g.appBox, 'sysmon-perm-on').length).toBe(0);
        });
        it('removing an app from the list also undoes Always', () => {
            clickButton(always()[0]);
            expect(exists(`${world.userApps}/fake-edge.desktop`)).toBeTrue();
            clickButton(byClass(g.appBox, 'sysmon-app-remove')[0]);
            expect(exists(`${world.userApps}/fake-edge.desktop`)).toBeFalse();
            expect(ext.settings.get_strv('gpu-apps')).toEqual(['fake-app.desktop']);
        });
        it('an app with Always on is launched from its own entry, without doubling the flag', async () => {
            clickButton(always()[0]);
            g._launch(info('fake-edge.desktop'));
            expect(await waitFor(() => out('microsoft-edge-stable') !== null)).toBeTrue();
            expect((out('microsoft-edge-stable').match(/--ozone-platform=x11/g) || []).length).toBe(1);
        });
        it('warns that a terminal passes NVIDIA on to what it starts', () => {
            ext.settings.set_strv('gpu-apps', ['fake-term.desktop']);
            clickButton(always()[0]);
            expect(labelsIn(g.appBox).some(t => t.includes('will also use NVIDIA'))).toBeTrue();
            clickButton(always()[0]);
            expect(labelsIn(g.appBox).some(t => t.includes('will also use NVIDIA'))).toBeFalse();
        });
    });
});
