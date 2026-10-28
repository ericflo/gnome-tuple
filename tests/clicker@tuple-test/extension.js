// Test-only helper for tests/clicks.js, loaded only by tests/headless.sh in
// its throwaway shell: clicks a widget of the Tuple indicator with a virtual
// pointer, the way a mouse would, so gestures and grabs behave for real.
//
//   Click("_powerButton", "center")   → presses and releases over it
//   Click("_power._handle", "center") → a path of properties from the indicator
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const IFACE = `
<node>
  <interface name="org.gnome.Shell.Extensions.TupleTest">
    <method name="Click">
      <arg type="s" direction="in" name="target"/>
      <arg type="s" direction="in" name="where"/>
      <arg type="s" direction="out" name="result"/>
    </method>
  </interface>
</node>`;

export default class ClickerExtension extends Extension {
    enable() {
        this._dbus = Gio.DBusExportedObject.wrapJSObject(IFACE, this);
        this._dbus.export(Gio.DBus.session, '/org/gnome/Shell/Extensions/TupleTest');
    }

    disable() {
        this._dbus?.unexport();
        this._dbus = null;
        this._device = null;
    }

    Click(target, where) {
        const indicator = Main.panel.statusArea['tuple@ericflo'];
        const actor = target.split('.').reduce((a, key) => a?.[key], indicator);
        if (!actor?.get_transformed_position)
            return `no actor at ${target}`;
        const [x, y] = actor.get_transformed_position();
        const [w, h] = actor.get_transformed_size();
        const fx = {left: 0.15, right: 0.85}[where] ?? 0.5;
        const px = x + w * fx;
        const py = y + h / 2;
        this._device ??= global.stage.context.get_backend().get_default_seat()
            .create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
        const device = this._device;
        device.notify_absolute_motion(GLib.get_monotonic_time(), px, py);
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 60, () => {
            device.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => {
                device.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
                return GLib.SOURCE_REMOVE;
            });
            return GLib.SOURCE_REMOVE;
        });
        return `${Math.round(px)},${Math.round(py)}`;
    }
}
