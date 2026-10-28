// Watch the running GNOME Shell for stalls, from outside it.
//
//   gjs -m tests/shell-lag.js [seconds] [threshold-ms]
//
// Every 50ms it reads a property off org.gnome.Shell. The shell answers
// D-Bus calls on its main thread — the one that also draws every frame — so
// a reply that takes long means the shell was stuck for that long. Prints
// each stall past the threshold (default 50ms) as it happens, then a summary.
// Note what you (or the extension) were doing at those times.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const seconds = Number(ARGV[0] || 120);
const threshold = Number(ARGV[1] || 50);
const bus = Gio.DBus.session;
const stalls = [];
const samples = [];
const end = Date.now() + seconds * 1000;

while (Date.now() < end) {
    const t0 = GLib.get_monotonic_time();
    bus.call_sync('org.gnome.Shell', '/org/gnome/Shell', 'org.freedesktop.DBus.Properties', 'Get',
        new GLib.Variant('(ss)', ['org.gnome.Shell', 'ShellVersion']), null, Gio.DBusCallFlags.NONE, 10000, null);
    const ms = (GLib.get_monotonic_time() - t0) / 1000;
    samples.push(ms);
    if (ms >= threshold) {
        const at = new Date().toTimeString().slice(0, 8);
        stalls.push({at, ms});
        print(`${at}  shell stalled ${ms.toFixed(0)}ms`);
    }
    GLib.usleep(50000);
}

samples.sort((a, b) => a - b);
const pct = p => samples[Math.min(samples.length - 1, Math.floor(samples.length * p))].toFixed(1);
print(`${samples.length} samples over ${seconds}s: median ${pct(0.5)}ms, p99 ${pct(0.99)}ms, worst ${samples[samples.length - 1].toFixed(0)}ms; ` +
    `${stalls.length} stalls ≥${threshold}ms`);
