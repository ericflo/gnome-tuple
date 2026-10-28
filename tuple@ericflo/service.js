// State and actions for the Tuple Linux client.
//
// Sources of truth (see model.js for the CLI notes):
//   1. /proc/net/unix                      → is the daemon listening?
//   2. `tuple state follow --format json`  → signed in, in a call, who, muted
//   3. tail -F ~/.local/share/tuple/0/log.txt → a call ringing in, screen
//      share, their webcam, Tuple's windows
//   4. command replies                     → everything we do ourselves
//
// Only Gio and GLib here (no St, no Main): the shell-facing pieces come in
// through `host`, so a plain gjs script can drive this against the real
// daemon (tests/live.js).
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Model from './model.js';

const PROBE_SECONDS = 2;
const REFRESH_THROTTLE_MS = 15000;
const PRESENCE_REFRESH_MS = 20000;
const CONTACT_LIMIT = 40;

// One child process. Collects (or streams) stdout lines, keeps stderr apart,
// and gives up after timeoutMs so a wedged daemon can't leave a button busy.
class Proc {
    constructor(argv, {onLine = null, onDone = null, timeoutMs = 0, keep = true} = {}) {
        this.argv = argv;
        this.out = [];
        this.err = [];
        this.exitCode = -1;
        this.timedOut = false;
        this.running = false;
        this._onLine = onLine;
        this._onDone = onDone;
        this._timeoutMs = timeoutMs;
        this._keep = keep;
        this._cancellable = new Gio.Cancellable();
    }

    start() {
        try {
            this._proc = Gio.Subprocess.new(this.argv,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        } catch (e) {
            this.err.push(e.message);
            this.exitCode = 127;
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                this._done();
                return GLib.SOURCE_REMOVE;
            });
            return this;
        }
        this.running = true;
        this.pid = Number(this._proc.get_identifier());
        this._open = 2;
        this._read(this._proc.get_stdout_pipe(), this.out, this._onLine);
        this._read(this._proc.get_stderr_pipe(), this.err, null);
        this._proc.wait_async(null, (proc, res) => {
            try {
                proc.wait_finish(res);
            } catch {}
            this.running = false;
            this.exitCode = proc.get_if_exited() ? proc.get_exit_status() : -1;
            // A child that forked (the daemon) may hold our pipes; don't wait
            // on them past a moment.
            this._grace = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
                this._grace = 0;
                this._cancellable.cancel();
                this._done();
                return GLib.SOURCE_REMOVE;
            });
            this._maybeDone();
        });
        if (this._timeoutMs > 0) {
            this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._timeoutMs, () => {
                this._timer = 0;
                this.timedOut = true;
                this.kill();
                return GLib.SOURCE_REMOVE;
            });
        }
        return this;
    }

    _read(pipe, sink, onLine) {
        const stream = new Gio.DataInputStream({base_stream: pipe, close_base_stream: true});
        const next = () => {
            stream.read_line_async(GLib.PRIORITY_DEFAULT, this._cancellable, (s, res) => {
                let line = null;
                try {
                    [line] = s.read_line_finish_utf8(res);
                } catch {}
                if (line === null) {
                    this._open--;
                    this._maybeDone();
                    return;
                }
                if (this._keep)
                    sink.push(line);
                if (onLine)
                    onLine(line, this);
                next();
            });
        };
        next();
    }

    _maybeDone() {
        if (!this.running && this._open <= 0)
            this._done();
    }

    _done() {
        if (this._finished)
            return;
        this._finished = true;
        for (const id of [this._timer, this._grace]) {
            if (id)
                GLib.source_remove(id);
        }
        this._timer = this._grace = 0;
        this._onDone?.(this);
    }

    kill(signal = 15) {
        if (this.running)
            this._proc.send_signal(signal);
    }
}

export class Service {
    // host: { copy(text), readClipboard(cb), notify({title, body, urgency,
    //   transient, actions}) → {destroy()}, openUrl(url), arrangeWindows(),
    //   focusWindow(role) → bool, windowSizes() → string }
    constructor({settings, host, dir}) {
        this._settings = settings;
        this._host = host;
        this._dir = dir;
        this._listeners = [];
        this._timers = new Map();
        this._procs = new Set();
        this._destroyed = false;

        // ── Public state ──────────────────────────────────────────────────
        this.tuple = '';                 // resolved path of the tuple CLI
        this.daemon = false;
        this.daemonKnown = false;
        this.summary = null;             // Model.parseSummary()
        this.log = Model.emptyState();
        this.muted = false;
        this.contacts = [];
        this.contactsLoaded = false;
        this.tupleSettings = [];
        this.personalUrl = '';
        this.loginUrl = '';
        this.loginPending = false;
        this.clipboardCallUrl = '';
        this.actionStatus = '';
        this.lastError = '';
        this.pending = new Set();
        this.calling = null;             // the contact `tuple call start` is ringing
        this.me = null;                  // {name, email} of whoever's signed in
        this.cameras = [];
        this.mics = [];
        this.defaultMic = '';
        this.demo = '';

        this._contactsText = '';
        this._contactsSettle = 0;
        this._search = null;             // {query, results}: Tuple's answer to the last search
        this._searching = '';            // the query in flight
        this._searchSeq = 0;
        this._lastRefreshAt = 0;
        this._lastPresenceRefreshAt = 0;
        this._micRouteKey = '';
        this._micRoutedThisCall = false;

        this._settingsIds = [
            settings.connect('changed::mic-device', () => this._changed()),
            settings.connect('changed::camera-device', () => this._changed()),
            settings.connect('changed::camera-size', () => this._host.arrangeWindows()),
            settings.connect('changed::tuple-command', () => this._resolveTuple()),
            settings.connect('changed::refresh-interval', () => this._scheduleContactRefresh()),
        ];

        this._resolveTuple();
        this._startLogFollower();
        // While `state follow` is streaming, the daemon is up by definition
        // (the stream ends with it), so only look while it isn't.
        this._every('probe', PROBE_SECONDS * 1000, () => {
            if (!(this.daemon && this._summaryProc?.running))
                this._probe();
        });
        this._every('tick', 5000, () => this.tick());
        this._probe();
        this.refreshCameras();
        this.refreshMics();
        // After a shell restart mid-call the log replay doesn't place anything
        // (side effects only fire for live lines); tidy up once it's settled.
        this._later('settle', 5000, () => {
            if (this.log.windows.length > 0 || this.cameraOn)
                this._host.arrangeWindows();
        });
    }

