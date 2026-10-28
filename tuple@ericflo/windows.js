// Gives Tuple's windows a home in GNOME Shell, as omarchy-tuple's
// bin/tuple-windows and hypr/tuple.lua did on Hyprland:
//
//   1. Tuple's prompts are centred, and the two that want an answer (an
//      incoming call, someone asking to join) stay on top and take focus;
//   2. the camera "stage": their webcam(s) and your own camera tile
//      (bin/tuple-selfcam) start as equal squares side by side in the
//      bottom-right corner, yours rightmost, above other windows on every
//      workspace, without taking focus. Once you move or resize one, it's
//      yours: it isn't put back;
//   3. Tuple's annotation overlay is kept out of the way. With no layer-shell
//      on GNOME, Tuple falls back to an opaque fullscreen window that covers
//      the whole screen and takes every click while you share
//      ("overlay: using xdg_toplevel fullscreen fallback"). It's minimized
//      the moment it shows. (service.js also turns Tuple's overlay setting
//      off; this is the backstop.)
//
// Tuple names its windows by role: X11 WM_CLASS ("tuple-webcams", "Tuple"),
// or on Wayland the app id tuple-webcams, tuple-screen, tuple-overlay, …
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const PROMPTS = ['incoming-call', 'join-request', 'error', 'external-url', 'main'];
const URGENT = ['incoming-call', 'join-request'];
const STAGE = ['webcams', 'selfcam'];
const STAGE_PERCENT = {small: 14, medium: 18, large: 24};
const GAP = 10;
const MARGIN = 40;
// How far a tile may sit from where we put it before we take it that you
// moved it (a client can round a size to keep its aspect).
const SLACK = 6;

// "webcams", "screen", "overlay", … for Tuple's windows, "selfcam" for your
// camera tile, "" for everything else.
export function windowRole(win) {
    const cls = win.get_wm_class() ?? '';
    const instance = win.get_wm_class_instance() ?? '';
    if (cls === 'tuple-selfcam' || win.get_title() === 'tuple-selfcam')
        return 'selfcam';
    if (cls === 'Tuple')
        return instance.replace(/^tuple-/, '') || 'tuple';
    if (cls.startsWith('tuple-'))
        return cls.slice('tuple-'.length);
    return '';
}

// The log's names (webcam, join_request) → the windows' (webcams, join-request).
function sameRole(role, wanted) {
    const norm = r => r.replace(/_/g, '-').replace(/^webcam$/, 'webcams');
    return norm(role) === norm(wanted);
}

export class WindowStage {
    // onOverlay(): Tuple's overlay showed up and was hidden.
    constructor(settings, {onOverlay = null} = {}) {
        this._settings = settings;
        this._onOverlay = onOverlay;
        this._prompted = new WeakSet();
        this._staged = new WeakSet();
        this._tracked = new WeakSet();
        this._yours = new WeakSet();     // stage tiles you've moved or resized
        this._targets = new WeakMap();   // where we last put each stage tile
        this._settled = new WeakSet();   // …and that got there (so a change after is yours)
        this._lastFocus = null;
        this._displayIds = [
            global.display.connect('window-created', (_d, win) => this._track(win)),
            global.display.connect('notify::focus-window', () => {
                const win = global.display.focus_window;
                if (win && windowRole(win) === '')
                    this._lastFocus = win;
            }),
            // Dragging or resizing a tile (Super+drag, Alt+F7/F8, or mpv's own
            // drag) makes it yours.
            global.display.connect('grab-op-begin', (_d, win) => {
                if (win && STAGE.includes(windowRole(win)))
                    this._yours.add(win);
            }),
        ];
        for (const actor of global.get_window_actors())
            this._track(actor.meta_window);
        this.arrange();
    }

