// GPU statistics.
//
//  * AMD: plain sysfs reads (gpu_busy_percent, mem_info_vram_*), always cheap.
//  * NVIDIA: load/memory only come from `nvidia-smi`. Calling it wakes a sleeping card, which would
//    ruin the power saving of Hybrid ("on-demand") mode, so:
//      - if the card is runtime-suspended we do NOT query it and just report "asleep";
//      - Performance mode (power/control = "on") is polled every 2 s;
//      - Hybrid mode only polls while the card is awake, and backs off to every 15 s while it is idle,
//        so our own polling never keeps it awake.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import * as S from './stats.js';
import {readText, listDir, linkBase} from './util.js';

const SMI_QUERY = 'name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw';
const SMI_DIRS = ['/usr/bin', '/usr/sbin', '/usr/local/bin', '/usr/local/sbin', '/bin', '/opt/nvidia/bin'];
const IDLE_MEM = 64 * 1048576;          // below this and 0 % load, an awake card counts as idle
const POLL_ACTIVE = 2;                  // seconds between nvidia-smi calls
const POLL_IDLE = 15;                   // ... while the card is awake but idle in Hybrid mode
const PCI_IDS = ['/usr/share/hwdata/pci.ids', '/usr/share/misc/pci.ids', '/usr/share/pci.ids'];

export class GpuSampler {
    constructor(opts = {}) {
        this._pciRoot = opts.pciRoot || '/sys/bus/pci/devices';
        this._smiPathOverride = opts.smiPath || null;
        this._smiPath = undefined;
        this._smiMissCount = 0;
        this._nv = {last: null, inflight: false, lastPoll: -1e9, proc: null, timeoutId: 0};
        this._ids = undefined;
        this._names = new Map();
        this._destroyed = false;
        this.mode = null;               // 'nvidia' | 'on-demand' | 'intel' (Ubuntu's prime-select), if present
        if (!opts.noMode) this._queryMode();
    }

    // ---- public ----------------------------------------------------------------------------
    poll(t) {
        const gpus = [];
        for (const slot of listDir(this._pciRoot).sort()) {
            const base = `${this._pciRoot}/${slot}`;
            if (!readText(`${base}/class`).trim().startsWith('0x03')) continue;     // display controllers
            const vendor = readText(`${base}/vendor`).trim();
            const device = readText(`${base}/device`).trim();
            const driver = linkBase(`${base}/driver`);
            if (vendor === '0x10de') gpus.push(this._nvidia(base, slot, device, driver, t));
            else if (vendor === '0x1002') gpus.push(this._amd(base, slot, device, driver));
            else if (vendor === '0x8086') gpus.push(this._intel(base, slot, device, driver));
        }
        return gpus;
    }

    destroy() {
        this._destroyed = true;
        if (this._nv.timeoutId) GLib.Source.remove(this._nv.timeoutId);
        this._nv.timeoutId = 0;
        if (this._nv.proc) {
            try { this._nv.proc.force_exit(); } catch (e) { /* already gone */ }
        }
        this._nv.proc = null;
    }

    // ---- helpers ----------------------------------------------------------------------------
    _pciName(vendor, device) {
        const key = `${vendor}:${device}`;
        if (this._names.has(key)) return this._names.get(key);
        if (this._ids === undefined) {
            this._ids = '';
            for (const p of PCI_IDS) {
                const txt = readText(p);
                if (txt) { this._ids = txt; break; }
            }
        }
        const name = this._ids ? S.pciName(this._ids, vendor.replace('0x', ''), device.replace('0x', '')) : null;
        this._names.set(key, name);
        return name;
    }

    _base(kind, slot, driver, name) {
        return {kind, slot, driver, name, state: 'active', load: null,
                memUsed: null, memTotal: null, temp: null, power: null, extra: {}};
    }

    _findSmi() {
        if (this._smiPathOverride) return this._smiPathOverride;
        if (this._smiPath === undefined || (this._smiPath === null && ++this._smiMissCount % 30 === 0)) {
            let p = GLib.find_program_in_path('nvidia-smi');
            if (!p) {
                for (const d of SMI_DIRS) {
                    const c = `${d}/nvidia-smi`;
                    if (GLib.file_test(c, GLib.FileTest.IS_EXECUTABLE)) { p = c; break; }
                }
            }
            this._smiPath = p || null;
        }
        return this._smiPath;
    }

