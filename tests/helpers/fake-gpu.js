// A fake /sys/bus/pci/devices tree (NVIDIA card 01:00.0, AMD iGPU 06:00.0, an audio device) and a fake nvidia-smi
// that counts how often it is called and prints whatever the spec put in its output file.
import GLib from 'gi://GLib';
import {world, writeFile, readFile, exists} from './world.js';

export function makeFakeMachine(name = 'machine') {
    const root = `${world.root}/${name}`;
    const m = {
        root,
        pciRoot: `${root}/pci`,
        smiPath: `${root}/nvidia-smi`,
        smiOut: `${root}/smi-out`,
        smiCalls: `${root}/smi-calls`,
        nv: `${root}/pci/0000:01:00.0`,
        amd: `${root}/pci/0000:06:00.0`,
    };
    const dev = (dir, vendor, device, cls, driver) => {
        writeFile(`${dir}/vendor`, `${vendor}\n`);
        writeFile(`${dir}/device`, `${device}\n`);
        writeFile(`${dir}/class`, `${cls}\n`);
        if (driver) {
            GLib.mkdir_with_parents(`${root}/drivers/${driver}`, 0o755);
            GLib.spawn_command_line_sync(`ln -sfn '${root}/drivers/${driver}' '${dir}/driver'`);
        }
    };
    dev(m.nv, '0x10de', '0x2d59', '0x030000', 'nvidia');
    writeFile(`${m.nv}/power/control`, 'auto\n');
    writeFile(`${m.nv}/power/runtime_status`, 'active\n');
    dev(m.amd, '0x1002', '0x164e', '0x030000', 'amdgpu');
    writeFile(`${m.amd}/gpu_busy_percent`, '17\n');
    writeFile(`${m.amd}/mem_info_vram_used`, `${512 * 1048576}\n`);
    writeFile(`${m.amd}/mem_info_vram_total`, `${1024 * 1048576}\n`);
    writeFile(`${m.amd}/mem_info_gtt_used`, `${1024 * 1048576}\n`);
    writeFile(`${m.amd}/mem_info_gtt_total`, `${8192 * 1048576}\n`);
    writeFile(`${m.amd}/hwmon/hwmon3/temp1_input`, '48000\n');
    dev(`${root}/pci/0000:00:1f.3`, '0x8086', '0x51ca', '0x040300', null);            // audio: must be ignored

    writeFile(m.smiOut, 'NVIDIA GeForce RTX 5060 Ti, 37, 2048, 16311, 52, 33.40\n');
    writeFile(m.smiPath, `#!/bin/sh\necho x >> '${m.smiCalls}'\ncat '${m.smiOut}'\n`, 0o755);

    m.calls = () => (readFile(m.smiCalls) || '').split('\n').filter(Boolean).length;
    m.setSmi = text => writeFile(m.smiOut, `${text}\n`);
    m.setNvidiaPower = (control, status) => {
        writeFile(`${m.nv}/power/control`, `${control}\n`);
        writeFile(`${m.nv}/power/runtime_status`, `${status}\n`);
    };
    m.setNvidiaDriver = driver => {
        GLib.spawn_command_line_sync(`rm -f '${m.nv}/driver'`);
        if (driver) {
            GLib.mkdir_with_parents(`${root}/drivers/${driver}`, 0o755);
            GLib.spawn_command_line_sync(`ln -sfn '${root}/drivers/${driver}' '${m.nv}/driver'`);
        }
    };
    m.has = p => exists(p);
    return m;
}