    destroy() {
        for (const id of this._displayIds)
            global.display.disconnect(id);
        this._displayIds = [];
        for (const id of [this._idle, this._again]) {
            if (id)
                GLib.source_remove(id);
        }
        this._idle = this._again = 0;
        this._onOverlay = null;
    }

    // A window's role (WM_CLASS, app id) may arrive after it's created; look
    // again when it changes and when it's first shown.
    _track(win) {
        if (this._tracked.has(win))
            return;
        this._tracked.add(win);
        const look = () => {
            if (windowRole(win) !== '')
                this.arrange();
        };
        win.connectObject(
            'shown', look,
            'notify::wm-class', look,
            // A tile that changes size or place after it settled where we put
            // it was moved by you (mpv's scroll-to-resize, an X11 window's own
            // move). Until it settles, a mismatch is just our request in flight.
            'size-changed', () => this._watchTile(win),
            'position-changed', () => this._watchTile(win),
            'notify::minimized', () => {
                if (windowRole(win) === 'overlay' && !win.minimized)
                    this.arrange();
            },
            'unmanaged', () => {
                if (windowRole(win) !== '')
                    this.arrange();
                win.disconnectObject(this);
                if (this._lastFocus === win)
                    this._lastFocus = null;
            }, this);
        look();
    }

    _watchTile(win) {
        const target = this._targets.get(win);
        if (!target || this._yours.has(win) || !STAGE.includes(windowRole(win)))
            return;
        const r = win.get_frame_rect();
        const there = Math.abs(r.x - target.x) <= SLACK && Math.abs(r.y - target.y) <= SLACK &&
            Math.abs(r.width - target.size) <= SLACK && Math.abs(r.height - target.size) <= SLACK;
        if (there)
            this._settled.add(win);
        else if (this._settled.has(win))
            this._yours.add(win);
    }