    destroy() {
        this._destroyed = true;
        for (const id of this._settingsIds)
            this._settings.disconnect(id);
        for (const id of this._timers.values())
            GLib.source_remove(id);
        this._timers.clear();
        for (const proc of this._procs)
            proc.kill();
        this._procs.clear();
        this._incomingNote?.destroy();
        this._listeners = [];
    }

    // ── Change notification ───────────────────────────────────────────────
    connectChanged(fn) {
        this._listeners.push(fn);
    }

    // Coalesce bursts (a log replay is hundreds of lines) into one update.
    _changed() {
        if (this._destroyed || this._timers.has('emit'))
            return;
        this._later('emit', 0, () => {
            this._syncMicRoute();
            for (const fn of this._listeners)
                fn();
        });
    }

    // ── Derived state ─────────────────────────────────────────────────────
    get installed() {
        return this.tuple !== '';
    }

    get auth() {
        if (!this.summary)
            return -1;
        return this.summary.signedIn ? 1 : 0;
    }

    get loggedIn() {
        return this.daemon && this.auth === 1;
    }

    get call() {
        if (!this.daemon)
            return 'idle';
        return Model.callState(this.summary, this.log, {
            calling: this.calling !== null,
            joining: this.isPending('join') || this.isPending('new'),
            ending: this.isPending('end'),
        });
    }

    get inCall() {
        return ['active', 'connecting', 'ending'].includes(this.call);
    }

    get incoming() {
        return this.call === 'incoming';
    }

    get sharing() {
        return this.inCall && this.log.sharing;
    }

    get peers() {
        if (!this.daemon || !this.summary || !this.summary.inCall)
            return [];
        return this.summary.participants;
    }

    get peerNames() {
        return this.peers.map(p => p.name);
    }

    get peerSharing() {
        return this.inCall && this.log.peerSharing !== '';
    }

    get peerWebcam() {
        return this.inCall && this.log.peerWebcam;
    }

    get incomingFrom() {
        const from = this.log.incomingFrom;
        return /^\d+$/.test(from) ? this.contactName(from) : from;
    }

    // Who's calling, as {name, email}: the log gives a name (or an id), so
    // look them up among the people held for their email (and picture).
    get incomingPerson() {
        const from = this.log.incomingFrom;
        const pool = this.contacts.concat(this._search?.results ?? []);
        const c = pool.find(x => x.id === from || x.name === from);
        return {name: this.incomingFrom || 'Someone', email: c ? c.email : ''};
    }

    get contactCounts() {
        if (this.summary && this.summary.signedIn)
            return this.summary.counts;
        return Model.contactCounts(this.contacts);
    }

    get busy() {
        return this.pending.size > 0;
    }

    // Where the daemon is headed: what the on/off switch shows while `start`
    // or `stop` runs, until the probe sees it get there.
    get daemonTarget() {
        return this._daemonTarget ?? this.daemon;
    }

    get statusText() {
        if (!this.installed)
            return 'Tuple CLI not found';
        if (this._daemonTarget === true && !this.daemon)
            return 'Starting Tuple…';
        if (this._daemonTarget === false && this.daemon)
            return 'Stopping Tuple…';
        return Model.statusLabel({
            daemon: this.daemon,
            loggedIn: this.loggedIn,
            call: this.call,
            peers: this.peerNames,
            outgoing: this.calling !== null,
            calling: this.calling ? this.calling.name : '',
            incomingFrom: this.incomingFrom,
            websocket: this.summary ? this.summary.websocket : '',
            internet: this.summary ? this.summary.internet : true,
        });
    }

    get version() {
        return (this.summary && this.summary.version) || this.log.version;
    }

    get guestMode() {
        return this.settingValue('guest-mode') || 'annotation';
    }

    get startCallsMuted() {
        return this.settingValue('start-calls-muted') === '1';
    }

    // Your chosen camera, or the first one when it isn't plugged in.
    get camera() {
        return Model.resolveCamera(this.cameras, this._settings.get_string('camera-device'));
    }

    get cameraIsDefault() {
        const pref = this._settings.get_string('camera-device');
        return pref === '' || !Model.findCamera(this.cameras, pref);
    }

    get cameraOn() {
        return !!this._cameraProc?.running;
    }

    // Microphones (PipeWire sources). A blank mic-device follows the system
    // default; otherwise Tuple's recording stream is moved to it.
    get micDevice() {
        return this._settings.get_string('mic-device');
    }

    get mic() {
        return Model.findMic(this.mics, this.micDevice !== '' ? this.micDevice : this.defaultMic);
    }

    get micIsDefault() {
        return this.micDevice === '' || !Model.findMic(this.mics, this.micDevice);
    }

    // With no query: favourites, recents, then whoever's online. With one:
    // Tuple's results for it, or — while those are on the way — the closest
    // we have (the last results and the people held), filtered here.
    shownContacts(query) {
        const q = String(query || '').trim();
        if (q === '')
            return Model.featuredContacts(this.contacts, CONTACT_LIMIT);
        if (this._search?.query === q)
            return Model.rankContacts(this._search.results, q, CONTACT_LIMIT);
        const seen = new Set();
        const pool = (this._search?.results ?? []).concat(this.contacts).filter(c => {
            if (seen.has(c.id))
                return false;
            seen.add(c.id);
            return true;
        });
        return Model.searchContacts(pool, q, CONTACT_LIMIT);
    }

    get contactLimit() {
        return CONTACT_LIMIT;
    }

    isPending(name) {
        return this.pending.has(name);
    }

    contactName(id) {
        const key = String(id);
        const c = this.contacts.find(x => x.id === key) ?? this._search?.results.find(x => x.id === key);
        return c ? c.name : (/^\d+$/.test(key) ? 'Someone' : key);
    }

    settingValue(name) {
        const s = this.tupleSettings.find(x => x.name === name);
        return s ? s.value : '';
    }

