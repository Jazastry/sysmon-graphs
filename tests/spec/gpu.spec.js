import {loadModule} from '../helpers/load.js';
import {sleep, waitFor} from '../helpers/world.js';
import {makeFakeMachine} from '../helpers/fake-gpu.js';

describe('GpuSampler', () => {
    let GpuSampler, m, s;
    const nvidia = gs => gs.find(g => g.kind === 'nvidia');
    const amd = gs => gs.find(g => g.kind === 'amd');

    beforeAll(async () => { ({GpuSampler} = await loadModule('gpu.js')); });
    beforeEach(() => {
        m = makeFakeMachine(`gpu-${Math.random().toString(36).slice(2)}`);
        s = new GpuSampler({pciRoot: m.pciRoot, smiPath: m.smiPath, noMode: true});
    });
    afterEach(() => s.destroy());

    it('finds display controllers only (the audio device is ignored)', () => {
        const gs = s.poll(100);
        expect(gs.map(g => g.kind).sort()).toEqual(['amd', 'nvidia']);
    });

    describe('AMD', () => {
        it('reads load, VRAM, GTT and temperature from sysfs', () => {
            const g = amd(s.poll(100));
            expect(g.state).toBe('active');
            expect(g.load).toBe(17);
            expect(g.memUsed).toBe(512 * 1048576);
            expect(g.memTotal).toBe(1024 * 1048576);
            expect(g.extra.gttTotal).toBe(8192 * 1048576);
            expect(g.temp).toBe(48);
        });
    });

    describe('NVIDIA in Performance mode (power control = on)', () => {
        beforeEach(() => m.setNvidiaPower('on', 'active'));

        it('reports the first reading as in flight, then real values from nvidia-smi', async () => {
            expect(nvidia(s.poll(100)).load).toBe(0);
            expect(await waitFor(() => m.calls() === 1)).toBeTrue();
            await sleep(100);
            const g = nvidia(s.poll(101));
            expect(g.state).toBe('active');
            expect(g.load).toBe(37);
            expect(g.memUsed).toBe(2048 * 1048576);
            expect(g.memTotal).toBe(16311 * 1048576);
            expect(g.temp).toBe(52);
            expect(g.power).toBeCloseTo(33.4, 5);
            expect(g.name).toBe('NVIDIA GeForce RTX 5060 Ti');
        });
        it('polls again after 2 seconds, not before', async () => {
            s.poll(100); await waitFor(() => m.calls() === 1); await sleep(100);
            s.poll(101); await sleep(150);
            expect(m.calls()).toBe(1);
            s.poll(102.1); await waitFor(() => m.calls() === 2);
            expect(m.calls()).toBe(2);
        });
    });

    describe('NVIDIA in Hybrid mode (power control = auto)', () => {
        it('never calls nvidia-smi while the card is asleep (it would wake it)', async () => {
            m.setNvidiaPower('auto', 'suspended');
            for (const t of [100, 102, 104, 120]) expect(nvidia(s.poll(t)).state).toBe('asleep');
            await sleep(200);
            expect(m.calls()).toBe(0);
            m.setNvidiaPower('auto', 'suspending');
            expect(nvidia(s.poll(130)).state).toBe('asleep');
        });
        it('backs off to 15 s while awake but idle, so polling itself does not keep the card awake', async () => {
            m.setNvidiaPower('auto', 'active');
            m.setSmi('NVIDIA GeForce RTX 5060 Ti, 0, 10, 16311, 40, 5.0');
            s.poll(200); await waitFor(() => m.calls() === 1); await sleep(100);
            const g = nvidia(s.poll(202));
            expect(g.extra.idleBackoff).toBeTrue();
            s.poll(204); s.poll(210); await sleep(300);
            expect(m.calls()).toBe(1);                                   // nothing during the back-off
            s.poll(218); await waitFor(() => m.calls() === 2);
            expect(m.calls()).toBe(2);                                   // one after 15 s
        });
        it('polls every 2 s when awake and busy', async () => {
            m.setNvidiaPower('auto', 'active');
            m.setSmi('NVIDIA GeForce RTX 5060 Ti, 60, 4000, 16311, 60, 40.0');
            s.poll(300); await waitFor(() => m.calls() === 1); await sleep(100);
            expect(nvidia(s.poll(301)).extra.idleBackoff).toBeFalse();
            s.poll(302.1); await waitFor(() => m.calls() === 2);
            expect(m.calls()).toBe(2);
        });
        it('forgets stale readings after sleeping', async () => {
            m.setNvidiaPower('on', 'active');
            s.poll(100); await waitFor(() => m.calls() === 1); await sleep(100);
            expect(nvidia(s.poll(101)).load).toBe(37);
            m.setNvidiaPower('auto', 'suspended');
            expect(nvidia(s.poll(110)).load).toBeNull();
            m.setNvidiaPower('on', 'active');
            expect(nvidia(s.poll(111)).load).toBe(0);                    // first reading in flight again
        });
    });

    describe('NVIDIA without a usable driver', () => {
        it('no driver bound (integrated-only mode)', () => {
            m.setNvidiaDriver(null);
            expect(nvidia(s.poll(100)).state).toBe('off');
        });
        it('nouveau', () => {
            m.setNvidiaDriver('nouveau');
            expect(nvidia(s.poll(100)).state).toBe('nouveau');
        });
        it('some other driver', () => {
            m.setNvidiaDriver('vfio-pci');
            expect(nvidia(s.poll(100)).state).toBe('other');
        });
        it('a nvidia-smi path that cannot be started does not break polling', async () => {
            const noSmi = new GpuSampler({pciRoot: m.pciRoot, smiPath: `${m.root}/does-not-exist`, noMode: true});
            m.setNvidiaPower('on', 'active');
            noSmi.poll(100);
            await sleep(150);
            expect(() => noSmi.poll(103)).not.toThrow();
            expect(['no-tools', 'active']).toContain(nvidia(noSmi.poll(103)).state);
            noSmi.destroy();
        });
    });

    it('destroy() stops the sampler without errors, even with a query in flight', () => {
        m.setNvidiaPower('on', 'active');
        s.poll(100);
        expect(() => s.destroy()).not.toThrow();
    });
});
