// Drive service.js against the real Tuple daemon, outside GNOME Shell.
//
//   gjs -m tests/live.js status            # print the state once it settles
//   gjs -m tests/live.js watch [seconds]   # print every change
//   gjs -m tests/live.js on|off            # turn the daemon on or off
//   gjs -m tests/live.js contacts          # load the directory, print counts
//   gjs -m tests/live.js <method> [arg]    # any Service method, e.g. newCall
//
// Settings come from the extension's schema in memory (GSETTINGS_BACKEND is
// forced to "memory"), so nothing here touches your real preferences.
//
// Callbacks rather than promises throughout: GJS doesn't run promise jobs
// inside a main loop started while the module is still evaluating.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {Service} from '../tuple@ericflo/service.js';

GLib.setenv('GSETTINGS_BACKEND', 'memory', true);

const here = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
const dir = GLib.canonicalize_filename(GLib.build_filenamev([here, '..', 'tuple@ericflo']), null);

const source = Gio.SettingsSchemaSource.new_from_directory(`${dir}/schemas`, Gio.SettingsSchemaSource.get_default(), false);
const settings = new Gio.Settings({settings_schema: source.lookup('org.gnome.shell.extensions.tuple', false)});

let clipboard = '';
const host = {
    copy: text => {
        clipboard = text;
        print(`[copy] ${text}`);
    },
    readClipboard: cb => cb(clipboard),
    openUrl: url => print(`[open] ${url}`),
    notify: ({title, body, actions = []}) => {
        print(`[notify] ${title} — ${body}${actions.length ? ` [${actions.map(a => a.label).join(', ')}]` : ''}`);
        return {destroy() {}};
    },
    arrangeWindows: () => {},
    focusWindow: () => false,
    windowSizes: () => '',
};

const [command = 'status', arg = ''] = ARGV;
const loop = new GLib.MainLoop(null, false);
const service = new Service({settings, host, dir});
const status = () => JSON.parse(service.statusJson());
const quit = code => {
    service.destroy();
    loop.quit();
    imports.system.exit(code);
};
const after = (ms, fn) => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    fn();
    return GLib.SOURCE_REMOVE;
});
// Call back once `pred` holds (polled every 100ms), or with false on timeout.
const until = (pred, ms, cb) => {
    const t0 = Date.now();
    const check = () => {
        if (pred())
            cb(true);
        else if (Date.now() - t0 > ms)
            cb(false);
        else
            after(100, check);
    };
    check();
};

let last = '';
service.connectChanged(() => {
    if (command !== 'watch')
        return;
    const s = status();
    const line = `${s.text} | daemon=${s.daemon} loggedIn=${s.loggedIn} call=${s.call} peers=${s.peers.join(',')} muted=${s.muted} sharing=${s.sharing} contacts=${s.contacts} pending=${s.pending.join(',')} ${service.lastError || service.actionStatus}`;
    if (line !== last)
        print(`${new Date().toISOString().slice(11, 23)} ${line}`);
    last = line;
});

const main = () => {
    if (command === 'status') {
        print(JSON.stringify(status(), null, 2));
        quit(0);
    } else if (command === 'watch') {
        after(Number(arg || 60) * 1000, () => quit(0));
    } else if (command === 'on' || command === 'off') {
        if (command === 'on')
            service.turnOn();
        else
            service.turnOff();
        until(() => service.daemon === (command === 'on') && !service.busy &&
            (command === 'off' || service.summary), 20000, ok => {
            print(`${ok ? 'ok' : 'timed out'}: ${service.statusText} (${service.lastError || service.actionStatus})`);
            quit(ok ? 0 : 1);
        });
    } else if (command === 'contacts') {
        service.refreshContacts();
        const t0 = Date.now();
        after(200, () => until(() => service.contactsLoaded && !service.isPending('contacts'), 45000, () => {
            const s = service.contacts;
            print(`${s.length} contacts in ${Date.now() - t0}ms; ${s.filter(c => c.online).length} online, ${s.filter(c => c.favorite).length} favorites, ${s.filter(c => c.recent).length} recent`);
            print(`statuses: ${[...new Set(s.map(c => c.status))].join(', ')}; kinds: ${[...new Set(s.map(c => c.kind))].join(', ')}`);
            print(`featured: ${service.shownContacts('').slice(0, 10).map(c => `${c.name}${c.favorite ? ' ★' : ''} [${c.status}]`).join('; ')}`);
            quit(0);
        }));
    } else {
        if (typeof service[command] !== 'function') {
            print(`no such method: ${command}`);
            quit(2);
        }
        service[command](arg);
        after(200, () => until(() => !service.busy, 60000, () => after(1500, () => {
            print(JSON.stringify(status(), null, 2));
            quit(0);
        })));
    }
};
until(() => service.daemonKnown && (!service.daemon || service.summary), 8000, main);
loop.run();
