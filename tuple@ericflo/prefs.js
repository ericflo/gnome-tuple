// Preferences for the Tuple indicator. Tuple's own settings (overlay,
// start-calls-muted, capture, …) live in the indicator's menu, since they
// come from the daemon; these are the extension's.
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const SIZES = ['small', 'medium', 'large'];

export default class TuplePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(560, 640);
        const page = new Adw.PreferencesPage({title: 'Tuple', icon_name: 'call-start-symbolic'});
        window.add(page);

        const switchRow = (group, key, title, subtitle = '') => {
            const row = new Adw.SwitchRow({title, subtitle});
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            group.add(row);
        };

        const calls = new Adw.PreferencesGroup({title: 'Calls'});
        switchRow(calls, 'copy-link-on-new-call', 'Copy the call link on New call');
        switchRow(calls, 'notify-incoming', 'Notify on incoming calls');
        switchRow(calls, 'notify-joins', 'Notify when someone joins your call');
        page.add(calls);

        const people = new Adw.PreferencesGroup({title: 'People'});
        const refresh = new Adw.SpinRow({
            title: 'Refresh contacts every',
            subtitle: 'Seconds. Opening the menu and presence changes refresh too.',
            adjustment: new Gtk.Adjustment({lower: 10, upper: 3600, step_increment: 5, page_increment: 60}),
        });
        settings.bind('refresh-interval', refresh, 'value', Gio.SettingsBindFlags.DEFAULT);
        people.add(refresh);
        switchRow(people, 'show-avatars', 'Show profile pictures',
            "From Gravatar, like Tuple's own apps (it's asked by a hash of each email). Cached in ~/.cache/tuple-gnome.");
        page.add(people);

        const devices = new Adw.PreferencesGroup({
            title: 'Camera and microphone',
            description: "Tuple for Linux can't send webcam video or pick an input yet. Your camera shows as a local tile (with mpv) that they see through your screen share, and the chosen mic is applied by moving Tuple's recording stream. Both can also be picked from the menu during a call.",
        });
        const size = new Adw.ComboRow({
            title: 'Camera tile size',
            subtitle: 'Yours and theirs, in the bottom-right corner',
            model: Gtk.StringList.new(['Small', 'Medium', 'Large']),
        });
        size.selected = Math.max(0, SIZES.indexOf(settings.get_string('camera-size')));
        size.connect('notify::selected', () => settings.set_string('camera-size', SIZES[size.selected] ?? 'medium'));
        devices.add(size);
        switchRow(devices, 'camera-follows-call', 'Turn the camera off when the call ends');
        for (const [key, title] of [['camera-device', 'Camera (blank: system default)'], ['mic-device', 'Microphone source (blank: system default)']]) {
            const row = new Adw.EntryRow({title, show_apply_button: true});
            row.text = settings.get_string(key);
            row.connect('apply', () => settings.set_string(key, row.text.trim()));
            devices.add(row);
        }
        page.add(devices);

        const advanced = new Adw.PreferencesGroup({title: 'Advanced'});
        const command = new Adw.EntryRow({title: 'tuple command (a name on PATH or ~/.local/bin, or a full path)', show_apply_button: true});
        command.text = settings.get_string('tuple-command');
        command.connect('apply', () => settings.set_string('tuple-command', command.text.trim() || 'tuple'));
        advanced.add(command);
        switchRow(advanced, 'perf-log', 'Log call performance', '~/.local/state/tuple-gnome/perf.log, every 20s during calls');
        switchRow(advanced, 'archive-logs', 'Keep copies of Tuple daemon logs', '~/.local/state/tuple-gnome/logs, the last 20 runs');
        page.add(advanced);
    }
}