    _queryMode() {
        try {
            const p = GLib.find_program_in_path('prime-select');
            if (!p) return;
            const proc = Gio.Subprocess.new([p, 'query'],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
            proc.communicate_utf8_async(null, null, (pr, res) => {
                try {
                    const [, out] = pr.communicate_utf8_finish(res);
                    this.mode = (out || '').trim() || null;
                } catch (e) { /* not available */ }
            });
        } catch (e) { /* prime-select missing or failed */ }
    }

    // ---- NVIDIA -------------------------------------------------------------------------------
    _nvidia(base, slot, device, driver, t) {
        const fallback = this._pciName('0x10de', device) || `NVIDIA GPU ${device.replace('0x', '')}`;
        const g = this._base('nvidia', slot, driver, fallback);
        const rs = readText(`${base}/power/runtime_status`).trim();
        const ctl = readText(`${base}/power/control`).trim();
        g.extra = {runtimeStatus: rs, powerControl: ctl};

        if (!driver) { g.state = 'off'; return g; }
        if (driver === 'nouveau') { g.state = 'nouveau'; return g; }
        if (driver !== 'nvidia') { g.state = 'other'; return g; }

        if (rs === 'suspended' || rs === 'suspending') {
            g.state = 'asleep';
            this._nv.last = null;                         // stale after sleeping
            return g;
        }
        const smi = this._findSmi();
        if (!smi) { g.state = 'no-tools'; return g; }

        const last = this._nv.last;
        const alwaysOn = ctl === 'on' || rs === 'unsupported' || rs === '';
        const idle = !alwaysOn && last && last.load === 0 && (last.memUsed || 0) < IDLE_MEM;
        const every = idle ? POLL_IDLE : POLL_ACTIVE;
        if (!this._nv.inflight && t - this._nv.lastPoll >= every - 0.05)
            this._spawnSmi(smi, t);

        if (last) {
            g.name = last.name || g.name;
            g.load = last.load;
            g.memUsed = last.memUsed;
            g.memTotal = last.memTotal;
            g.temp = last.temp;
            g.power = last.power;
        } else {
            g.load = 0;                                   // first reading still in flight
        }
        g.extra.idleBackoff = !!idle;
        return g;
    }

    _spawnSmi(smi, t) {
        const nv = this._nv;
        nv.inflight = true;
        nv.lastPoll = t;
        let proc;
        try {
            proc = Gio.Subprocess.new([smi, `--query-gpu=${SMI_QUERY}`, '--format=csv,noheader,nounits'],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (e) {
            nv.inflight = false;
            this._smiPath = null;
            return;
        }
        nv.proc = proc;
        nv.timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, () => {
            nv.timeoutId = 0;
            try { proc.force_exit(); } catch (e) { /* done already */ }
            return GLib.SOURCE_REMOVE;
        });
        proc.communicate_utf8_async(null, null, (pr, res) => {
            if (nv.timeoutId) { GLib.Source.remove(nv.timeoutId); nv.timeoutId = 0; }
            nv.inflight = false;
            nv.proc = null;
            if (this._destroyed) return;
            try {
                const [, out] = pr.communicate_utf8_finish(res);
                const rows = S.parseNvidiaSmi(out || '');
                if (rows.length) nv.last = rows[0];
            } catch (e) { /* keep the previous values */ }
        });
    }

    // ---- AMD ---------------------------------------------------------------------------------
    _amd(base, slot, device, driver) {
        const name = readText(`${base}/product_name`).trim() || this._pciName('0x1002', device) || 'Graphics';
        const g = this._base('amd', slot, driver, `AMD ${name}`);
        if (driver !== 'amdgpu') { g.state = driver ? 'other' : 'off'; return g; }
        const n = f => {
            const v = parseInt(readText(`${base}/${f}`), 10);
            return Number.isNaN(v) ? null : v;
        };
        g.load = n('gpu_busy_percent');
        g.memUsed = n('mem_info_vram_used');
        g.memTotal = n('mem_info_vram_total');
        g.extra = {gttUsed: n('mem_info_gtt_used'), gttTotal: n('mem_info_gtt_total')};
        for (const hw of listDir(`${base}/hwmon`).sort()) {
            const v = n(`hwmon/${hw}/temp1_input`);
            if (v !== null) g.temp = v / 1000;
            const p = n(`hwmon/${hw}/power1_average`);
            if (p !== null) g.power = p / 1e6;
            if (g.temp !== null) break;
        }
        return g;
    }

    // ---- Intel (no utilisation counters without root, so just presence) ------------------------
    _intel(base, slot, device, driver) {
        const g = this._base('intel', slot, driver, `Intel ${this._pciName('0x8086', device) || 'Graphics'}`);
        if (!driver) g.state = 'off';
        return g;
    }
}
