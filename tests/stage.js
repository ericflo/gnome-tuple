// The camera flow and the call stage, with real input, in the throwaway
// shell of tests/headless.sh --stage (and the clicker@tuple-test helper).
// Checks what went wrong on a real call:
//
//   * Camera while not sharing offers "Share screen with camera" (Tuple for
//     Linux can't send webcam video) instead of a tile only you can see;
//   * the tile comes up with the share, can be dragged and resized with the
//     mouse, and stays where you put it when other windows come and go;
//   * their webcam still lands in the corner;
//   * a fullscreen Tuple overlay (what blacked out the screen) is hidden;
//   * the stop-sharing shortcut ends the share and the tile from anywhere;
//   * the menu shortcut opens the menu.
//
// Fake "their webcam" and "overlay" windows are mpv test patterns with
// Tuple's app ids. Screenshots go to the out dir.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const [outDir = '/tmp/tuple-stage'] = ARGV;
GLib.mkdir_with_parents(outDir, 0o755);
const bus = Gio.DBus.session;
Gio.bus_own_name_on_connection(bus, 'org.gnome.SettingsDaemon.MediaKeys', Gio.BusNameOwnerFlags.NONE, null, null);

const wait = ms => {
    const end = Date.now() + ms;
    const ctx = GLib.MainContext.default();
    while (Date.now() < end) {
        ctx.iteration(false);
        GLib.usleep(10000);
    }
};
const callOn = (path, iface, method, args, sig = '(ss)') => bus.call_sync('org.gnome.Shell', path, iface, method,
    new GLib.Variant(sig, args), null, Gio.DBusCallFlags.NONE, 10000, null).deepUnpack()[0];
const tuple = (name, arg = '') => callOn('/org/gnome/Shell/Extensions/Tuple', 'org.gnome.Shell.Extensions.Tuple', 'Call', [name, arg]);
const input = (method, ...args) => callOn('/org/gnome/Shell/Extensions/TupleTest', 'org.gnome.Shell.Extensions.TupleTest',
    method, args, `(${'s'.repeat(args.length)})`);
const status = () => JSON.parse(tuple('status'));
const windows = () => JSON.parse(tuple('windows'));
const win = role => windows().find(w => w.role === role);
const shot = name => bus.call_sync('org.gnome.Shell.Screenshot', '/org/gnome/Shell/Screenshot', 'org.gnome.Shell.Screenshot',
    'Screenshot', new GLib.Variant('(bbs)', [false, false, `${outDir}/${name}.png`]), null, Gio.DBusCallFlags.NONE, 10000, null);

// mpv windows that look like Tuple's, on this shell's Wayland display.
const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE});
launcher.setenv('WAYLAND_DISPLAY', 'tuple-test-0', true);
launcher.unsetenv('DISPLAY');
const fake = (appId, source, ...extra) => launcher.spawnv(['mpv', `av://lavfi:${source}`, `--wayland-app-id=${appId}`,
    `--title=${appId}`, '--no-audio', '--really-quiet', '--no-input-default-bindings', ...extra]);
const spawned = [];

let failures = 0;
const check = (ok, what, detail = '') => {
    if (!ok)
        failures++;
    print(`${ok ? 'PASS' : 'FAIL'} ${what}${detail ? ` — ${detail}` : ''}`);
};
const rect = w => w ? `${w.rect[2]}x${w.rect[3]} at ${w.rect[0]},${w.rect[1]}` : 'missing';
const near = (a, b, slack = 12) => Math.abs(a - b) <= slack;

