// Pure parsers for /proc and /sys text. No GNOME imports, so they can be unit-tested anywhere.

export function parseCpuStat(text) {
    const cores = [];
    let total = null;
    for (const line of text.split('\n')) {
        if (!line.startsWith('cpu')) continue;
        const f = line.trim().split(/\s+/);
        const v = f.slice(1).map(Number);
        const all = v.slice(0, 8).reduce((a, b) => a + b, 0);   // user..steal (guest is already in user)
        const idle = (v[3] || 0) + (v[4] || 0);                 // idle + iowait
        const entry = {total: all, busy: all - idle};
        if (f[0] === 'cpu') total = entry;
        else cores.push(entry);
    }
    return {total, cores};
}

export function cpuPercent(prev, cur) {
    if (!prev || !cur) return 0;
    const dt = cur.total - prev.total;
    if (dt <= 0) return 0;
    return Math.min(100, Math.max(0, (cur.busy - prev.busy) / dt * 100));
}

export function parseMeminfo(text) {
    const m = {};
    for (const line of text.split('\n')) {
        const i = line.indexOf(':');
        if (i < 0) continue;
        m[line.slice(0, i)] = parseInt(line.slice(i + 1), 10) * 1024;   // kB -> bytes
    }
    const total = m.MemTotal || 0;
    const available = m.MemAvailable !== undefined ? m.MemAvailable : (m.MemFree || 0);
    const used = total - available;
    return {
        total, available, used,
        percent: total ? used / total * 100 : 0,
        free: m.MemFree || 0,
        cached: (m.Cached || 0) + (m.SReclaimable || 0),
        buffers: m.Buffers || 0,
        swapTotal: m.SwapTotal || 0,
        swapUsed: (m.SwapTotal || 0) - (m.SwapFree || 0),
    };
}

const VIRTUAL_IFACE = /^(lo|veth|docker|br-|virbr|vnet|tap|tun|zt|tailscale)/;

export function parseNetDev(text) {
    const ifaces = {};
    for (const line of text.split('\n').slice(2)) {
        const i = line.indexOf(':');
        if (i < 0) continue;
        const name = line.slice(0, i).trim();
        const c = line.slice(i + 1).trim().split(/\s+/).map(Number);
        ifaces[name] = {rx: c[0], tx: c[8]};
    }
    let rx = 0, tx = 0;
    for (const [name, v] of Object.entries(ifaces)) {
        if (VIRTUAL_IFACE.test(name)) continue;
        rx += v.rx;
        tx += v.tx;
    }
    return {rx, tx, ifaces};
}

const WHOLE_DISK = /^(sd[a-z]+|vd[a-z]+|xvd[a-z]+|hd[a-z]+|nvme\d+n\d+|mmcblk\d+)$/;

export function parseDiskstats(text) {
    let read = 0, write = 0;
    for (const line of text.split('\n')) {
        const f = line.trim().split(/\s+/);
        if (f.length < 10 || !WHOLE_DISK.test(f[2])) continue;
        read += Number(f[5]) * 512;
        write += Number(f[9]) * 512;
    }
    return {read, write};
}

export function parseLoadavg(text) {
    return text.trim().split(/\s+/).slice(0, 3).map(Number);
}

export function parseUptime(text) {
    return parseFloat(text.trim().split(/\s+/)[0]);
}

export function parseCpuModel(text) {
    const m = text.match(/^model name\s*:\s*(.+)$/m) || text.match(/^Model\s*:\s*(.+)$/m);
    return m ? m[1].trim().replace(/\s+/g, ' ') : 'CPU';
}

const REAL_FS = new Set(['ext2', 'ext3', 'ext4', 'btrfs', 'xfs', 'f2fs', 'zfs', 'vfat',
                         'exfat', 'ntfs', 'ntfs3', 'fuseblk', 'jfs', 'reiserfs']);

export function parseMounts(text) {
    const seen = new Set();
    const out = [];
    for (const line of text.split('\n')) {
        const f = line.split(' ');
        if (f.length < 3) continue;
        const dev = f[0];
        const mnt = f[1].replace(/\\040/g, ' ');
        if (!REAL_FS.has(f[2]) || seen.has(dev)) continue;
        if (mnt.startsWith('/snap') || mnt.startsWith('/var/snap')) continue;
        seen.add(dev);
        out.push({dev, mount: mnt, fs: f[2]});
    }
    return out;
}

