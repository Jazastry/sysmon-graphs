// A fake think-lmi tree plus fake DRM/PCI folders, and a stand-in for "run a command as root" that records what it
// was asked to run (and can pretend to be pkexec's exit codes). Nothing here can reach the real BIOS.
import GLib from 'gi://GLib';
import {world, writeFile, readFile} from './world.js';
import {isolateBios} from './ext-harness.js';

// layout: where the laptop panel is connected: 'amd' (switchable), 'nvidia' (discrete); nvidia: false = no NVIDIA GPU (UMA)
export async function makeFakeBios({panel = 'amd', nvidia = true, locked = false, pendingReboot = false, modes = 'Switchable Graphics;Discrete Graphics;UMA Graphics'} = {}) {
    const Bios = await isolateBios();
    const root = `${world.root}/fake-bios-${GLib.get_monotonic_time()}`;
    const m = {Bios, root, calls: [], exitStatus: 0, writes: []};
    writeFile(`${root}/fw/attributes/GraphicsDevice/possible_values`, `${modes}\n`);
    writeFile(`${root}/fw/attributes/GraphicsDevice/current_value`, 'Switchable Graphics\n');
    writeFile(`${root}/fw/attributes/pending_reboot`, pendingReboot ? '1\n' : '0\n');
    writeFile(`${root}/fw/authentication/Admin/is_enabled`, locked ? '1\n' : '0\n');
    const dev = (slot, vendor) => {
        writeFile(`${root}/pci/${slot}/class`, '0x030000\n');
        writeFile(`${root}/pci/${slot}/vendor`, `${vendor}\n`);
    };
    dev('0000:06:00.0', '0x1002');
    if (nvidia) dev('0000:01:00.0', '0x10de');
    // like the real /sys/class/drm: card2-eDP-1/status, and the driver one level up at card2/device/driver
    const connector = (name, driver, status) => {
        const card = name.split('-')[0];
        writeFile(`${root}/drm/${name}/status`, `${status}\n`);
        GLib.mkdir_with_parents(`${root}/drivers/${driver}`, 0o755);
        GLib.mkdir_with_parents(`${root}/drm/${card}/device`, 0o755);
        GLib.spawn_command_line_sync(`ln -sfn '${root}/drivers/${driver}' '${root}/drm/${card}/device/driver'`);
    };
    connector('card2-eDP-1', 'amdgpu', panel === 'amd' ? 'connected' : 'disconnected');
    if (nvidia) connector('card1-eDP-2', 'nvidia', panel === 'nvidia' ? 'connected' : 'disconnected');
    connector('card1-HDMI-A-1', 'nvidia', 'connected');         // an external screen must not count as the panel
    Object.assign(Bios.cfg, {
        dir: `${root}/fw`, drm: `${root}/drm`, pci: `${root}/pci`,
        run: async argv => { m.calls.push(argv); return m.exitStatus; },
    });
    m.setPendingReboot = v => writeFile(`${root}/fw/attributes/pending_reboot`, v ? '1\n' : '0\n');
    m.read = rel => readFile(`${root}/fw/${rel}`);
    return m;
}
