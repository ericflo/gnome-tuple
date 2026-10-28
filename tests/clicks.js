// Clicks the indicator's switches with a virtual pointer (via the test-only
// clicker@tuple-test extension) and checks that each click reached the
// service. Run by tests/headless.sh --clicks inside its private session.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const bus = Gio.DBus.session;
const wait = ms => {
    const end = Date.now() + ms;
    const ctx = GLib.MainContext.default();
    while (Date.now() < end) {
        ctx.iteration(false);
        GLib.usleep(10000);
    }
};
const call = (path, iface, args) => bus.call_sync('org.gnome.Shell', path, iface, 'Call',
    new GLib.Variant('(ss)', args), null, Gio.DBusCallFlags.NONE, 5000, null).deepUnpack()[0];
const tuple = (name, arg = '') => call('/org/gnome/Shell/Extensions/Tuple', 'org.gnome.Shell.Extensions.Tuple', [name, arg]);
const click = (target, where = 'center') => bus.call_sync('org.gnome.Shell', '/org/gnome/Shell/Extensions/TupleTest',
    'org.gnome.Shell.Extensions.TupleTest', 'Click', new GLib.Variant('(ss)', [target, where]),
    null, Gio.DBusCallFlags.NONE, 5000, null).deepUnpack()[0];

const cases = [
    // [demo state, widget, where, expected message]
    ['stopped', '_powerButton', 'center', 'demo: tuple start'],
    ['stopped', '_power._handle', 'center', 'demo: tuple start'],
    ['stopped', '_powerButton', 'right', 'demo: tuple start'],
    ['idle', '_powerButton', 'center', 'demo: tuple stop'],
    ['idle', '_power._handle', 'center', 'demo: tuple stop'],
    ['viewing', '_controlButton', 'center', 'You can control their screen'],
    ['viewing', '_control._handle', 'center', 'You can control their screen'],
    ['stopped', '_powerButton', 'center', 'demo: tuple start'],
    ['stopped', '_power._handle', 'left', 'demo: tuple start'],
];

wait(1500);
// The first virtual-pointer press after the shell starts doesn't land
// anywhere useful; spend it on an inert label.
tuple('demo', 'idle');
tuple('open');
wait(700);
click('_statusLabel');
wait(700);
tuple('close');
wait(500);

let failures = 0;
for (const [state, target, where, expected] of cases) {
    tuple('demo', state);
    tuple('open');
    wait(700);
    const at = click(target, where);
    wait(900);
    const status = JSON.parse(tuple('status'));
    const ok = status.message.startsWith(expected);
    if (!ok)
        failures++;
    print(`${ok ? 'PASS' : 'FAIL'} ${state}: click ${target} (${where}) at ${at} → “${status.message}”${ok ? '' : ` (wanted “${expected}”)`}`);
    tuple('close');
    wait(500);
}
tuple('demo', 'off');
print(failures === 0 ? 'all clicks reached the service' : `${failures} click(s) went nowhere`);
imports.system.exit(failures === 0 ? 0 : 1);