    // ── Helpers ───────────────────────────────────────────────────────────
    _later(name, ms, fn) {
        this._cancel(name);
        this._timers.set(name, GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._timers.delete(name);
            if (!this._destroyed)
                fn();
            return GLib.SOURCE_REMOVE;
        }));
    }

    _every(name, ms, fn) {
        this._cancel(name);
        this._timers.set(name, GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            if (!this._destroyed)
                fn();
            return GLib.SOURCE_CONTINUE;
        }));
    }

    _cancel(name) {
        const id = this._timers.get(name);
        if (id) {
            GLib.source_remove(id);
            this._timers.delete(name);
        }
    }

    helper(name) {
        return GLib.build_filenamev([this._dir, 'bin', name]);
    }

    say(text, isError = false) {
        this.actionStatus = isError ? '' : String(text || '');
        this.lastError = isError ? String(text || '') : '';
        this._later('status-clear', 6000, () => {
            this.actionStatus = '';
            this.lastError = '';
            this._changed();
        });
        this._changed();
    }

    copy(text, label = 'Copied') {
        const value = String(text || '');
        if (value === '')
            return;
        this._host.copy(value);
        this.say(`${label} copied`);
    }

    openUrl(url) {
        if (String(url || '') !== '')
            this._host.openUrl(String(url));
    }

    notify(title, body, opts = {}) {
        return this._host.notify({title, body, ...opts});
    }

    // Resolve `tuple` the way an interactive shell would, plus the two install
    // locations offered on tuple.app/linux (GNOME's PATH often has neither).
    _resolveTuple() {
        const cmd = this._settings.get_string('tuple-command') || 'tuple';
        const home = GLib.get_home_dir();
        let found = '';
        if (cmd.includes('/')) {
            const path = cmd.replace(/^~(?=\/)/, home);
            if (GLib.file_test(path, GLib.FileTest.IS_EXECUTABLE))
                found = path;
        } else {
            found = GLib.find_program_in_path(cmd) ?? '';
            for (const dir of [`${home}/.local/bin`, `${home}/bin`]) {
                const path = `${dir}/${cmd}`;
                if (found === '' && GLib.file_test(path, GLib.FileTest.IS_EXECUTABLE))
                    found = path;
            }
        }
        if (found !== this.tuple) {
            this.tuple = found;
            this._changed();
        }
    }

    // ── Command runner ────────────────────────────────────────────────────
    // run(['call', 'mute'], {name, onLine, onDone, quiet, replyAs, helper}):
    // streams stdout lines to onLine(line, proc) and calls onDone(reply, proc)
    // with Model.parseReply(). `name` keys the busy state (default: args[0]).
    // With `helper`, runs bin/<helper> TUPLE ARGS… instead of tuple ARGS….
    run(args, opts = {}) {
        const name = opts.name ?? String(args[0]);
        if (this.demo !== '') {
            if (opts.quiet !== true)
                this.say(`demo: tuple ${args.join(' ')}`);
            return null;
        }
        if (!this.installed) {
            this.say("The tuple CLI isn't installed — see tuple.app/linux", true);
            return null;
        }
        if (opts.exclusive !== false && this.isPending(name))
            return null;
        this._setPending(name, true);
        const argv = opts.helper ? [this.helper(opts.helper), this.tuple, ...args] : [this.tuple, ...args];
        const proc = new Proc(argv, {
            timeoutMs: opts.timeoutMs ?? this._commandTimeout(name),
            onLine: opts.onLine ?? null,
            onDone: p => this._finish(name, p, opts),
        });
        this._procs.add(proc);
        return proc.start();
    }

    // How long each command may take before we give up on it. `call` waits on
    // the ring (Tuple gives up after 25s); `login` on the browser.
    _commandTimeout(name) {
        if (name === 'call')
            return 60000;
        if (name === 'login' || name === 'auth')
            return 90000;
        if (['contacts', 'settings', 'start', 'stop'].includes(name))
            return 45000;
        return 20000;
    }

    _setPending(name, on) {
        if (on)
            this.pending.add(name);
        else
            this.pending.delete(name);
        this._changed();
    }

    _finish(name, proc, opts) {
        this._procs.delete(proc);
        if (this._destroyed)
            return;
        let text = proc.out.concat(proc.err).join('\n');
        if (proc.timedOut && proc.out.length === 0)
            text = `error: Tuple didn't respond to “${name}”`;
        const reply = Model.parseReply(text, proc.timedOut ? 1 : proc.exitCode);
        this._setPending(name, false);
        if (opts.replyAs)
            this.log = Model.reduceReply(this.log, opts.replyAs, reply);
        if (opts.onDone)
            opts.onDone(reply, proc);
        else if (opts.quiet !== true && reply.message !== '')
            this.say(reply.message, !reply.ok);
        else if (!reply.ok)
            this.say(reply.message, true);
        this._changed();
    }

    // ── Daemon lifecycle ──────────────────────────────────────────────────
    _probe() {
        if (this.demo !== '' || this._probing)
            return;
        if (!this.installed)
            this._resolveTuple();
        this._probing = true;
        Gio.File.new_for_path('/proc/net/unix').load_contents_async(null, (file, res) => {
            this._probing = false;
            if (this._destroyed || this.demo !== '')
                return;
            let up = false;
            try {
                const [, bytes] = file.load_contents_finish(res);
                up = Service.daemonListening(new TextDecoder().decode(bytes));
            } catch {}
            const changed = up !== this.daemon || !this.daemonKnown;
            this.daemon = up;
            this.daemonKnown = true;
            if (this._daemonTarget === up) {
                this._headFor(null);
                this._changed();
            }
            if (changed) {
                if (up)
                    this._onDaemonUp();
                else
                    this._onDaemonDown();
                this._changed();
            } else if (up && !this._summaryProc && !this._timers.has('summary-restart') && !this.isPending('stop')) {
                this._startSummary();
            }
        });
    }

    // The daemon listens on $XDG_RUNTIME_DIR/tuple-<n> (the 2026_09 client
    // used the abstract socket @tuple-daemon). /proc/net/unix lists only
    // live sockets, so a stale socket file doesn't count.
    static daemonListening(table) {
        const runtime = GLib.get_user_runtime_dir().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`\\s(${runtime}/tuple-\\d+|@tuple-daemon)$`, 'm').test(table);
    }

    _onDaemonUp() {
        this._startSummary();
        this.refreshSettings();
        this._scheduleContactRefresh();
    }

    _onDaemonDown() {
        this._summaryProc?.kill();
        this.summary = null;
        this.contacts = [];
        this.contactsLoaded = false;
        this._contactsText = '';
        this._search = null;
        this.muted = false;
        this.loginPending = false;
        this.calling = null;
        this.log = Model.clearCall(this.log);
        this._cancel('contacts');
    }

    refresh(force = false) {
        this._probe();
        this.readClipboard();
        const now = Date.now();
        if (!force && now - this._lastRefreshAt < REFRESH_THROTTLE_MS)
            return;
        this._lastRefreshAt = now;
        if (this.daemon) {
            this.refreshContacts();
            this.refreshSettings();
        }
        this.refreshCameras();
        this.refreshMics();
    }

    // Set (or, with null, clear) daemonTarget. If the probe never sees the
    // daemon get there, stop pretending after a while.
    _headFor(target) {
        this._daemonTarget = target;
        if (target === null)
            this._cancel('daemon-target');
        else
            this._later('daemon-target', 10000, () => {
                this._daemonTarget = null;
                this._changed();
            });
    }

    turnOn() {
        const proc = this.run(['start'], {
            onDone: reply => {
                if (!reply.ok)
                    this._headFor(null);
                this.say(reply.ok ? 'Tuple is on' : reply.message, !reply.ok);
                this._probe();
            },
        });
        if (proc)
            this._headFor(true);
        this._changed();
    }

    // Stop following first: `tuple state follow` would start the daemon
    // right back up if it reconnected in the gap.
    turnOff() {
        this._summaryProc?.kill();
        const proc = this.run(['stop'], {
            replyAs: 'off',
            onDone: reply => {
                if (!reply.ok)
                    this._headFor(null);
                this.say(reply.ok ? 'Tuple stopped' : reply.message, !reply.ok);
                this._probe();
            },
        });
        if (proc)
            this._headFor(false);
        this._changed();
    }

    toggleDaemon() {
        if (this.daemon)
            this.turnOff();
        else
            this.turnOn();
    }

    // ── State summary feed ────────────────────────────────────────────────
    _startSummary() {
        if (this._summaryProc || this.demo !== '' || !this.installed || !this.daemon)
            return;
        const proc = new Proc([this.tuple, 'state', 'follow', '--format', 'json'], {
            keep: false,
            onLine: line => this._onSummaryLine(line),
            onDone: p => {
                this._procs.delete(p);
                if (this._summaryProc === p)
                    this._summaryProc = null;
                // The stream ends when the daemon does; look before restarting
                // it, or we'd start the daemon again.
                if (!this._destroyed)
                    this._later('summary-restart', 3000, () => this._probe());
            },
        });
        this._summaryProc = proc;
        this._procs.add(proc);
        proc.start();
    }

    _onSummaryLine(line) {
        const next = Model.parseSummary(line);
        if (!next)
            return;
        const prev = this.summary;
        this.summary = next;
        this.muted = next.muted;
        this._onSummary(prev, next);
        this._changed();
    }

    _onSummary(prev, next) {
        const wasSignedIn = !!(prev && prev.signedIn);
        const wasInCall = !!(prev && prev.inCall);
        if (next.signedIn && !wasSignedIn) {
            this.loginPending = false;
            this.loginUrl = '';
            this._contactsSettle = 0;
            this.refreshContacts();
            this.refreshSettings();
            this._refreshMe(next);
        } else if (!next.signedIn && wasSignedIn) {
            this.me = null;
            this._search = null;
            this.contacts = [];
            this.contactsLoaded = false;
            this._contactsText = '';
        }

        if (next.inCall && !wasInCall) {
            this.refreshMics();
            this.refreshCameras();
        } else if (!next.inCall && wasInCall) {
            this.log = Model.clearCall(this.log);
            this._micRoutedThisCall = false;
            this._cancel('everyone-left');
            if (this.cameraOn && this._settings.get_boolean('camera-follows-call'))
                this.setCamera(false);
        }

        if (next.inCall && wasInCall)
            this._onRosterChange(prev.participants, next.participants);

        // Presence isn't in the summary, but its counts move with it.
        if (prev && next.signedIn && (prev.counts.online !== next.counts.online ||
            prev.counts.onlineFavorites !== next.counts.onlineFavorites) &&
            Date.now() - this._lastPresenceRefreshAt > PRESENCE_REFRESH_MS) {
            this._lastPresenceRefreshAt = Date.now();
            this._later('contacts', 1000, () => this.refreshContacts());
        }
    }

    // Tuple's own toasts for these are stubs on Linux, so post them here.
    _onRosterChange(before, after) {
        const had = new Set(before.map(p => p.id));
        const joined = after.filter(p => !had.has(p.id));
        if (joined.length > 0 && this.calling === null && this._settings.get_boolean('notify-joins')) {
            const who = joined.length === 1 ? joined[0].name : `${joined.length} people`;
            this.notify(`${who} joined`, "You're pairing now.", {transient: true, email: joined.length === 1 ? joined[0].email : ''});
        }
        if (after.length > 0) {
            this._cancel('everyone-left');
        } else if (before.length > 0) {
            // A link call stays open after the last person leaves.
            this._later('everyone-left', 15000, () => {
                if (!this.summary?.inCall || this.peers.length > 0)
                    return;
                this.notify('Everyone left', 'Your call is still open. End it?', {
                    actions: [{label: 'End call', callback: () => this.endCall()}],
                });
            });
        }
    }

    // ── Account ───────────────────────────────────────────────────────────
    // Who's signed in, for the "you" row. The summary has only a short name;
    // `whoami` has the full one.
    _refreshMe(summary) {
        this.me = {name: summary.shortName || summary.email, email: summary.email};
        this.run(['whoami', '--format', 'json'], {
            quiet: true,
            onDone: (reply, proc) => {
                try {
                    const j = JSON.parse(proc.out.join('\n'));
                    if (j.email)
                        this.me = {name: j.full_name || j.short_name || j.email, email: j.email};
                } catch {}
            },
        });
    }

    login() {
        this.loginUrl = '';
        this.run(['login'], {
            onLine: line => {
                const url = Model.parseLoginUrl(line);
                if (url !== '') {
                    this.loginUrl = url;
                    this._changed();
                }
            },
            onDone: reply => {
                if (/already (logged|signed) in/i.test(reply.message)) {
                    this.loginPending = false;
                    this.refreshContacts();
                    return;
                }
                this.loginPending = reply.ok;
                if (this.loginUrl === '')
                    this.loginUrl = Model.parseLoginUrl(reply.lines.join('\n'));
                this.say(reply.ok ? 'Finish logging in in your browser, then paste the code' : reply.message, !reply.ok);
            },
        });
    }

    submitAuth(code) {
        const c = String(code || '').trim();
        if (c === '')
            return;
        this.run(['auth', c], {
            replyAs: 'auth',
            onDone: reply => {
                const ok = reply.ok && !/login failed|unknown token|no auth session/i.test(reply.lines.join('\n'));
                if (ok) {
                    this.loginPending = false;
                    this.loginUrl = '';
                    this.say('Logged in');
                    this._contactsSettle = 0;
                    this._later('contacts', 1500, () => this.refreshContacts());
                } else {
                    this.say(reply.message || 'Login failed', true);
                }
            },
        });
    }

    logout() {
        this.run(['logout'], {
            replyAs: 'logout',
            onDone: reply => {
                this.contacts = [];
                this.contactsLoaded = false;
                this._contactsText = '';
                this.say(reply.ok ? 'Logged out' : reply.message, !reply.ok);
            },
        });
    }

    // ── Contacts ──────────────────────────────────────────────────────────
    // Presence changes aren't in the log, so re-list contacts periodically
    // (and when the summary's online counts move).
    _scheduleContactRefresh() {
        const seconds = Math.max(10, Math.min(3600, this._settings.get_int('refresh-interval')));
        this._every('contacts-periodic', seconds * 1000, () => {
            if (this.loggedIn)
                this.refreshContacts();
        });
    }

    // Only favourites, recents and whoever's online are held here; the whole
    // directory (thousands of people) stalled the shell to parse, so
    // bin/tuple-contacts filters it in its own process, and search asks Tuple.
    refreshContacts() {
        if (!this.daemon || this.auth === 0)
            return;
        this.run([], {
            name: 'contacts',
            helper: 'tuple-contacts',
            quiet: true,
            onDone: (reply, proc) => {
                const text = proc.out.join('\n');
                const parsed = Model.parseContactsJson(text);
                if (!parsed) {
                    const err = Model.jsonError(proc.err.join('\n') || text);
                    if (err && (err.code === 401 || /not signed in/i.test(err.message))) {
                        this.contacts = [];
                        this.contactsLoaded = false;
                        this._contactsText = '';
                    } else if (!reply.ok) {
                        this.say(reply.message, true);
                    }
                    return;
                }
                this.contactsLoaded = true;
                if (text === this._contactsText) {
                    this._contactsSettle = 0;
                    return;
                }
                // The daemon fills the directory in gradually after login or
                // startup; keep re-listing every few seconds until it settles.
                const grew = text.length > this._contactsText.length;
                this._contactsText = text;
                if (grew && this._contactsSettle < 12) {
                    this._contactsSettle++;
                    this._later('contacts', 5000, () => this.refreshContacts());
                }
                this.contacts = parsed;
            },
        });
    }

    _person(contact) {
        return contact.email || contact.name;
    }

    toggleFavorite(contact) {
        if (!contact)
            return;
        const verb = contact.favorite ? 'unfavorite' : 'favorite';
        this.run(['contacts', verb, this._person(contact)], {
            name: 'favorite',
            onDone: reply => {
                const done = contact.favorite
                    ? `Removed ${contact.name} from favorites`
                    : `Added ${contact.name} to favorites`;
                this.say(reply.ok ? done : reply.message, !reply.ok);
                this.refreshContacts();
                // Search results carry the old star too.
                const query = this._search?.query;
                this._search = null;
                if (query)
                    this.searchContacts(query);
            },
        });
    }

    // Search the whole directory through Tuple (`contacts list -q`, ~10ms in
    // its own process). Results for an older query are dropped.
    searchContacts(query) {
        const q = String(query || '').trim();
        if (q === '' || !this.loggedIn) {
            this._search = null;
            this._searching = '';
            this._changed();
            return;
        }
        if (this._search?.query === q || this._searching === q)
            return;
        if (this.demo !== '') {
            this._search = {query: q, results: Model.searchContacts(this.contacts, q, 60)};
            this._changed();
            return;
        }
        const seq = ++this._searchSeq;
        this._searching = q;
        this.run([q], {
            name: 'search',
            helper: 'tuple-contacts',
            quiet: true,
            exclusive: false,
            onDone: (reply, proc) => {
                if (seq !== this._searchSeq)
                    return;
                this._searching = '';
                const results = Model.parseContactsJson(proc.out.join('\n'));
                if (results)
                    this._search = {query: q, results};
                else if (!reply.ok)
                    this.say(reply.message, true);
            },
        });
        this._changed();
    }

    get searching() {
        return this._searching !== '';
    }

    // `tuple call start` rings them and waits: it exits 0 once they answer
    // and 2 if the call ends first (declined, busy, or 25s unanswered).
    callContact(contact) {
        if (!contact)
            return;
        if (this.inCall || this.incoming) {
            this.say("You're already in a call", true);
            return;
        }
        const proc = this.run(['call', 'start', this._person(contact)], {
            onDone: (reply, p) => {
                const cancelled = this.calling === null;
                this.calling = null;
                if (reply.ok) {
                    this.say(`${contact.name} answered`);
                } else if (cancelled) {
                    this.say('Call cancelled');
                } else if (p.exitCode === 2) {
                    this.say(`${contact.name} didn't answer`, true);
                    this.notify('No answer', `${contact.name} didn't pick up. Try New call and send them the link.`, {email: contact.email});
                } else {
                    this.say(reply.message, true);
                }
            },
        });
        if (!proc)
            return;
        this.calling = contact;
        this._callProc = proc;
        this.say(`Calling ${contact.name}…`);
    }

    // ── Calls ─────────────────────────────────────────────────────────────
    newCall() {
        this.run(['new'], {
            onLine: line => {
                const url = Model.parsePersonalUrl(line);
                if (url !== '') {
                    this.personalUrl = url;
                    if (this._settings.get_boolean('copy-link-on-new-call'))
                        this._host.copy(url);
                } else if (line.trim() !== '' && !Model.parseLogLine(line)) {
                    this.actionStatus = line.trim();
                }
                this._changed();
            },
            onDone: reply => {
                if (!reply.ok)
                    this.say(reply.message, true);
                else if (this.personalUrl !== '' && this._settings.get_boolean('copy-link-on-new-call'))
                    this.say('Call link copied — share it to pair');
                else
                    this.say(reply.message);
            },
        });
    }

    join(url) {
        const u = Model.extractCallUrl(url) || String(url || '').trim();
        if (!Model.isCallUrl(u)) {
            this.say("That isn't a Tuple call link (https://tuple.app/c/…)", true);
            return;
        }
        this.run(['call', 'join', u], {name: 'join'});
    }

    joinClipboard() {
        this._host.readClipboard(text => {
            const url = Model.extractCallUrl(text);
            if (url !== '')
                this.join(url);
            else
                this.say('No Tuple call link on the clipboard', true);
        });
    }

    setMuted(on) {
        this.run(['call', on ? 'mute' : 'unmute'], {
            name: on ? 'mute' : 'unmute',
            onDone: reply => {
                if (reply.ok || /^already/i.test(reply.message))
                    this.muted = on;
                this.say(reply.ok ? (on ? 'Microphone muted' : 'Microphone live') : reply.message, !reply.ok);
            },
        });
    }

    toggleMute() {
        this.setMuted(!this.muted);
    }

    setSharing(on) {
        this.run([on ? 'share' : 'unshare'], {
            replyAs: on ? 'share' : 'unshare',
            onDone: reply => {
                this.say(reply.ok ? (on ? 'Sharing your screen' : 'Stopped sharing') : reply.message, !reply.ok);
            },
        });
    }

    toggleShare() {
        this.setSharing(!this.sharing);
    }

    endCall() {
        if (this.calling !== null) {
            // Still ringing: hang up and stop waiting for an answer.
            this.calling = null;
            this._callProc?.kill();
        }
        this.run(['call', 'leave'], {
            name: 'end',
            replyAs: 'end',
            onDone: reply => this.say(reply.ok ? 'Call ended' : reply.message, !reply.ok),
        });
    }

    answer() {
        this.run(['call', 'accept'], {
            name: 'accept',
            onDone: reply => {
                if (reply.ok) {
                    this.say('Answered');
                    return;
                }
                // Tuple's own prompt can still take it.
                if (!this._host.focusWindow('incoming-call'))
                    this.say(reply.message, true);
            },
        });
    }

    decline() {
        this.run(['call', 'leave'], {
            name: 'end',
            onDone: reply => this.say(reply.ok ? 'Declined' : reply.message, !reply.ok),
        });
    }

    // Their shared screen is Tuple's "screen" window.
    viewScreen() {
        if (!this._host.focusWindow('screen'))
            this.say("Their screen isn't open", true);
    }

    // How you interact with their screen: draw on it, or drive it.
    setGuestMode(mode) {
        if (mode !== 'annotation' && mode !== 'control')
            return;
        this.setTupleSetting('guest-mode', mode);
        this.say(mode === 'control' ? 'You can control their screen' : 'You can draw on their screen');
    }

    openDebugUi() {
        this.run(['ui'], {quiet: true});
    }

    // ── Camera ────────────────────────────────────────────────────────────
    // Tuple for Linux can't send webcam video yet, so your camera is a local
    // tile (bin/tuple-selfcam, mpv) on the call stage next to theirs, and it
    // reaches them only through your screen share.
    setCamera(on) {
        if (on === this.cameraOn)
            return;
        if (on) {
            const cam = this.camera;
            this._startCamera(cam ? cam.dev : this._settings.get_string('camera-device'));
            this.say(this.sharing
                ? 'They see your camera through your screen share'
                : 'Only you can see this until you share your screen', !this.sharing);
        } else {
            this._cameraStopping = true;
            this._cameraProc?.kill();
        }
    }

    _startCamera(dev) {
        if (this.demo !== '')
            return;
        this._cameraStopping = false;
        const proc = new Proc([this.helper('tuple-selfcam'), String(dev || '')], {
            onDone: p => {
                this._procs.delete(p);
                if (this._cameraProc === p)
                    this._cameraProc = null;
                const err = p.err.find(l => l.trim() !== '') ?? '';
                if (!this._cameraStopping && p.exitCode !== 0) {
                    if (p.exitCode === 3)
                        this.say('No webcam found', true);
                    else if (p.exitCode === 127)
                        this.say('Install mpv to show your camera (sudo pacman -S mpv)', true);
                    else
                        this.say(err || 'Camera stopped — is another app using it?', true);
                }
                this._cameraStopping = false;
                this._host.arrangeWindows();
                if (this._cameraSwitchTo) {
                    const next = this._cameraSwitchTo;
                    this._cameraSwitchTo = '';
                    this._startCamera(next);
                }
                this._changed();
            },
        });
        this._cameraProc = proc;
        this._procs.add(proc);
        proc.start();
        this._host.arrangeWindows();
        this._changed();
    }

    toggleCamera() {
        this.setCamera(!this.cameraOn);
    }

    // Remember the camera by name (/dev/videoN numbers move between boots)
    // and, if the tile is up, switch it over once mpv lets go.
    chooseCamera(cam) {
        if (!cam)
            return;
        this._settings.set_string('camera-device', cam.name);
        this._switchCamera(cam.dev);
        this.say(`Camera: ${cam.name}`);
    }

    _switchCamera(dev) {
        if (!this.cameraOn || !dev)
            return;
        this._cameraSwitchTo = dev;
        this._cameraStopping = true;
        this._cameraProc.kill();
    }

    cycleCamera() {
        this.chooseCamera(Model.nextCamera(this.cameras, this.camera));
    }

    // '' = system default.
    chooseCameraName(name) {
        const n = String(name || '');
        if (n === '') {
            this._settings.set_string('camera-device', '');
            this._switchCamera(this.cameras[0]?.dev);
            this.say('Camera: system default');
            return;
        }
        this.chooseCamera(Model.findCamera(this.cameras, n));
    }

    // Pick a camera by name, device path, or 1-based position (IPC).
    selectCamera(query) {
        const q = String(query || '').trim();
        if (q === '' || q === 'default') {
            this.chooseCameraName('');
            return;
        }
        const n = parseInt(q, 10);
        if (/^\d+$/.test(q) && n >= 1 && n <= this.cameras.length) {
            this.chooseCamera(this.cameras[n - 1]);
            return;
        }
        const lower = q.toLowerCase();
        const cam = this.cameras.find(c => c.dev === q || c.name.toLowerCase().includes(lower));
        if (cam)
            this.chooseCamera(cam);
        else
            this.say(`No camera matches “${q}”`, true);
    }

    refreshCameras() {
        if (this._cameraList)
            return;
        this._cameraList = new Proc([this.helper('tuple-cameras')], {
            timeoutMs: 10000,
            onDone: p => {
                this._cameraList = null;
                this.cameras = Model.parseCameras(p.out.join('\n'));
                this._changed();
            },
        }).start();
    }

    // ── Microphone ────────────────────────────────────────────────────────
    refreshMics() {
        if (this._micList)
            return;
        this._micList = new Proc(['bash', '-c',
            "pactl get-default-source 2>/dev/null; echo '---'; pactl -f json list sources 2>/dev/null"], {
            timeoutMs: 10000,
            onDone: p => {
                this._micList = null;
                const text = p.out.join('\n');
                const at = text.indexOf('---');
                if (at < 0)
                    return;
                this.defaultMic = text.slice(0, at).trim();
                this.mics = Model.parseMics(text.slice(at + 3));
                this._changed();
            },
        }).start();
    }

    // '' = system default.
    chooseMic(name) {
        const n = String(name || '');
        this._settings.set_string('mic-device', n);
        const m = Model.findMic(this.mics, n);
        this.say(n === '' ? 'Microphone: system default' : `Microphone: ${m ? m.label : n}`);
    }

    selectMic(query) {
        const q = String(query || '').trim();
        if (q === '' || q === 'default') {
            this.chooseMic('');
            return;
        }
        const n = parseInt(q, 10);
        if (/^\d+$/.test(q) && n >= 1 && n <= this.mics.length) {
            this.chooseMic(this.mics[n - 1].name);
            return;
        }
        const lower = q.toLowerCase();
        const mic = this.mics.find(m => m.name === q || m.label.toLowerCase().includes(lower));
        if (mic)
            this.chooseMic(mic.name);
        else
            this.say(`No microphone matches “${q}”`, true);
    }

    // Tuple for Linux records from the default source and has no input
    // setting. While a call is up, keep its stream on the chosen input
    // (bin/tuple-mic-route); with "system default" it's left alone, unless you
    // switch back mid-call.
    _syncMicRoute() {
        if (this.demo !== '')
            return;
        const target = this.micDevice !== '' ? this.micDevice : (this._micRoutedThisCall ? '@DEFAULT_SOURCE@' : '');
        const key = this.inCall && target !== '' ? `${this.log.pid}|${target}` : '';
        if (key === this._micRouteKey)
            return;
        this._micRouteKey = key;
        this._micRoute?.kill();
        this._micRoute = null;
        if (key === '')
            return;
        if (this.micDevice !== '')
            this._micRoutedThisCall = true;
        const proc = new Proc([this.helper('tuple-mic-route'), String(this.log.pid), target], {
            onDone: p => {
                this._procs.delete(p);
                if (this._micRoute === p)
                    this._micRoute = null;
            },
        });
        this._micRoute = proc;
        this._procs.add(proc);
        proc.start();
    }

    // ── Settings ──────────────────────────────────────────────────────────
    refreshSettings() {
        if (!this.daemon)
            return;
        this.run(['settings'], {
            quiet: true,
            onDone: reply => {
                if (reply.ok)
                    this.tupleSettings = Model.parseSettings(reply.lines.join('\n'));
            },
        });
    }

    setTupleSetting(name, value) {
        // Show it now; the `settings` re-read afterwards confirms or corrects it.
        this.tupleSettings = this.tupleSettings.map(x => x.name === name ? {...x, value: String(value)} : x);
        this._changed();
        this.run(['set', name, String(value)], {
            exclusive: false,
            onDone: reply => {
                if (!reply.ok)
                    this.say(reply.message, true);
                this.refreshSettings();
            },
        });
    }

    cycleSetting(setting) {
        if (!setting || setting.type === 'text')
            return;
        this.setTupleSetting(setting.name, Model.nextChoice(setting));
    }

    // ── Clipboard ─────────────────────────────────────────────────────────
    readClipboard() {
        this._host.readClipboard(text => {
            const url = Model.extractCallUrl(String(text || '').slice(0, 4096));
            if (url !== this.clipboardCallUrl) {
                this.clipboardCallUrl = url;
                this._changed();
            }
        });
    }

    // ── Daemon log ────────────────────────────────────────────────────────
    // The log is truncated each time the daemon starts; tail -F follows that
    // and re-reads from the top, and Model.reduceLog resets on the banner.
    _startLogFollower() {
        const dataHome = GLib.get_user_data_dir();
        const proc = new Proc(['bash', '-c',
            'd="$1/tuple"; pick() { ls -t "$d"/*/log.txt 2>/dev/null | head -1; }; ' +
            'f=$(pick); while [ -z "$f" ]; do sleep 3; f=$(pick); done; ' +
            // While they share, Tuple logs every move of their cursor (~99% of
            // a call's log): drop it here. tail --pid ties tail's life to this
            // process (grep, after exec), so stopping it doesn't leave tail on.
            "exec grep --line-buffered -vE '\\|user [0-9]+ mouse |TODO: handle cursor update' " +
            '< <(exec tail --pid=$$ -n +1 -F "$f" 2>/dev/null)', 'follow', dataHome], {
            keep: false,
            onLine: line => this._onLogLine(line),
            onDone: p => {
                this._procs.delete(p);
                if (!this._destroyed)
                    this._later('log-restart', 3000, () => this._startLogFollower());
            },
        });
        this._procs.add(proc);
        proc.start();
    }

    _onLogLine(line) {
        const entry = Model.parseLogLine(line);
        if (!entry || this.demo !== '')
            return;
        const before = this.log;
        const next = Model.reduceLog(before, entry);
        if (next === before)
            return;
        this.log = next;
        this._onLogEvent(before, next, entry);
        this._changed();
    }

    // Log times are UTC; replays on shell start shouldn't trigger side effects.
    static isLive(entry) {
        const d = new Date();
        const now = d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds();
        const diff = Math.abs(now - Model.logSeconds(entry.time));
        return Math.min(diff, 86400 - diff) < 30;
    }

    _onLogEvent(before, next, entry) {
        const live = Service.isLive(entry);
        if (next.call === 'ending')
            this._later('ending-fallback', 4000, () => {
                this.log = Model.resolveEnding(this.log);
                this._changed();
            });
        if (next.windows.join() !== before.windows.join() && live)
            this._host.arrangeWindows();
        if (next.joinRequest && !before.joinRequest && live) {
            this.notify('Someone wants to join', "Let them in from Tuple's prompt.", {
                urgency: 'critical',
                actions: [{label: 'Show', callback: () => this._host.focusWindow('join-request')}],
            });
        }
        if (next.exited && !before.exited)
            this._probe();
        if (next.call === 'incoming' && before.call !== 'incoming') {
            // Tuple stops ringing after ~25s; if the log never says how it
            // ended, stop showing it a little after that.
            this._later('incoming-fallback', 45000, () => {
                if (this.log.call !== 'incoming')
                    return;
                this.log = Model.resolveStaleIncoming(this.log);
                this._changed();
            });
            if (live && this._settings.get_boolean('notify-incoming')) {
                this._incomingNote?.destroy();
                this._incomingNote = this.notify('Incoming Tuple call', `${this.incomingFrom || 'Someone'} wants to pair`, {
                    email: this.incomingPerson.email,
                    urgency: 'critical',
                    actions: [
                        {label: 'Answer', callback: () => this.answer()},
                        {label: 'Decline', callback: () => this.decline()},
                    ],
                });
            }
        }
        if (next.call !== 'incoming' && before.call === 'incoming') {
            this._incomingNote?.destroy();
            this._incomingNote = null;
        }
    }

    // ── Diagnostics ───────────────────────────────────────────────────────
    // Evidence for "the video was choppy": a CPU/window-size sample every 20s
    // of a call, in ~/.local/state/tuple-gnome/perf.log (bin/tuple-perf); and
    // a rolling copy of the daemon log, which is truncated on every start.
    tick() {
        const now = Date.now();
        if (this.demo !== '')
            return;
        if (this.inCall && this._settings.get_boolean('perf-log') && now - (this._lastPerfAt ?? 0) >= 20000 && !this._perf) {
            this._lastPerfAt = now;
            this._perf = new Proc([this.helper('tuple-perf'), '', this._host.windowSizes()], {
                timeoutMs: 10000,
                onDone: () => {
                    this._perf = null;
                },
            }).start();
        }
        if (this.daemon && this._settings.get_boolean('archive-logs') && now - (this._lastArchiveAt ?? 0) >= 15000 && !this._archive) {
            this._lastArchiveAt = now;
            this._archive = new Proc([this.helper('tuple-archive'), GLib.get_user_data_dir()], {
                timeoutMs: 20000,
                onDone: () => {
                    this._archive = null;
                },
            }).start();
        }
    }

    // ── Demo data (for screenshots and UI work without an account) ─────────
    setDemo(name) {
        const scenario = String(name || '');
        this.actionStatus = '';
        this.lastError = '';
        this._headFor(null);
        if (scenario === '' || scenario === 'off' || scenario === 'live') {
            this.demo = '';
            this.summary = null;
            this.log = Model.emptyState();
            this.contacts = [];
            this.contactsLoaded = false;
            this._contactsText = '';
            this.muted = false;
            this.personalUrl = '';
            this.loginUrl = '';
            this.loginPending = false;
            this.calling = null;
            this.me = null;
            this.daemon = false;
            this.daemonKnown = false;
            this._probe();
            this._changed();
            return 'live';
        }
        this.demo = scenario;
        this._summaryProc?.kill();
        this.daemon = scenario !== 'stopped';
        this.daemonKnown = true;
        this.calling = null;
        const signedIn = scenario !== 'login';
        const contacts = [
            {id: 101, email: 'alice@example.com', full_name: 'Alice Smith', favorited: true, recent: true, status: 'online', call: scenario === 'call' || scenario === 'viewing' ? {id: 'c'} : null},
            {id: 102, email: 'bob@example.com', full_name: 'Bob Jones', favorited: true, recent: false, status: 'offline'},
            {id: 103, email: 'carol@example.com', full_name: 'Carol Diaz', favorited: true, recent: false, status: 'busy', call: {id: 'x'}},
            {id: 104, email: 'dev@example.com', full_name: 'Dev Patel', favorited: true, recent: true, status: 'online'},
            {id: 105, email: 'erin@example.com', full_name: 'Erin Park', favorited: false, recent: true, status: 'offline'},
            {id: 106, email: 'femi@example.com', full_name: 'Femi Ade', favorited: false, recent: false, status: 'online'},
        ];
        this.contacts = signedIn ? Model.parseContactsJson({contacts}) : [];
        this.contactsLoaded = signedIn;
        this.tupleSettings = Model.parseSettings(
            'overlay | 1 | Show "overlay" annotation window when sharing screen (0|1)\n' +
            'start-calls-muted | 0 | Start with microphone muted when joining a call (0|1)\n' +
            'capture | auto | Screen capture mechanism (auto|x11|portal)\n' +
            'guest-mode | annotation | Current mode in screen window (annotation|control)\n');
        const inCall = scenario === 'call' || scenario === 'viewing';
        this.summary = Model.parseSummary({
            in_call: inCall,
            call: inCall ? {
                call_id: 'demo', muted: scenario === 'call', transcribing: false, active_room_slug: null,
                participants: [{id: 101, name: 'Alice Smith', email: 'alice@example.com', session_id: 's', muted: false, connection_state: 'connected'}],
            } : null,
            user: signedIn ? {id: 1, email: 'you@example.com', short_name: 'You'} : {id: 0, email: '', short_name: ''},
            contacts: {total: 6, online: 3, busy: 1, favorites: {total: 4, online: 2, online_names: []}},
            connection: {websocket_state: signedIn ? 'connected' : 'disconnected', is_internet_connected: true},
            app_version: 'v2026_10_23.0',
        });
        this.muted = this.summary.muted;
        this.me = signedIn ? {name: 'You Example', email: 'you@example.com'} : null;
        const s = Model.emptyState();
        s.version = 'v2026_10_23.0';
        if (scenario === 'call')
            s.sharing = true;
        if (scenario === 'viewing') {
            s.peerWebcam = true;
            s.peerSharing = '101';
            s.windows = ['webcam', 'screen'];
        }
        if (scenario === 'incoming') {
            s.call = 'incoming';
            s.incomingFrom = 'Alice Smith';
        }
        this.log = s;
        this.personalUrl = inCall ? 'https://tuple.app/c/demo-room' : '';
        this.loginUrl = scenario === 'login' ? 'https://production.tuple.app/start?code_challenge=demo&os=linux' : '';
        this.loginPending = scenario === 'login';
        this._changed();
        return scenario;
    }

    // ── IPC ───────────────────────────────────────────────────────────────
    statusJson() {
        return JSON.stringify({
            installed: this.installed,
            tuple: this.tuple,
            daemon: this.daemon,
            loggedIn: this.loggedIn,
            user: this.summary ? this.summary.email : '',
            me: this.me ? this.me.name : '',
            call: this.call,
            peers: this.peerNames,
            peerIds: this.peers.map(p => p.id),
            muted: this.muted,
            sharing: this.sharing,
            peerSharing: this.peerSharing,
            peerWebcam: this.peerWebcam,
            camera: this.cameraOn,
            cameraDevice: this.cameraIsDefault ? 'default' : (this.camera ? this.camera.name : ''),
            micDevice: this.micIsDefault ? 'default' : (this.mic ? this.mic.label : ''),
            contacts: this.contacts.length,
            directory: this.contactCounts.total,
            incomingFrom: this.incomingFrom,
            websocket: this.summary ? this.summary.websocket : '',
            version: this.version,
            personalUrl: this.personalUrl,
            lastEvent: this.log.lastEvent,
            pending: [...this.pending],
            demo: this.demo,
            message: this.lastError || this.actionStatus,
            text: this.statusText,
        });
    }
}
