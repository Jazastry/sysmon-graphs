import {loadModule} from '../helpers/load.js';

describe('stats.js parsers', () => {
    let S;
    beforeAll(async () => { S = await loadModule('stats.js'); });

    describe('CPU', () => {
        const stat = 'cpu  100 0 100 700 100 0 0 0 0 0\ncpu0 50 0 50 350 50 0 0 0 0 0\ncpu1 50 0 50 350 50 0 0 0 0 0\nintr 1 2 3\n';
        it('parses the total and each core', () => {
            const r = S.parseCpuStat(stat);
            expect(r.cores.length).toBe(2);
            expect(r.total).toEqual({total: 1000, busy: 200});      // idle + iowait (800) are not busy
        });
        it('computes the busy percentage between two samples', () => {
            const a = {total: 1000, busy: 200}, b = {total: 1200, busy: 300};
            expect(S.cpuPercent(a, b)).toBeCloseTo(50, 5);
        });
        it('is 0 without a previous sample or without elapsed time', () => {
            expect(S.cpuPercent(null, {total: 1, busy: 1})).toBe(0);
            expect(S.cpuPercent({total: 5, busy: 1}, {total: 5, busy: 3})).toBe(0);
        });
        it('is clamped to 0..100', () => {
            expect(S.cpuPercent({total: 0, busy: 0}, {total: 10, busy: 50})).toBe(100);
            expect(S.cpuPercent({total: 0, busy: 50}, {total: 10, busy: 0})).toBe(0);
        });
        it('reads the model name', () => {
            expect(S.parseCpuModel('processor : 0\nmodel name\t: AMD  Ryzen 7   7840HS\n')).toBe('AMD Ryzen 7 7840HS');
            expect(S.parseCpuModel('nothing here')).toBe('CPU');
        });
    });

    describe('memory', () => {
        const mem = 'MemTotal: 16000000 kB\nMemFree: 2000000 kB\nMemAvailable: 8000000 kB\nBuffers: 100000 kB\nCached: 3000000 kB\nSReclaimable: 500000 kB\nSwapTotal: 4000000 kB\nSwapFree: 3000000 kB\n';
        it('uses MemAvailable for "used" and converts kB to bytes', () => {
            const m = S.parseMeminfo(mem);
            expect(m.total).toBe(16000000 * 1024);
            expect(m.used).toBe(8000000 * 1024);
            expect(m.percent).toBeCloseTo(50, 5);
            expect(m.cached).toBe(3500000 * 1024);
            expect(m.swapUsed).toBe(1000000 * 1024);
        });
        it('falls back to MemFree when MemAvailable is missing and survives empty input', () => {
            expect(S.parseMeminfo('MemTotal: 100 kB\nMemFree: 40 kB\n').used).toBe(60 * 1024);
            expect(S.parseMeminfo('').percent).toBe(0);
        });
    });

    describe('network', () => {
        const net = 'Inter-|   Receive                                                |  Transmit\n face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n' +
            '    lo: 1000 1 0 0 0 0 0 0 1000 1 0 0 0 0 0 0\n  wlp1: 5000 5 0 0 0 0 0 0 2000 2 0 0 0 0 0 0\ndocker0: 9000 9 0 0 0 0 0 0 9000 9 0 0 0 0 0 0\n  eth0: 100 1 0 0 0 0 0 0 50 1 0 0 0 0 0 0\n';
        it('sums real interfaces only (no loopback, docker, veth...)', () => {
            const n = S.parseNetDev(net);
            expect(n.rx).toBe(5100);
            expect(n.tx).toBe(2050);
            expect(Object.keys(n.ifaces).sort()).toEqual(['docker0', 'eth0', 'lo', 'wlp1']);
        });
    });

    describe('disk', () => {
        const ds = '   8   0 sda 100 0 2000 0 50 0 4000 0 0 0 0\n   8   1 sda1 100 0 1000 0 50 0 1000 0 0 0 0\n 259   0 nvme0n1 10 0 100 0 5 0 300 0 0 0 0\n 259   1 nvme0n1p1 10 0 100 0 5 0 300 0 0 0 0\n   7   0 loop0 1 0 8 0 0 0 0 0 0 0 0\n';
        it('counts whole disks only, in bytes (512-byte sectors)', () => {
            const d = S.parseDiskstats(ds);
            expect(d.read).toBe((2000 + 100) * 512);
            expect(d.write).toBe((4000 + 300) * 512);
        });
        it('keeps real filesystems, skips snaps and duplicates', () => {
            const m = S.parseMounts('/dev/nvme0n1p2 / ext4 rw 0 0\n/dev/loop3 /snap/core/1 squashfs ro 0 0\nproc /proc proc rw 0 0\n/dev/nvme0n1p2 /var/lib/x ext4 rw 0 0\n/dev/sdb1 /mnt/my\\040disk exfat rw 0 0\n');
            expect(m.map(x => x.mount)).toEqual(['/', '/mnt/my disk']);
        });
    });

    describe('processes and misc', () => {
        it('parses /proc/<pid>/stat with spaces and parentheses in the name', () => {
            const t = '1234 (my (weird) app) S 1 1 1 0 -1 4194560 100 0 0 0 70 30 0 0 20 0 1 0 100 1000 100 18446744073709551615';
            expect(S.parseProcStat(t)).toEqual({pid: 1234, comm: 'my (weird) app', ticks: 100});
            expect(S.parseProcStat('garbage')).toBeNull();
        });
        it('reads resident pages from statm', () => { expect(S.parseStatmRss('100 25 10 0 0 0 0', 4096)).toBe(25 * 4096); });
        it('parses loadavg and uptime', () => {
            expect(S.parseLoadavg('0.50 1.25 2.00 1/200 999\n')).toEqual([0.5, 1.25, 2]);
            expect(S.parseUptime('12345.67 54321.00\n')).toBeCloseTo(12345.67, 2);
        });
        it('picks the best CPU temperature sensor', () => {
            const sensors = [{chip: 'nvme', label: 'Composite', value: 40}, {chip: 'acpitz', label: 'temp1', value: 50},
                             {chip: 'k10temp', label: 'Tctl', value: 61}, {chip: 'k10temp', label: 'Tccd1', value: 55}];
            expect(S.pickCpuSensor(sensors).label).toBe('Tctl');
            expect(S.pickCpuSensor([{chip: 'nvme', label: 'x', value: 1}])).toBeNull();
            expect(S.pickCpuSensor([{chip: 'coretemp', label: 'Core 0'}, {chip: 'coretemp', label: 'Package id 0'}]).label).toBe('Package id 0');
        });
    });

    describe('formatting', () => {
        it('fmtRate', () => {
            expect(S.fmtRate(0)).toBe('0B');
            expect(S.fmtRate(1536)).toBe('1.5K');
            expect(S.fmtRate(150 * 1024)).toBe('150K');
            expect(S.fmtRate(5 * 1048576)).toBe('5.0M');
        });
        it('fmtBytes', () => {
            expect(S.fmtBytes(512)).toBe('512 B');
            expect(S.fmtBytes(1536)).toBe('1.5 KiB');
            expect(S.fmtBytes(3 * 2 ** 30)).toBe('3.0 GiB');
        });
        it('fmtUptime', () => {
            expect(S.fmtUptime(59)).toBe('0m');
            expect(S.fmtUptime(3 * 3600 + 120)).toBe('3h 2m');
            expect(S.fmtUptime(2 * 86400 + 3600)).toBe('2d 1h 0m');
        });
    });

    describe('GPU helpers', () => {
        it('parses nvidia-smi csv output (units to bytes)', () => {
            const r = S.parseNvidiaSmi('NVIDIA GeForce RTX 5060 Ti, 37, 2048, 16311, 52, 33.40\n');
            expect(r).toEqual([{name: 'NVIDIA GeForce RTX 5060 Ti', load: 37, memUsed: 2048 * 1048576, memTotal: 16311 * 1048576, temp: 52, power: 33.4}]);
        });
        it('keeps commas in the name and maps [N/A] to null', () => {
            const r = S.parseNvidiaSmi('Weird, Name, 5, 100, 200, [N/A], [Not Supported]\n')[0];
            expect(r.name).toBe('Weird, Name');
            expect(r.temp).toBeNull();
            expect(r.power).toBeNull();
        });
        it('looks names up in pci.ids, preferring the bracketed marketing name', () => {
            const ids = '# c\n10de  NVIDIA Corporation\n\t2d59  GB206 [GeForce RTX 5060 Ti]\n\t2d60  Other\n1002  Advanced Micro Devices, Inc. [AMD/ATI]\n\t164e  Raphael\n';
            expect(S.pciName(ids, '10de', '2d59')).toBe('GeForce RTX 5060 Ti');
            expect(S.pciName(ids, '1002', '164e')).toBe('Raphael');
            expect(S.pciName(ids, '1002', 'ffff')).toBeNull();
            expect(S.pciName(ids, '8086', '0001')).toBeNull();
        });
        it('has a label for every PRIME mode', () => {
            for (const m of ['nvidia', 'on-demand', 'intel']) expect(S.PRIME_MODES[m]).toBeTruthy();
        });
    });
});
