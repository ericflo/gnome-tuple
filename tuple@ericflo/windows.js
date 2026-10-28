// Gives Tuple's windows a home in GNOME Shell, as omarchy-tuple's
// bin/tuple-windows and hypr/tuple.lua did on Hyprland:
//
//   1. Tuple's prompts are centred, and the two that want an answer (an
//      incoming call, someone asking to join) stay on top and take focus;
//   2. the camera "stage": their webcam(s) and your own camera
//      (bin/tuple-selfcam) as equal squares side by side in the bottom-right
//      corner, yours rightmost, above other windows on every workspace, and
//      without taking focus from what you were doing.
//
// The 2026_09 client drew every window over X11 with class "Tuple" and its
// role in the WM_CLASS instance (tuple-webcams, tuple-screen,
// tuple-join-request, …). Newer clients can draw natively on Wayland, where
// the role is expected to be the app id. Both are matched.
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const PROMPTS = ['incoming-call', 'join-request', 'error', 'external-url', 'main'];
const URGENT = ['incoming-call', 'join-request'];
const STAGE_PERCENT = {small: 14, medium: 18, large: 24};
const GAP = 10;
const MARGIN = 40;

// "webcams", "screen", "join-request", … for Tuple's windows, "selfcam" for
// your camera tile, "" for everything else.
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
    constructor(settings) {
        this._settings = settings;
        this._prompted = new WeakSet();
        this._staged = new WeakSet();
        this._tracked = new WeakSet();
        this._lastFocus = null;
        this._displayIds = [
            global.display.connect('window-created', (_d, win) => this._track(win)),
            global.display.connect('notify::focus-window', () => {
                const win = global.display.focus_window;
                if (win && windowRole(win) === '')
                    this._lastFocus = win;
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
    }

    // A window's role (WM_CLASS, app id) may arrive after it's created;
    // look again when it's first shown.
    _track(win) {
        if (this._tracked.has(win))
            return;
        this._tracked.add(win);
        win.connectObject(
            'shown', () => {
                if (windowRole(win) !== '')
                    this.arrange();
            },
            'unmanaged', () => {
                if (windowRole(win) !== '')
                    this.arrange();
                win.disconnectObject(this);
                if (this._lastFocus === win)
                    this._lastFocus = null;
            }, this);
        if (windowRole(win) !== '')
            this.arrange();
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

    _windows() {
        return global.display.list_all_windows().filter(w => !w.is_override_redirect() && windowRole(w) !== '');
    }

    _arrangeNow() {
        const windows = this._windows();

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

        // The stage, ordered: their webcams, then yours (rightmost).
        const theirs = windows.filter(w => windowRole(w) === 'webcams')
            .sort((a, b) => a.get_stable_sequence() - b.get_stable_sequence());
        const tiles = theirs.concat(windows.filter(w => windowRole(w) === 'selfcam'));
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
            if (!win.is_above())
                win.make_above();
            if (!win.is_on_all_workspaces())
                win.stick();
            const rect = win.get_frame_rect();
            if (rect.x !== x || rect.y !== y || rect.width !== size || rect.height !== size)
                win.move_resize_frame(true, x, y, size, size);
            if (!this._staged.has(win)) {
                this._staged.add(win);
                if (global.display.focus_window === win)
                    stoleFocus = true;
            }
        });
        if (stoleFocus && this._lastFocus)
            Main.activateWindow(this._lastFocus);
    }

    // Bring one of Tuple's windows forward ("screen", "incoming-call", …).
    focus(role) {
        const win = this._windows().find(w => sameRole(windowRole(w), role));
        if (!win)
            return false;
        Main.activateWindow(win);
        return true;
    }

    // "screen=1920x1080 webcams=194x194" for bin/tuple-perf.
    sizes() {
        return this._windows()
            .filter(w => ['screen', 'webcams'].includes(windowRole(w)))
            .map(w => {
                const r = w.get_frame_rect();
                return `${windowRole(w)}=${r.width}x${r.height}${w.is_fullscreen() ? '(full)' : ''}`;
            })
            .join(' ');
    }
}
