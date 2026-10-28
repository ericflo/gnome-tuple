// Profile pictures, from Gravatar: that's where Tuple's own avatar_url
// fields point (https://www.gravatar.com/avatar/<md5 of the email>), so the
// address follows from an email alone and the CLI needn't be asked.
//
// Everything is asynchronous — the shell draws frames on this thread. The
// cache in ~/.cache/tuple-gnome/avatars is read once with an async scan;
// pictures are fetched a few at a time, only for people the menu is
// showing, and kept for a week. "No Gravatar" answers are remembered for a
// day so they aren't asked again. People without one keep their initials.
//
// Gio, GLib and Soup only, like service.js.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

const SIZE = 96;              // px: a 32px avatar at 3x
const KEEP_SECONDS = 7 * 86400;
const MISS_SECONDS = 86400;
const PARALLEL = 4;

export class Avatars {
    // onChange() runs (coalesced) whenever a picture arrives.
    constructor(onChange, {dir = null} = {}) {
        this._onChange = onChange;
        this._dir = dir ?? GLib.build_filenamev([GLib.get_user_cache_dir(), 'tuple-gnome', 'avatars']);
        this._known = new Map();      // hash → file path, or null for "has none"
        this._wanted = new Set();     // hashes asked for before the scan finished
        this._queue = [];
        this._inFlight = 0;
        this._ready = false;
        this._cancellable = new Gio.Cancellable();
        this._session = new Soup.Session({user_agent: 'tuple-gnome', timeout: 15, max_conns_per_host: PARALLEL});
        this._scan();
    }

    destroy() {
        this._cancellable.cancel();
        this._session.abort();
        this._queue = [];
        this._onChange = null;
        if (this._notifyId)
            GLib.source_remove(this._notifyId);
        this._notifyId = 0;
    }

    static hash(email) {
        return GLib.compute_checksum_for_string(GLib.ChecksumType.MD5, String(email).trim().toLowerCase(), -1);
    }

    // This person's picture on disk, or null — in which case it's fetched
    // (once) and onChange fires when it lands.
    path(email) {
        if (!email)
            return null;
        const hash = Avatars.hash(email);
        if (this._known.has(hash))
            return this._known.get(hash);
        if (!this._ready)
            this._wanted.add(hash);
        else
            this._enqueue(hash);
        return null;
    }

    _file(hash, ext) {
        return GLib.build_filenamev([this._dir, `${hash}.${ext}`]);
    }

    // What an earlier run left in the cache, minus anything past its date.
    _scan() {
        GLib.mkdir_with_parents(this._dir, 0o700);
        const dir = Gio.File.new_for_path(this._dir);
        const finish = () => {
            this._ready = true;
            for (const hash of this._wanted)
                this._enqueue(hash);
            this._wanted.clear();
        };
        dir.enumerate_children_async('standard::name,time::modified', Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_LOW, this._cancellable, (d, res) => {
                let files;
                try {
                    files = d.enumerate_children_finish(res);
                } catch {
                    finish();
                    return;
                }
                const next = () => files.next_files_async(64, GLib.PRIORITY_LOW, this._cancellable, (f, r) => {
                    let infos;
                    try {
                        infos = f.next_files_finish(r);
                    } catch {
                        infos = [];
                    }
                    if (infos.length === 0) {
                        files.close_async(GLib.PRIORITY_LOW, null, null);
                        finish();
                        this._changed();
                        return;
                    }
                    const now = Date.now() / 1000;
                    for (const info of infos) {
                        const m = info.get_name().match(/^([0-9a-f]{32})\.(img|none)$/);
                        if (!m)
                            continue;
                        const age = now - info.get_modification_date_time().to_unix();
                        if (m[2] === 'img' && age < KEEP_SECONDS)
                            this._known.set(m[1], this._file(m[1], 'img'));
                        else if (m[2] === 'none' && age < MISS_SECONDS && !this._known.has(m[1]))
                            this._known.set(m[1], null);
                    }
                    next();
                });
                next();
            });
    }

    _enqueue(hash) {
        if (this._queue.includes(hash) || this._known.has(hash))
            return;
        this._known.set(hash, null);      // until it arrives
        this._queue.push(hash);
        this._pump();
    }

    _pump() {
        while (this._inFlight < PARALLEL && this._queue.length > 0)
            this._fetch(this._queue.shift());
    }

    // d=404 rather than Tuple's d=blank, so "has none" is an answer and not
    // a transparent square.
    _fetch(hash) {
        this._inFlight++;
        const message = Soup.Message.new('GET', `https://www.gravatar.com/avatar/${hash}?d=404&s=${SIZE}`);
        this._session.send_and_read_async(message, GLib.PRIORITY_LOW, this._cancellable, (session, res) => {
            let bytes = null;
            try {
                bytes = session.send_and_read_finish(res);
            } catch {}
            this._inFlight--;
            const status = message.get_status();
            if (status === Soup.Status.OK && bytes && bytes.get_size() > 0)
                this._save(hash, 'img', bytes, true);
            else if (status === Soup.Status.NOT_FOUND)
                this._save(hash, 'none', new GLib.Bytes(new TextEncoder().encode('none\n')), false);
            // Anything else (offline, a timeout) stays "none" for this
            // session only, and is asked again next time.
            this._pump();
        });
    }

    _save(hash, ext, bytes, isPicture) {
        const path = this._file(hash, ext);
        Gio.File.new_for_path(path).replace_contents_bytes_async(bytes, null, false,
            Gio.FileCreateFlags.REPLACE_DESTINATION, this._cancellable, (file, res) => {
                try {
                    file.replace_contents_finish(res);
                } catch {
                    return;
                }
                if (!isPicture)
                    return;
                this._known.set(hash, path);
                this._changed();
            });
    }

    // Pictures arrive in bursts; redraw once per burst.
    _changed() {
        if (this._notifyId || !this._onChange)
            return;
        this._notifyId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            this._notifyId = 0;
            this._onChange?.();
            return GLib.SOURCE_REMOVE;
        });
    }
}
