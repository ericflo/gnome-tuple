// Test-only helper for tests/clicks.js and tests/stage.js, loaded only by
// tests/headless.sh in its throwaway shell: real input through virtual
// devices, so gestures, grabs, keybindings and client-side window dragging
// behave as they do for a person.
//
//   Click("_powerButton", "center")        click a widget of the Tuple indicator
//   Click("_power._handle", "center")      …by a path of properties from it
//   Drag("x1,y1,x2,y2")                    press, move in steps, release
//   Scroll("x,y,up|down,count")            mouse-wheel notches
//   Key("<Super><Control>Escape")          press and release an accelerator
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
    <method name="Drag">
      <arg type="s" direction="in" name="coords"/>
      <arg type="s" direction="out" name="result"/>
    </method>
    <method name="Scroll">
      <arg type="s" direction="in" name="spec"/>
      <arg type="s" direction="out" name="result"/>
    </method>
    <method name="Key">
      <arg type="s" direction="in" name="accel"/>
      <arg type="s" direction="out" name="result"/>
    </method>
  </interface>
</node>`;

const MODIFIERS = {
    Super: Clutter.KEY_Super_L,
    Control: Clutter.KEY_Control_L,
    Primary: Clutter.KEY_Control_L,
    Alt: Clutter.KEY_Alt_L,
    Shift: Clutter.KEY_Shift_L,
};

export default class ClickerExtension extends Extension {
    enable() {
        this._dbus = Gio.DBusExportedObject.wrapJSObject(IFACE, this);
        this._dbus.export(Gio.DBus.session, '/org/gnome/Shell/Extensions/TupleTest');
    }

    disable() {
        this._dbus?.unexport();
        this._dbus = null;
        this._pointer = this._keyboard = null;
    }

    _device(type) {
        return global.stage.context.get_backend().get_default_seat().create_virtual_device(type);
    }

    get pointer() {
        this._pointer ??= this._device(Clutter.InputDeviceType.POINTER_DEVICE);
        return this._pointer;
    }

    get keyboard() {
        this._keyboard ??= this._device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        return this._keyboard;
    }

    // Steps run one after another, `ms` apart, so each lands as its own event.
    _sequence(steps, ms = 40) {
        let i = 0;
        const next = () => {
            if (i >= steps.length)
                return GLib.SOURCE_REMOVE;
            steps[i++]();
            return GLib.SOURCE_CONTINUE;
        };
        next();
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, next);
    }

    _now() {
        return GLib.get_monotonic_time();
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
        const p = this.pointer;
        this._sequence([
            () => p.notify_absolute_motion(this._now(), px, py),
            () => {},
            () => p.notify_button(this._now(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED),
            () => {},
            () => p.notify_button(this._now(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED),
        ]);
        return `${Math.round(px)},${Math.round(py)}`;
    }

    Drag(coords) {
        const [x1, y1, x2, y2] = coords.split(',').map(Number);
        const p = this.pointer;
        const steps = [
            () => p.notify_absolute_motion(this._now(), x1, y1),
            () => {},
            () => p.notify_button(this._now(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED),
            () => {},
        ];
        const n = 12;
        for (let i = 1; i <= n; i++)
            steps.push(() => p.notify_absolute_motion(this._now(), x1 + (x2 - x1) * i / n, y1 + (y2 - y1) * i / n));
        steps.push(() => {}, () => p.notify_button(this._now(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED));
        this._sequence(steps);
        return 'ok';
    }

    Scroll(spec) {
        const [x, y, dir = 'up', count = '1'] = spec.split(',');
        const p = this.pointer;
        const direction = dir === 'down' ? Clutter.ScrollDirection.DOWN : Clutter.ScrollDirection.UP;
        const steps = [() => p.notify_absolute_motion(this._now(), Number(x), Number(y)), () => {}];
        for (let i = 0; i < Number(count); i++)
            steps.push(() => p.notify_discrete_scroll(this._now(), direction, Clutter.ScrollSource.WHEEL), () => {});
        this._sequence(steps, 80);
        return 'ok';
    }

    Key(accel) {
        const mods = [...accel.matchAll(/<([A-Za-z]+)>/g)].map(m => MODIFIERS[m[1]]).filter(k => k);
        const name = accel.replace(/<[^>]+>/g, '');
        const key = Clutter[`KEY_${name}`];
        if (key === undefined)
            return `unknown key ${name}`;
        const k = this.keyboard;
        const steps = [];
        for (const m of mods)
            steps.push(() => k.notify_keyval(this._now(), m, Clutter.KeyState.PRESSED));
        steps.push(() => k.notify_keyval(this._now(), key, Clutter.KeyState.PRESSED));
        steps.push(() => k.notify_keyval(this._now(), key, Clutter.KeyState.RELEASED));
        for (const m of mods.reverse())
            steps.push(() => k.notify_keyval(this._now(), m, Clutter.KeyState.RELEASED));
        this._sequence(steps);
        return 'ok';
    }
}
