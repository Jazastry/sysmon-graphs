// Reads system statistics. Only depends on GLib/Gio and the pure parsers in stats.js.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import * as S from './stats.js';
import {readText, listDir} from './util.js';
import {GpuSampler} from './gpu.js';

const CLK_TCK = 100;   // USER_HZ is 100 on every mainstream Linux build

const now = () => GLib.get_monotonic_time() / 1e6;

export function readSensors() {
    const temps = [];
    const fans = [];
    for (const hw of listDir('/sys/class/hwmon').sort()) {
        const base = `/sys/class/hwmon/${hw}`;
        const chip = readText(`${base}/name`).trim() || hw;
        for (const f of listDir(base).sort()) {
            let m = f.match(/^temp(\d+)_input$/);
            if (m) {
                const v = parseInt(readText(`${base}/${f}`), 10);
                if (isNaN(v)) continue;
                const label = readText(`${base}/temp${m[1]}_label`).trim() || `temp${m[1]}`;
                temps.push({chip, label, value: v / 1000, path: `${base}/${f}`});
                continue;
            }
            m = f.match(/^fan(\d+)_input$/);
            if (m) {
                const v = parseInt(readText(`${base}/${f}`), 10);
                if (!isNaN(v)) fans.push({chip, label: readText(`${base}/fan${m[1]}_label`).trim() || `fan${m[1]}`, rpm: v});
            }
        }
    }
    if (!temps.length) {
        for (const z of listDir('/sys/class/thermal').filter(n => n.startsWith('thermal_zone')).sort()) {
            const base = `/sys/class/thermal/${z}`;
            const v = parseInt(readText(`${base}/temp`), 10);
            if (isNaN(v)) continue;
            const type = readText(`${base}/type`).trim() || z;
            temps.push({chip: type, label: type, value: v / 1000, path: `${base}/temp`});
        }
    }
    return {temps, fans};
}

function fsUsage(mount) {
    try {
        const info = Gio.File.new_for_path(mount).query_filesystem_info(
            'filesystem::size,filesystem::free,filesystem::used', null);
        const size = info.get_attribute_uint64('filesystem::size');
        const free = info.get_attribute_uint64('filesystem::free');
        let used = info.has_attribute('filesystem::used') ? info.get_attribute_uint64('filesystem::used') : size - free;
        const avail = used + free;                 // same basis as `df`: used / (used + available)
        return {used, total: size, percent: avail ? used / avail * 100 : 0};
    } catch (e) {
        return null;
    }
}

export class Sampler {
    constructor() {
        this._cpu = null;
        this._net = null;
        this._disk = null;
        this._tempPath = undefined;
        this._tempRetry = 0;
        this._procs = null;       // Map pid -> ticks, for per-process CPU deltas
        this._procsTime = 0;
        this._procResult = null;
        this.cpuModel = S.parseCpuModel(readText('/proc/cpuinfo'));
        this.gpu = new GpuSampler();
        this.pageSize = 4096;
    }

    // Cheap values for the panel (called every second).
    tick() {
        const t = now();
        const snap = {time: t};

        // CPU
        const cpu = S.parseCpuStat(readText('/proc/stat'));
        snap.cpu = {pct: 0, cores: [], model: this.cpuModel};
        if (this._cpu) {
            snap.cpu.pct = S.cpuPercent(this._cpu.total, cpu.total);
            snap.cpu.cores = cpu.cores.map((c, i) => S.cpuPercent(this._cpu.cores[i], c));
        } else {
            snap.cpu.cores = cpu.cores.map(() => 0);
        }
        this._cpu = cpu;

        // Memory
        snap.mem = S.parseMeminfo(readText('/proc/meminfo'));

        // Network
        const net = S.parseNetDev(readText('/proc/net/dev'));
        snap.net = {down: 0, up: 0, totalRx: net.rx, totalTx: net.tx, ifaces: []};
        const dt = this._net ? t - this._net.time : 0;
        if (this._net && dt > 0) {
            snap.net.down = Math.max(0, (net.rx - this._net.rx) / dt);
            snap.net.up = Math.max(0, (net.tx - this._net.tx) / dt);
        }
        for (const [name, v] of Object.entries(net.ifaces)) {
            const p = this._net && this._net.ifaces[name];
            snap.net.ifaces.push({
                name, rx: v.rx, tx: v.tx,
                rxRate: p && dt > 0 ? Math.max(0, (v.rx - p.rx) / dt) : 0,
                txRate: p && dt > 0 ? Math.max(0, (v.tx - p.tx) / dt) : 0,
            });
        }
        this._net = {rx: net.rx, tx: net.tx, ifaces: net.ifaces, time: t};

        // Disk I/O + root usage
        const dk = S.parseDiskstats(readText('/proc/diskstats'));
        snap.disk = {readRate: 0, writeRate: 0, root: fsUsage('/'), mounts: null};
        if (this._disk) {
            const ddt = t - this._disk.time;
            if (ddt > 0) {
                snap.disk.readRate = Math.max(0, (dk.read - this._disk.read) / ddt);
                snap.disk.writeRate = Math.max(0, (dk.write - this._disk.write) / ddt);
            }
        }
        this._disk = {read: dk.read, write: dk.write, time: t};

        // CPU temperature (discover the sensor once, then read just that file)
        snap.temp = {cpu: this._readCpuTemp(), sensors: null, fans: null};

        // GPUs (never wakes a sleeping NVIDIA card)
        snap.gpu = {gpus: this.gpu.poll(t), mode: this.gpu.mode};
        return snap;
    }

