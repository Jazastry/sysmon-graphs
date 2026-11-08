import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {EXT_DIR, TESTS_DIR, world, readFile, exists, rmrf} from '../helpers/world.js';

// the project layout and the install script (npm run install-extension)
describe('project', () => {
    const ROOT = GLib.path_get_dirname(TESTS_DIR);
    let meta;
    beforeAll(() => { meta = JSON.parse(readFile(`${EXT_DIR}/metadata.json`)); });

    describe('metadata.json', () => {
        it('has the uuid "sysmon-graphs@jazastry"', () => { expect(meta.uuid).toBe('sysmon-graphs@jazastry'); });
        it('only uses characters GNOME allows in a uuid', () => { expect(meta.uuid).toMatch(/^[-a-zA-Z0-9@._]+$/); });
        it('supports GNOME Shell 46 and has an integer version', () => {
            expect(meta['shell-version']).toContain('46');
            expect(Number.isInteger(meta.version)).toBeTrue();
        });
        it('names a settings schema that ships in schemas/', () => {
            expect(readFile(`${EXT_DIR}/schemas/${meta['settings-schema']}.gschema.xml`)).toContain(`id="${meta['settings-schema']}"`);
        });
        it('every file the extension imports exists', () => {
            for (const f of ['extension.js', 'prefs.js', 'sampler.js', 'gpu.js'])
                for (const m of readFile(`${EXT_DIR}/${f}`).matchAll(/from '\.\/([\w-]+\.js)'/g))
                    expect(exists(`${EXT_DIR}/${m[1]}`)).withContext(`${f} imports ${m[1]}`).toBeTrue();
            expect(exists(`${EXT_DIR}/stylesheet.css`)).toBeTrue();
        });
    });

    describe('package.json', () => {
        let pkg;
        beforeAll(() => { pkg = JSON.parse(readFile(`${ROOT}/package.json`)); });
        it('has the test and install-extension scripts', () => {
            expect(pkg.scripts.test).toBeTruthy();
            expect(pkg.scripts['install-extension']).toBeTruthy();
        });
        it('lists jasmine-core as a dev dependency', () => { expect(pkg.devDependencies['jasmine-core']).toBeTruthy(); });
        it('is git-ignored for node_modules', () => { expect(readFile(`${ROOT}/.gitignore`)).toMatch(/^node_modules\/?$/m); });
        it('keeps the extension in src/ and the specs in tests/', () => {
            expect(exists(`${ROOT}/src/extension.js`)).toBeTrue();
            expect(exists(`${ROOT}/tests/run.sh`)).toBeTrue();
        });
    });

    describe('install script', () => {
        const run = (extDir, extraEnv = []) => {
            const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE});
            launcher.setenv('EXTENSIONS_DIR', extDir, true);
            for (const [k, v] of extraEnv) launcher.setenv(k, v, true);
            const proc = launcher.spawnv(['bash', `${ROOT}/scripts/install-extension.sh`]);
            const [, out] = proc.communicate_utf8(null, null);
            return {status: proc.get_exit_status(), out};
        };
        let dir, n = 0;
        beforeEach(() => { dir = `${world.root}/ext-install-${++n}`; });

        it('copies src/ into <extensions>/<uuid>/ and compiles the schema there', () => {
            const r = run(dir);
            expect(r.status).toBe(0);
            for (const f of ['extension.js', 'prefs.js', 'metadata.json', 'stylesheet.css', 'schemas/gschemas.compiled'])
                expect(exists(`${dir}/sysmon-graphs@jazastry/${f}`)).withContext(f).toBeTrue();
            expect(r.out).toContain('gnome-extensions enable sysmon-graphs@jazastry');
        });
        it('replaces an older install completely (files removed from src/ do not linger)', () => {
            run(dir);
            GLib.file_set_contents(`${dir}/sysmon-graphs@jazastry/stale.js`, 'old');
            run(dir);
            expect(exists(`${dir}/sysmon-graphs@jazastry/stale.js`)).toBeFalse();
            expect(exists(`${dir}/sysmon-graphs@jazastry/extension.js`)).toBeTrue();
        });
        it('tells you about a leftover sysmon-graphs@jasen copy, and leaves it alone', () => {
            GLib.mkdir_with_parents(`${dir}/sysmon-graphs@jasen`, 0o755);
            GLib.file_set_contents(`${dir}/sysmon-graphs@jasen/extension.js`, 'old');
            const r = run(dir);
            expect(r.out).toContain('sysmon-graphs@jasen');
            expect(exists(`${dir}/sysmon-graphs@jasen/extension.js`)).toBeTrue();
        });
        it('does not mention the old copy when there is none', () => {
            expect(run(dir).out).not.toContain('jasen');
        });
    });
});
