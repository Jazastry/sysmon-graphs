import {loadModule} from '../helpers/load.js';
import {sleep} from '../helpers/world.js';

// Runs the real Sampler against this machine's /proc and /sys: checks the shape and ranges of a snapshot.
describe('Sampler (live /proc)', () => {
    let sampler;
    beforeAll(async () => {
        const {Sampler} = await loadModule('sampler.js');
        sampler = new Sampler();
    });
    afterAll(() => sampler.destroy());

    it('produces a complete, sane snapshot', async () => {
        sampler.tick();
        await sleep(1100);
        const snap = sampler.tick();
        sampler.detail(snap, true);
        expect(snap.cpu.pct).toBeGreaterThanOrEqual(0);
        expect(snap.cpu.pct).toBeLessThanOrEqual(100);
        expect(snap.cpu.cores.length).toBeGreaterThan(0);
        expect(snap.mem.total).toBeGreaterThan(0);
        expect(snap.mem.percent).toBeGreaterThan(0);
        expect(snap.mem.percent).toBeLessThanOrEqual(100);
        expect(snap.net.down).toBeGreaterThanOrEqual(0);
        expect(snap.net.up).toBeGreaterThanOrEqual(0);
        expect(snap.disk.readRate).toBeGreaterThanOrEqual(0);
        expect(snap.disk.root.percent).toBeGreaterThan(0);
        expect(snap.cpu.load.length).toBe(3);
        expect(snap.procs.byCpu.length).toBeLessThanOrEqual(5);
        expect(snap.uptime).toBeGreaterThan(0);
        expect(Array.isArray(snap.gpu.gpus)).toBeTrue();
    });
});
