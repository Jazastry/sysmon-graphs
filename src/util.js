import GLib from 'gi://GLib';

const decoder = new TextDecoder();

export function readText(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        return ok ? decoder.decode(bytes) : '';
    } catch (e) {
        return '';
    }
}

export function listDir(path) {
    const out = [];
    try {
        const dir = GLib.Dir.open(path, 0);
        let name;
        while ((name = dir.read_name()) !== null)
            out.push(name);
        dir.close();
    } catch (e) { /* missing directory */ }
    return out;
}

export function linkBase(path) {
    try {
        return GLib.path_get_basename(GLib.file_read_link(path));
    } catch (e) {
        return '';
    }
}