try {
    // Out of the start-up overview, and spend the first pointer press.
    wait(1500);
    input('Key', 'Escape');
    wait(800);
    tuple('demo', 'viewing');
    tuple('open');
    wait(700);
    input('Click', '_statusLabel', 'center');
    wait(500);
    tuple('open');      // the warm-up press may have landed outside and closed it
    wait(700);

    // 1. Camera while not sharing: an offer, no tile.
    const offered = tuple('toggleCamera');
    wait(700);
    check(offered === 'offered' && status().cameraOffer && !win('selfcam'),
        'Camera while not sharing offers to share the screen with it', `reply ${offered}`);
    shot('1-offer');

    // 2. The offer's button: share, then the tile.
    const at = input('Click', '_offerShare', 'center');
    wait(3500);
    let s = status();
    let me = win('selfcam');
    check(s.sharing && s.camera && me, '"Share screen with camera" shares, and the tile comes up',
        `clicked ${at}; sharing=${s.sharing} camera=${s.camera} tile ${rect(me)} message “${s.message}”`);
    if (!me) {
        // Was it the click or the flow? Ask for it directly.
        tuple('shareWithCamera');
        wait(3500);
        s = status();
        me = win('selfcam');
        print(`  (directly: sharing=${s.sharing} camera=${s.camera} tile ${rect(me)} message “${s.message}”)`);
    }
    if (!me)
        throw new Error('no camera tile; the rest needs one');
    tuple('close');
    wait(1200);
    me = win('selfcam');
    const [x, y, w, h] = me.rect;
    check(near(x + w, 1280 - 40) && near(y + h, 1100 - 40) && me.above && me.sticky,
        'the tile starts in the bottom-right corner, on top, on every workspace', rect(me));
    shot('2-tile');

    // 3. Drag it.
    const cx = x + w / 2, cy = y + h / 2;
    input('Drag', `${cx},${cy},${cx - 500},${cy - 300}`);
    wait(1500);
    const dragged = win('selfcam');
    check(near(dragged.rect[0], x - 500, 30) && near(dragged.rect[1], y - 300, 30),
        'dragging the tile moves it', `${rect(me)} → ${rect(dragged)}`);

    // 4. Their webcam arrives: it takes the corner; yours stays put.
    spawned.push(fake('tuple-webcams', 'testsrc2=size=320x320:rate=10', '--keepaspect-window=yes'));
    wait(2500);
    const theirs = win('webcams');
    const stayed = win('selfcam');
    check(theirs && near(theirs.rect[0] + theirs.rect[2], 1280 - 40) && near(theirs.rect[1] + theirs.rect[3], 1100 - 40),
        'their webcam lands in the corner', rect(theirs));
    check(near(stayed.rect[0], dragged.rect[0], 4) && near(stayed.rect[1], dragged.rect[1], 4),
        'your tile stays where you dragged it when another window arrives', `${rect(dragged)} → ${rect(stayed)}`);
    shot('3-moved');

    // 5. Scroll on it: bigger, and it stays that size.
    const sx = stayed.rect[0] + stayed.rect[2] / 2, sy = stayed.rect[1] + stayed.rect[3] / 2;
    input('Scroll', `${sx},${sy},up,3`);
    wait(2000);
    const bigger = win('selfcam');
    check(bigger.rect[2] > stayed.rect[2] + 20, 'scrolling up on the tile makes it bigger', `${rect(stayed)} → ${rect(bigger)}`);
    spawned.push(fake('tuple-webcams', 'testsrc2=size=320x320:rate=10', '--keepaspect-window=yes'));
    wait(2500);
    const kept = win('selfcam');
    check(near(kept.rect[2], bigger.rect[2], 4) && near(kept.rect[0], bigger.rect[0], 4),
        'and keeps its size and place when the stage changes again', `${rect(bigger)} → ${rect(kept)}`);

    // 6. Tuple's fullscreen overlay: hidden.
    spawned.push(fake('tuple-overlay', 'color=c=black:size=640x360:rate=5', '--fullscreen'));
    wait(2500);
    const overlay = win('overlay');
    check(overlay && overlay.minimized, "a fullscreen Tuple overlay is hidden at once", overlay ? `minimized=${overlay.minimized}` : 'never appeared');
    shot('4-overlay');

    // 7. The stop-sharing shortcut.
    input('Key', '<Super><Control>Escape');
    wait(2500);
    s = status();
    check(!s.sharing && !s.camera && !win('selfcam'), 'Super+Ctrl+Esc stops sharing and closes the tile',
        `sharing=${s.sharing} camera=${s.camera} message “${s.message}”`);

    // 8. The menu shortcut.
    input('Key', '<Super><Control>t');
    wait(1000);
    check(status().menuOpen, 'Super+Ctrl+T opens the Tuple menu');
    input('Key', '<Super><Control>t');
    wait(600);
    check(!status().menuOpen, '…and closes it');
} catch (e) {
    failures++;
    print(`FAIL ${e.message}`);
} finally {
    for (const p of spawned)
        p.force_exit();
    try {
        tuple('demo', 'off');
    } catch {}
}
print(failures === 0 ? 'stage: all checks passed' : `stage: ${failures} check(s) failed`);
imports.system.exit(failures === 0 ? 0 : 1);
