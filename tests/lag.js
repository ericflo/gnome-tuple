// How much of a contacts refresh lands on the main thread — the thread that,
// inside GNOME Shell, also draws every frame. Runs service.js against the
// real (signed-in) daemon, with a 5ms timer watching for the loop to stall.
//
//   gjs -m tests/lag.js [query]   # refresh contacts (or search for `query`)
//   gjs -m tests/lag.js --idle 60 # just run for 60s: probes, followers, timers
//
// Reports wall time, CPU used by this process (≈ what the shell would
// spend), the longest single stall, and frames that would have been
// missed at 60Hz. Callbacks throughout (see tests/live.js).
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {Service} from '../tuple@ericflo/service.js';

GLib.setenv('GSETTINGS_BACKEND', 'memory', true);
const here = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
const dir = GLib.canonicalize_filename(GLib.build_filenamev([here, '..', 'tuple@ericflo']), null);
const source = Gio.SettingsSchemaSource.new_from_directory(`${dir}/schemas`, Gio.SettingsSchemaSource.get_default(), false);
const settings = new Gio.Settings({settings_schema: source.lookup('org.gnome.shell.extensions.tuple', false)});
const host = {
    copy() {}, readClipboard: cb => cb(''), openUrl() {}, notify: () => ({destroy() {}}),
    arrangeWindows() {}, focusWindow: () => false, windowSizes: () => '',
};

const idle = ARGV[0] === '--idle';
const idleSeconds = idle ? Number(ARGV[1] || 60) : 0;
const query = idle ? '' : (ARGV[0] ?? '');
const cpuMs = () => {
    const [, bytes] = GLib.file_get_contents('/proc/self/stat');
    const f = new TextDecoder().decode(bytes).replace(/^.*\) /, '').split(' ');
    return (Number(f[11]) + Number(f[12])) * 10;   // utime + stime, 100Hz ticks
};

const loop = new GLib.MainLoop(null, false);
const service = new Service({settings, host, dir});

const measure = (start, done, cb) => {
    let last = GLib.get_monotonic_time();
    let worst = 0;
    let missed = 0;
    const watch = GLib.timeout_add(GLib.PRIORITY_HIGH, 5, () => {
        const now = GLib.get_monotonic_time();
        const gap = (now - last) / 1000;
        worst = Math.max(worst, gap);
        missed += Math.max(0, Math.floor(gap / 16.7) - 0);
        last = now;
        return GLib.SOURCE_CONTINUE;
    });
    const t0 = Date.now();
    const c0 = cpuMs();
    start();
    const poll = () => {
        if (!done()) {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 20, () => {
                poll();
                return GLib.SOURCE_REMOVE;
            });
            return;
        }
        GLib.source_remove(watch);
        cb({wall: Date.now() - t0, cpu: cpuMs() - c0, worst, missed});
    };
    poll();
};

const ready = () => service.daemonKnown && service.summary;
const wait = () => {
    if (!ready()) {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            wait();
            return GLib.SOURCE_REMOVE;
        });
        return;
    }
    // Let the refresh the service starts on its own finish first.
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 4000, () => {
        const busy = () => service.isPending('contacts') || service.isPending('search');
        const end = Date.now() + idleSeconds * 1000;
        const run = idle ? () => {} : query === '' ? () => service.refreshContacts() : () => service.searchContacts(query);
        const done = idle ? () => Date.now() >= end : () => !busy();
        measure(run, done, r => {
            const shown = service.shownContacts(query);
            const what = idle ? `idle ${idleSeconds}s` : query === '' ? 'refresh' : `search “${query}”`;
            print(`${what}: ${r.wall}ms wall, ${r.cpu}ms CPU on the main thread, ` +
                `worst stall ${r.worst.toFixed(1)}ms, ~${r.missed} frames missed at 60Hz; ` +
                `${service.contacts.length} contacts held, ${shown.length} shown`);
            service.destroy();
            loop.quit();
        });
        return GLib.SOURCE_REMOVE;
    });
};
wait();
loop.run();
