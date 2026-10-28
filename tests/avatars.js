// Fetch profile pictures for the people the menu would show, into a
// throwaway cache, and report what it cost the main thread.
//
//   gjs -m tests/avatars.js            # your favourites/recents/online (signed in)
//   gjs -m tests/avatars.js a@b.com …  # these emails
//
// Runs twice over the same cache: the second pass shows a warm start
// (pictures from disk, nothing fetched). Callbacks only (see tests/live.js).
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {Avatars} from '../tuple@ericflo/avatars.js';

const here = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
const helper = GLib.canonicalize_filename(GLib.build_filenamev([here, '..', 'tuple@ericflo', 'bin', 'tuple-contacts']), null);
const cache = GLib.dir_make_tmp('tuple-avatars-XXXXXX');

let emails = ARGV;
if (emails.length === 0) {
    const tuple = GLib.find_program_in_path('tuple') ?? `${GLib.get_home_dir()}/.local/bin/tuple`;
    const [, out] = GLib.spawn_sync(null, [helper, tuple], null, GLib.SpawnFlags.DEFAULT, null);
    emails = JSON.parse(new TextDecoder().decode(out)).map(c => c.email);
}

const cpuMs = () => {
    const [, b] = GLib.file_get_contents('/proc/self/stat');
    const f = new TextDecoder().decode(b).replace(/^.*\) /, '').split(' ');
    return (Number(f[11]) + Number(f[12])) * 10;
};
const loop = new GLib.MainLoop(null, false);

const pass = (label, then) => {
    let last = GLib.get_monotonic_time();
    let worst = 0;
    const watch = GLib.timeout_add(GLib.PRIORITY_HIGH, 5, () => {
        const now = GLib.get_monotonic_time();
        worst = Math.max(worst, (now - last) / 1000);
        last = now;
        return GLib.SOURCE_CONTINUE;
    });
    const t0 = Date.now();
    const c0 = cpuMs();
    let avatars = null;
    const count = () => emails.filter(e => avatars.path(e)).length;
    avatars = new Avatars(() => {}, {dir: cache});
    const poll = () => {
        // Ask as the menu would on every redraw; done once nothing's in flight.
        const have = count();
        if (avatars._ready && avatars._inFlight === 0 && avatars._queue.length === 0 && Date.now() - t0 > 300) {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
                GLib.source_remove(watch);
                print(`${label}: ${count()} of ${emails.length} have a picture; ${Date.now() - t0}ms wall, ` +
                    `${cpuMs() - c0}ms CPU on the main thread, worst stall ${worst.toFixed(1)}ms`);
                avatars.destroy();
                then();
                return GLib.SOURCE_REMOVE;
            });
            return;
        }
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            poll();
            return GLib.SOURCE_REMOVE;
        });
        return have;
    };
    poll();
};

pass('cold (fetching)', () => pass('warm (from disk)', () => {
    const files = Gio.File.new_for_path(cache).enumerate_children('standard::name,standard::size', 0, null);
    let pics = 0, misses = 0, bytes = 0;
    for (let info; (info = files.next_file(null));) {
        if (info.get_name().endsWith('.img')) {
            pics++;
            bytes += info.get_size();
        } else {
            misses++;
        }
    }
    print(`cache: ${pics} pictures (${(bytes / 1024).toFixed(0)}KB), ${misses} "no Gravatar" markers in ${cache}`);
    loop.quit();
}));
loop.run();