// /proc/<pid>/stat -> {pid, comm, ticks}. comm may contain spaces/parens, so split at the LAST ')'.
export function parseProcStat(text) {
    const a = text.indexOf('(');
    const b = text.lastIndexOf(')');
    if (a < 0 || b < 0) return null;
    const rest = text.slice(b + 2).split(' ');
    return {
        pid: parseInt(text.slice(0, a), 10),
        comm: text.slice(a + 1, b),
        ticks: Number(rest[11]) + Number(rest[12]),     // utime + stime
    };
}

export function parseStatmRss(text, pageSize = 4096) {
    return Number(text.trim().split(/\s+/)[1]) * pageSize;
}

// Choose the "CPU temperature" sensor from a list of {chip, label, value(°C), path}.
export function pickCpuSensor(sensors) {
    const by = (pred) => sensors.find(pred);
    const s =
        by(s => s.chip === 'k10temp' && /Tctl|Tdie/.test(s.label)) ||
        by(s => s.chip === 'coretemp' && /Package/.test(s.label)) ||
        by(s => s.chip === 'k10temp') ||
        by(s => s.chip === 'coretemp') ||
        by(s => s.chip === 'zenpower') ||
        by(s => s.chip === 'cpu_thermal') ||
        by(s => s.chip === 'acpitz') ||
        by(s => /x86_pkg_temp/.test(s.chip));
    return s || null;
}

// ---- formatting helpers -------------------------------------------------

export function fmtRate(bps) {
    const u = ['B', 'K', 'M', 'G'];
    let i = 0;
    while (bps >= 1024 && i < u.length - 1) { bps /= 1024; i++; }
    return (i === 0 || bps >= 100 ? bps.toFixed(0) : bps.toFixed(1)) + u[i];
}

export function fmtBytes(b) {
    const u = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    let i = 0;
    while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
    return (i === 0 ? b.toFixed(0) : b.toFixed(b >= 100 ? 0 : 1)) + ' ' + u[i];
}

export function fmtUptime(sec) {
    const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60);
    return d ? `${d}d ${h}h ${m}m` : h ? `${h}h ${m}m` : `${m}m`;
}

// ---- GPU helpers ---------------------------------------------------------------------------

// `nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw
//   --format=csv,noheader,nounits`  ->  [{name, load, memUsed, memTotal, temp, power}] (bytes / % / degC / W)
export function parseNvidiaSmi(text) {
    const num = s => {
        const v = parseFloat(s);
        return Number.isFinite(v) ? v : null;
    };
    const out = [];
    for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        const f = line.split(',').map(x => x.trim());
        if (f.length < 6) continue;
        const [load, used, total, temp, power] = f.slice(-5).map(num);
        out.push({
            name: f.slice(0, -5).join(', '),
            load,
            memUsed: used === null ? null : used * 1048576,       // MiB -> bytes
            memTotal: total === null ? null : total * 1048576,
            temp, power,
        });
    }
    return out;
}

// Look a PCI vendor/device up in the text of pci.ids ("10de", "2d59" -> name).
export function pciName(idsText, vendor, device) {
    const v = idsText.indexOf(`\n${vendor}  `);
    if (v < 0) return null;
    const vendorEnd = idsText.indexOf('\n', v + 1);
    const lines = idsText.slice(vendorEnd + 1).split('\n');
    for (const line of lines) {
        if (!line.startsWith('\t') && line.trim() && !line.startsWith('#')) break;   // next vendor
        if (line.startsWith(`\t${device}  `)) {
            const name = line.slice(device.length + 3).trim();
            const m = name.match(/\[(.+)\]/);
            return m ? m[1] : name;
        }
    }
    return null;
}

export const PRIME_MODES = {
    'nvidia': 'Performance (NVIDIA only)',
    'on-demand': 'Hybrid (on demand)',
    'intel': 'Integrated only',
    'amd': 'Integrated only',
};