    // Windows can show a moment before they've settled on a size, so place
    // them now and once more shortly after. Every pass is idempotent.
    arrange() {
        if (!this._idle) {
            this._idle = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this._idle = 0;
                this._arrangeNow();
                return GLib.SOURCE_REMOVE;
            });
        }
        if (this._again)
            GLib.source_remove(this._again);
        this._again = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 600, () => {
            this._again = 0;
            this._arrangeNow();
            return GLib.SOURCE_REMOVE;
        });
    }

    // Every window that's Tuple's (or your camera's), managed or not.
    _all() {
        return global.display.list_all_windows().filter(w => windowRole(w) !== '');
    }

    _windows() {
        return this._all().filter(w => !w.is_override_redirect());
    }

    _arrangeNow() {
        const windows = this._windows();

        // The overlay: out of sight, every time it shows (unless you've
        // turned keep-overlay-off off).
        for (const win of windows) {
            if (windowRole(win) !== 'overlay' || win.minimized || !this._settings.get_boolean('keep-overlay-off'))
                continue;
            win.unmake_above();
            win.minimize();
            this._onOverlay?.();
        }

        // Prompts: centre once; raise and focus the ones that need an answer.
        for (const win of windows) {
            const role = windowRole(win);
            if (!PROMPTS.includes(role) || this._prompted.has(win))
                continue;
            this._prompted.add(win);
            const area = Main.layoutManager.getWorkAreaForMonitor(win.get_monitor());
            const rect = win.get_frame_rect();
            win.move_frame(true,
                area.x + Math.round((area.width - rect.width) / 2),
                area.y + Math.round((area.height - rect.height) / 2));
            if (URGENT.includes(role)) {
                win.make_above();
                win.stick();
                Main.activateWindow(win);
            }
        }

        this._arrangeStage(windows);
    }

    // The stage, ordered: their webcams, then yours (rightmost). A tile
    // you've moved or resized keeps its place and size, and the others close
    // up around it; the rest are (re)placed on every pass until they get there.
    _arrangeStage(windows) {
        const theirs = windows.filter(w => windowRole(w) === 'webcams')
            .sort((a, b) => a.get_stable_sequence() - b.get_stable_sequence());
        const all = theirs.concat(windows.filter(w => windowRole(w) === 'selfcam'));
        for (const win of all) {
            if (!win.is_above())
                win.make_above();
            if (!win.is_on_all_workspaces())
                win.stick();
        }
        const tiles = all.filter(w => !this._yours.has(w));
        if (tiles.length === 0)
            return;
        const monitor = tiles[0].get_monitor();
        const area = Main.layoutManager.getWorkAreaForMonitor(monitor);
        const geometry = global.display.get_monitor_geometry(monitor);
        const percent = STAGE_PERCENT[this._settings.get_string('camera-size')] ?? STAGE_PERCENT.medium;
        const size = Math.round(geometry.height * percent / 100);
        const n = tiles.length;
        let stoleFocus = false;
        tiles.forEach((win, i) => {
            const x = area.x + area.width - MARGIN - (n - i) * size - (n - 1 - i) * GAP;
            const y = area.y + area.height - MARGIN - size;
            const previous = this._targets.get(win);
            if (!previous || previous.x !== x || previous.y !== y || previous.size !== size)
                this._settled.delete(win);   // a new spot: settle there first
            this._targets.set(win, {x, y, size});
            const rect = win.get_frame_rect();
            if (rect.x !== x || rect.y !== y || rect.width !== size || rect.height !== size)
                win.move_resize_frame(true, x, y, size, size);
            else
                this._settled.add(win);
            if (!this._staged.has(win)) {
                this._staged.add(win);
                if (global.display.focus_window === win)
                    stoleFocus = true;
            }
        });
        if (stoleFocus && this._lastFocus)
            Main.activateWindow(this._lastFocus);
    }

    // The camera-size setting changed: lay every tile out again, including
    // ones you'd moved.
    resetStage() {
        this._yours = new WeakSet();
        this._targets = new WeakMap();
        this._settled = new WeakSet();
        this.arrange();
    }

    // Bring one of Tuple's windows forward ("screen", "incoming-call", …).
    focus(role) {
        const win = this._windows().find(w => sameRole(windowRole(w), role));
        if (!win)
            return false;
        Main.activateWindow(win);
        return true;
    }

    // Hide the overlay if it's up. True if there was one.
    hideOverlay() {
        let hid = false;
        for (const win of this._windows()) {
            if (windowRole(win) === 'overlay' && !win.minimized) {
                win.minimize();
                hid = true;
            }
        }
        return hid;
    }

    // "screen=1920x1080 webcams=194x194" for bin/tuple-perf; X11 windows
    // that bypass the window manager count too, marked "(or)".
    sizes() {
        return this._all()
            .filter(w => ['screen', 'webcams', 'selfcam'].includes(windowRole(w)))
            .map(w => {
                const r = w.get_frame_rect();
                const notes = [w.is_fullscreen() ? 'full' : '', w.is_override_redirect() ? 'or' : '',
                    w.get_client_type() === Meta.WindowClientType.X11 ? 'x11' : 'wl'].filter(x => x).join(',');
                return `${windowRole(w)}=${r.width}x${r.height}(${notes})`;
            })
            .join(' ');
    }

    // Everything we know about Tuple's windows, for `tuple-shell windows`.
    describe() {
        return this._all().map(w => {
            const r = w.get_frame_rect();
            return {
                role: windowRole(w),
                wmClass: w.get_wm_class(),
                instance: w.get_wm_class_instance(),
                title: w.get_title(),
                client: w.get_client_type() === Meta.WindowClientType.X11 ? 'x11' : 'wayland',
                overrideRedirect: w.is_override_redirect(),
                rect: [r.x, r.y, r.width, r.height],
                above: w.is_above(),
                sticky: w.is_on_all_workspaces(),
                minimized: w.minimized,
                fullscreen: w.is_fullscreen(),
                yours: this._yours.has(w),
            };
        });
    }
}
