// Drives the extension's demo states over D-Bus and screenshots each one.
// Run by tests/headless.sh inside its private session; not useful alone.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const [outDir] = ARGV;
const bus = Gio.DBus.session;

// The shell only takes screenshots for a few well-known names. This private
// bus has no gnome-settings-daemon, so borrow its name.
Gio.bus_own_name_on_connection(bus, 'org.gnome.SettingsDaemon.MediaKeys', Gio.BusNameOwnerFlags.NONE, null, null);

const wait = ms => {
    const end = Date.now() + ms;
    const ctx = GLib.MainContext.default();
    while (Date.now() < end) {
        ctx.iteration(false);
        GLib.usleep(10000);
    }
};

const tuple = (name, arg = '') => bus.call_sync('org.gnome.Shell', '/org/gnome/Shell/Extensions/Tuple',
    'org.gnome.Shell.Extensions.Tuple', 'Call', new GLib.Variant('(ss)', [name, arg]),
    null, Gio.DBusCallFlags.NONE, 5000, null).deepUnpack()[0];

const shot = file => bus.call_sync('org.gnome.Shell.Screenshot', '/org/gnome/Shell/Screenshot',
    'org.gnome.Shell.Screenshot', 'Screenshot', new GLib.Variant('(bbs)', [false, false, file]),
    null, Gio.DBusCallFlags.NONE, 10000, null);

wait(1500);
let failed = false;
for (const state of ['idle', 'call', 'viewing', 'incoming', 'login', 'stopped']) {
    try {
        print(`${state}: demo → ${tuple('demo', state)}`);
        tuple('open');
        wait(900);
        shot(`${outDir}/${state}.png`);
        print(`  ${JSON.parse(tuple('status')).text}`);
        tuple('close');
        wait(400);
    } catch (e) {
        failed = true;
        print(`  ${state} failed: ${e.message}`);
    }
}
// The camera picker, opened the way a keyboard shortcut would.
try {
    tuple('demo', 'call');
    print(`devices: ${tuple('deviceMenu', 'camera')}`);
    wait(1500);
    shot(`${outDir}/devices.png`);
    tuple('close');
    wait(400);
} catch (e) {
    failed = true;
    print(`  devices failed: ${e.message}`);
}
tuple('demo', 'off');
print(`live: ${tuple('status')}`);
imports.system.exit(failed ? 1 : 0);