    _readCpuTemp() {
        if (this._tempPath === undefined || (this._tempPath === null && ++this._tempRetry % 30 === 0)) {
            const {temps} = readSensors();
            const s = S.pickCpuSensor(temps);
            this._tempPath = s ? s.path : null;
            return s ? s.value : null;
        }
        if (!this._tempPath) return null;
        const v = parseInt(readText(this._tempPath), 10);
        if (isNaN(v)) { this._tempPath = undefined; return null; }
        return v / 1000;
    }

    // Extra, more expensive values for the popovers (only while one is open).
    detail(snap, withProcs) {
        snap.cpu.load = S.parseLoadavg(readText('/proc/loadavg'));
        snap.uptime = S.parseUptime(readText('/proc/uptime'));

        let sum = 0, n = 0;
        for (let i = 0; i < snap.cpu.cores.length; i++) {
            const kHz = parseInt(readText(`/sys/devices/system/cpu/cpu${i}/cpufreq/scaling_cur_freq`), 10);
            if (!isNaN(kHz)) { sum += kHz; n++; }
        }
        snap.cpu.freqGHz = n ? sum / n / 1e6 : null;

        const mounts = S.parseMounts(readText('/proc/mounts'));
        snap.disk.mounts = [];
        for (const m of mounts) {
            const u = fsUsage(m.mount);
            if (u && u.total > 0) snap.disk.mounts.push({...m, ...u});
        }

        const sensors = readSensors();
        snap.temp.sensors = sensors.temps;
        snap.temp.fans = sensors.fans;

        if (withProcs) this._procResult = this._scanProcs(snap.cpu.cores.length || 1);
        snap.procs = this._procResult;
        return snap;
    }

    destroy() {
        this.gpu.destroy();
    }

    hasProcBaseline() {
        return this._procs !== null;
    }

    _scanProcs(ncores) {
        const t = now();
        const prev = this._procs;
        const dt = t - this._procsTime;
        const cur = new Map();
        const groups = new Map();
        for (const name of listDir('/proc')) {
            if (!/^\d+$/.test(name)) continue;
            const p = S.parseProcStat(readText(`/proc/${name}/stat`));
            if (!p) continue;
            const rss = S.parseStatmRss(readText(`/proc/${name}/statm`), this.pageSize);
            cur.set(p.pid, p.ticks);
            let g = groups.get(p.comm);
            if (!g) { g = {name: p.comm, count: 0, cpu: 0, rss: 0}; groups.set(p.comm, g); }
            g.count++;
            g.rss += rss || 0;
            const before = prev ? prev.get(p.pid) : undefined;
            if (before !== undefined && dt > 0)
                g.cpu += Math.max(0, (p.ticks - before) / CLK_TCK / dt * 100 / ncores);   // % of total CPU
        }
        this._procs = cur;
        this._procsTime = t;
        const all = [...groups.values()];
        return {
            measured: prev !== null,
            byCpu: all.slice().sort((a, b) => b.cpu - a.cpu).slice(0, 5),
            byMem: all.slice().sort((a, b) => b.rss - a.rss).slice(0, 5),
        };
    }

    resetProcs() {
        this._procs = null;
        this._procResult = null;
    }
}
