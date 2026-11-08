import {loadModule} from '../helpers/load.js';
import {world, writeFile, readFile, exists, rmrf} from '../helpers/world.js';

// "Always on NVIDIA": edits launcher entries in the user's applications folder and must undo itself exactly.
describe('perm.js (Always on NVIDIA)', () => {
    let P, dir, n = 0;
    const KITTY = '[Desktop Entry]\nVersion=1.0\nType=Application\nName=kitty\nExec=/home/u/.local/kitty.app/bin/kitty\nIcon=/home/u/kitty.png\nTerminal=false\nCategories=System;TerminalEmulator;\n\n[Desktop Action new-window]\nName=New OS Window\nExec=/home/u/.local/kitty.app/bin/kitty\n';
    const stub = (id, file = null) => ({get_id: () => id, get_filename: () => file});
    // the system entry itself, independent of GLib's (possibly stale) cache of what the user folder holds
    const sysInfo = id => stub(id, `${world.apps}/${id}`);
    const entry = id => readFile(`${dir}/${id}`);

    beforeAll(async () => { P = await loadModule('perm.js'); });
    beforeEach(() => { dir = `${world.root}/perm-${++n}`; });

    describe('classify()', () => {
        it('recognises Chromium-based browsers, Firefox, and everything else', () => {
            for (const c of ['/usr/bin/microsoft-edge-stable', 'google-chrome', '/opt/google/chrome/chrome', 'chromium-browser', 'brave-browser', '/opt/vivaldi/vivaldi', 'opera'])
                expect(P.classify([c, '%U'])).withContext(c).toBe('chromium');
            expect(P.classify(['/usr/lib/firefox/firefox', '%u'])).toBe('firefox');
            for (const c of ['kitty', 'gnome-calculator', 'code', '/usr/bin/chrome-gnome-shell']) expect(P.classify([c])).withContext(c).toBe('other');
        });
        it('sees the program behind a leading env wrapper', () => {
            expect(P.classify(['env', 'BAMF=1', '/snap/bin/chromium', '%U'])).toBe('chromium');
        });
    });

    describe('nvidiaOffloadEnv()', () => {
        it('always sets the render-offload variables', () => {
            const e = P.nvidiaOffloadEnv();
            expect(e.__NV_PRIME_RENDER_OFFLOAD).toBe('1');
            expect(e.__GLX_VENDOR_LIBRARY_NAME).toBe('nvidia');
            expect(e.__VK_LAYER_NV_optimus).toBe('NVIDIA_only');
        });
        it('adds the EGL vendor file only when it exists', () => {
            const has = exists('/usr/share/glvnd/egl_vendor.d/10_nvidia.json');
            expect('__EGL_VENDOR_LIBRARY_FILENAMES' in P.nvidiaOffloadEnv()).toBe(has);
        });
    });

    describe('app with a personal entry (like kitty)', () => {
        beforeEach(() => writeFile(`${dir}/kitty.desktop`, KITTY));

        it('is off at first', () => { expect(P.isPermanent('kitty.desktop', dir)).toBeFalse(); });
        it('edits every Exec line, tags the entry and keeps an exact backup', () => {
            expect(P.enable(stub('kitty.desktop'), dir)).toBe('on');
            const k = entry('kitty.desktop');
            expect(P.isPermanent('kitty.desktop', dir)).toBeTrue();
            expect(k).toContain('X-SysMon-NVIDIA=modified');
            expect((k.match(/^Exec=env __NV_PRIME_RENDER_OFFLOAD=1 .*kitty$/gm) || []).length).toBe(2);   // main entry + action
            expect(k).not.toContain('ozone');                                                              // not a browser
            expect(entry('kitty.desktop.sysmon-backup')).toBe(KITTY);
        });
        it('enabling twice changes nothing more', () => {
            P.enable(stub('kitty.desktop'), dir);
            const once = entry('kitty.desktop');
            expect(P.enable(stub('kitty.desktop'), dir)).toBe('on');
            expect(entry('kitty.desktop')).toBe(once);
        });
        it('switching off restores the original byte for byte and removes the backup', () => {
            P.enable(stub('kitty.desktop'), dir);
            expect(P.disable('kitty.desktop', dir)).toBe('off');
            expect(entry('kitty.desktop')).toBe(KITTY);
            expect(exists(`${dir}/kitty.desktop.sysmon-backup`)).toBeFalse();
            expect(P.isPermanent('kitty.desktop', dir)).toBeFalse();
        });
        it('leaves an entry alone if something else rewrote it meanwhile ("foreign")', () => {
            P.enable(stub('kitty.desktop'), dir);
            writeFile(`${dir}/kitty.desktop`, `${KITTY}# rewritten by the app's updater\n`);
            expect(P.isPermanent('kitty.desktop', dir)).toBeFalse();
            expect(P.disable('kitty.desktop', dir)).toBe('foreign');
            expect(entry('kitty.desktop')).toContain("rewritten by the app's updater");
            expect(exists(`${dir}/kitty.desktop.sysmon-backup`)).toBeFalse();      // stale backup dropped
        });
        it('does not guess when the backup is missing', () => {
            P.enable(stub('kitty.desktop'), dir);
            rmrf(`${dir}/kitty.desktop.sysmon-backup`);
            expect(P.disable('kitty.desktop', dir)).toBe('no-backup');
            expect(P.isPermanent('kitty.desktop', dir)).toBeTrue();                // untouched, user can see it
        });
    });

    describe('app without a personal entry', () => {
        it('creates a tagged copy of the system entry, and deletes it when switched off', () => {
            const info = sysInfo('fake-edge.desktop');
            expect(P.enable(info, dir)).toBe('on');
            const e = entry('fake-edge.desktop');
            expect(e).toContain('X-SysMon-NVIDIA=created');
            expect(exists(`${dir}/fake-edge.desktop.sysmon-backup`)).toBeFalse();
            expect(P.disable('fake-edge.desktop', dir)).toBe('off');
            expect(exists(`${dir}/fake-edge.desktop`)).toBeFalse();
        });
        it('Chromium-based browsers get the XWayland flag right after the program', () => {
            P.enable(sysInfo('fake-edge.desktop'), dir);
            expect(entry('fake-edge.desktop')).toMatch(new RegExp(`Exec=env .* ${world.bin}/microsoft-edge-stable --ozone-platform=x11 %U`));
        });
        it('Firefox gets MOZ_ENABLE_WAYLAND=0 and no flag', () => {
            P.enable(sysInfo('fake-firefox.desktop'), dir);
            const f = entry('fake-firefox.desktop');
            expect(f).toContain('MOZ_ENABLE_WAYLAND=0');
            expect(f).not.toContain('ozone');
        });
        it('turns DBusActivatable off, because D-Bus starts would ignore the Exec line', () => {
            P.enable(sysInfo('fake-dbus.desktop'), dir);
            const e = entry('fake-dbus.desktop');
            expect(e).toContain('DBusActivatable=false');
            expect(e).not.toContain('DBusActivatable=true');
        });
        it('falls back to the system entry when the app info points at a deleted or already edited copy (stale cache)', () => {
            expect(P.enable(stub('fake-edge.desktop', `${dir}/gone/fake-edge.desktop`), dir)).toBe('on');
            const once = entry('fake-edge.desktop');
            expect((once.match(/--ozone-platform=x11/g) || []).length).toBe(1);
            P.disable('fake-edge.desktop', dir);
            // an info that still points at an edited copy must not produce a doubly wrapped entry
            writeFile(`${dir}/edited/fake-edge.desktop`, once);
            expect(P.enable(stub('fake-edge.desktop', `${dir}/edited/fake-edge.desktop`), dir)).toBe('on');
            const again = entry('fake-edge.desktop');
            expect((again.match(/--ozone-platform=x11/g) || []).length).toBe(1);
            expect((again.match(/^Exec=env /gm) || []).length).toBe(1);
        });
        it('reports an error (and writes nothing) for an app with no entry file', () => {
            expect(P.enable(stub('ghost.desktop', null), dir)).toBe('error');
            expect(exists(`${dir}/ghost.desktop`)).toBeFalse();
        });
    });

    it('inserts the flag after an env wrapper and a quoted program path', () => {
        writeFile(`${dir}/q.desktop`, '[Desktop Entry]\nType=Application\nName=Q\nExec=env BAMF_X=1 "/opt/Google Chrome/chrome" %U\n');
        P.enable(stub('q.desktop'), dir);
        expect(entry('q.desktop')).toContain('env BAMF_X=1 "/opt/Google Chrome/chrome" --ozone-platform=x11 %U');
    });
    it('disable() on an app that was never changed is a harmless no-op', () => {
        expect(P.disable('never.desktop', dir)).toBe('off');
    });
});
