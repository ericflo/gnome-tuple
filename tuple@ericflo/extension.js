// Tuple in the top bar, ported from benjaminsehl/omarchy-tuple (MIT) to GNOME
// Shell. The mark shows where you are — off, logged out, in a call, muted,
// sharing, ringing — and its menu starts and joins calls, runs the call, and
// finds people. service.js does the work; this file is the shell side: the
// indicator and menu, notifications, the clipboard, window placement
// (windows.js), and a D-Bus interface for bin/tuple-shell.
//
// Design notes, kept from the original — "as little design as possible":
//   * The status line under the title says where you are; sections don't
//     restate it.
//   * One control per intent: a single field and button starts or joins.
//   * Presence is shown once (the dot); words only when they add something.
//   * Secondary actions (favorite, call) appear on the row you point at.
import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {ensureActorVisibleInScrollView} from 'resource:///org/gnome/shell/misc/animationUtils.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {Avatars} from './avatars.js';
import * as Model from './model.js';
import {Service} from './service.js';
import {WindowStage} from './windows.js';

const DBUS_PATH = '/org/gnome/Shell/Extensions/Tuple';
const DBUS_IFACE = `
<node>
  <interface name="org.gnome.Shell.Extensions.Tuple">
    <method name="Call">
      <arg type="s" direction="in" name="name"/>
      <arg type="s" direction="in" name="argument"/>
      <arg type="s" direction="out" name="result"/>
    </method>
  </interface>
</node>`;

const DIM = 150;

// ── Small builders ───────────────────────────────────────────────────────

function label(text = '', {style = null, dim = false, wrap = false, expand = false} = {}) {
    const l = new St.Label({
        text,
        style_class: style,
        x_expand: expand,
        y_align: Clutter.ActorAlign.CENTER,
    });
    if (wrap) {
        l.clutter_text.line_wrap = true;
        l.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        l.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    } else {
        l.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    }
    if (dim)
        l.opacity = DIM;
    return l;
}

function vbox(params = {}) {
    return new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, ...params});
}

function hbox(params = {}) {
    return new St.BoxLayout({orientation: Clutter.Orientation.HORIZONTAL, ...params});
}

function button({text = '', icon = '', style = 'button', expand = false, onClick = null, accessible = ''}) {
    const b = new St.Button({
        style_class: style,
        can_focus: true,
        x_expand: expand,
        accessible_name: accessible || text,
    });
    if (icon && text) {
        const box = hbox({style_class: 'tuple-button-box', x_align: Clutter.ActorAlign.CENTER});
        box.add_child(new St.Icon({icon_name: icon, style_class: 'popup-menu-icon'}));
        b._label = label(text);
        box.add_child(b._label);
        b.set_child(box);
    } else if (icon) {
        b.set_child(new St.Icon({icon_name: icon, style_class: 'popup-menu-icon'}));
    } else {
        b._label = label(text);
        b._label.x_align = Clutter.ActorAlign.CENTER;
        b.set_child(b._label);
    }
    if (onClick)
        b.connect('clicked', () => onClick());
    return b;
}

function iconButton(iconName, accessible, onClick) {
    return button({icon: iconName, style: 'icon-button tuple-icon-button', accessible, onClick});
}

// A row that sits flat in the menu and lights up like a menu item.
function rowButton(child, onClick) {
    const b = new St.Button({
        style_class: 'popup-menu-item tuple-row',
        can_focus: true,
        x_expand: true,
        track_hover: true,
        child,
    });
    child.x_expand = true;
    if (onClick)
        b.connect('clicked', () => onClick());
    return b;
}

// GNOME's switch flips itself when you press or drag its knob, and that
// press never reaches a button around it; the button still gets clicks
// beside the knob, and the keyboard. So the switch's state is the one thing
// to act on: a click on the button just toggles the switch, and apply(on)
// runs whenever the switch shows something other than shown() — which also
// makes the updates _sync() makes to it no-ops.
function switchButton(accessible, shown, apply) {
    const sw = new PopupMenu.Switch(false);
    const b = new St.Button({
        style_class: 'tuple-switch-button',
        child: sw,
        can_focus: true,
        y_align: Clutter.ActorAlign.CENTER,
        accessible_name: accessible,
    });
    b.connect('clicked', () => sw.toggle());
    sw.connect('notify::state', () => {
        if (sw.state !== shown())
            apply(sw.state);
    });
    b._switch = sw;
    return b;
}

// A plain container in the menu: not activatable, so clicking inside it
// doesn't close the menu.
function menuItem(child, style = null) {
    const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false, style_class: style});
    item.add_child(child);
    child.x_expand = true;
    return item;
}

function setPulse(actor, on, rest = 255) {
    actor.remove_transition('opacity');
    if (on) {
        actor.opacity = rest;
        actor.ease({
            opacity: Math.round(rest * 0.4),
            duration: 520,
            mode: Clutter.AnimationMode.EASE_IN_OUT_QUAD,
            autoReverse: true,
            repeatCount: -1,
        });
    } else {
        actor.opacity = rest;
    }
}

// ── Tuple's mark ─────────────────────────────────────────────────────────

// Two offset rounded squares, drawn in the theme's colour instead of
// shipping the purple PNG. A slash when Tuple is off; a dot for a warning
// (logged out) or while you share your screen.
const TupleMark = GObject.registerClass(
class TupleMark extends St.DrawingArea {
    _init(style) {
        super._init({style_class: `tuple-mark ${style}`, y_align: Clutter.ActorAlign.CENTER});
        this._crossed = false;
        this._badge = '';
    }

    setState({crossed = false, badge = ''}) {
        if (crossed === this._crossed && badge === this._badge)
            return;
        this._crossed = crossed;
        this._badge = badge;
        this.queue_repaint();
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [w, h] = this.get_surface_size();
        const node = this.get_theme_node();
        const fg = node.get_foreground_color();
        const [found, color] = node.lookup_color('-tuple-urgent-color', false);
        const urgent = found ? color : fg;
        const rgba = (c, a = 1) => cr.setSourceRGBA(c.red / 255, c.green / 255, c.blue / 255, c.alpha / 255 * a);

        const size = Math.min(w, h);
        const ox = (w - size) / 2;
        const oy = (h - size) / 2;
        const tile = size * 0.70;
        const offset = size - tile;
        const radius = tile * 0.16;
        const square = (x, y) => {
            cr.newSubPath();
            cr.arc(x + tile - radius, y + radius, radius, -Math.PI / 2, 0);
            cr.arc(x + tile - radius, y + tile - radius, radius, 0, Math.PI / 2);
            cr.arc(x + radius, y + tile - radius, radius, Math.PI / 2, Math.PI);
            cr.arc(x + radius, y + radius, radius, Math.PI, 1.5 * Math.PI);
            cr.closePath();
        };
        const fade = this._crossed ? 0.55 : 1;

        // Back tile (lower right) lighter; front tile (upper left) solid.
        square(ox + offset, oy + offset);
        rgba(fg, 0.45 * fade);
        cr.fill();
        square(ox, oy);
        rgba(fg, fade);
        cr.fill();

        if (this._crossed) {
            cr.setLineWidth(Math.max(1.5, size * 0.12));
            cr.setLineCap(Cairo.LineCap.ROUND);
            cr.moveTo(ox + size * 0.95, oy + size * 0.05);
            cr.lineTo(ox + size * 0.05, oy + size * 0.95);
            rgba(fg);
            cr.stroke();
        }

        if (this._badge !== '') {
            const d = Math.max(4, size * 0.42);
            const cx = ox + size - d * 0.15;
            const cy = oy + size - d * 0.15;
            cr.arc(cx, cy, d / 2, 0, 2 * Math.PI);
            rgba(this._badge === 'sharing' ? fg : urgent);
            cr.fill();
        }
        cr.$dispose();
    }
});

// ── The indicator ────────────────────────────────────────────────────────

const TupleIndicator = GObject.registerClass(
class TupleIndicator extends PanelMenu.Button {
    _init(ext) {
        super._init(0.5, 'Tuple');
        this._ext = ext;
        this._service = ext.service;
        this._query = '';
        this._deviceKind = '';
        this._keys = {};

        this.add_style_class_name('tuple-indicator');
        this._mark = new TupleMark('tuple-bar-mark');
        this.add_child(this._mark);

        // Left click opens the menu. Right click: in a call, mute; ringing,
        // answer. Middle click: in a call, share; otherwise refresh.
        this._clickGesture?.set_required_button(Clutter.BUTTON_PRIMARY);
        for (const which of [Clutter.BUTTON_SECONDARY, Clutter.BUTTON_MIDDLE]) {
            const gesture = new Clutter.ClickGesture();
            gesture.set_required_button(which);
            gesture.set_recognize_on_press(true);
            gesture.connect('recognize', () => this._onAltClick(which));
            this.add_action(gesture);
        }

        this.menu.actor.add_style_class_name('tuple-menu');
        this.menu.box.add_style_class_name('tuple-menu-box');
        this._build();

        this._keyController = new Clutter.KeyController();
        this._keyController.connect('key-press', () => this._onKey());
        this.menu.actor.add_action(this._keyController);

        this.menu.connect('open-state-changed', (_m, open) => this._onOpen(open));
        this._service.connectChanged(() => this._sync());
        this.connect('destroy', () => {
            if (this._searchTimer)
                GLib.source_remove(this._searchTimer);
            this._searchTimer = 0;
        });
        this._sync();
    }

    // Ask Tuple once typing pauses; the list filters what's at hand meanwhile.
    _searchSoon() {
        if (this._searchTimer)
            GLib.source_remove(this._searchTimer);
        this._searchTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
            this._searchTimer = 0;
            this._service.searchContacts(this._query);
            return GLib.SOURCE_REMOVE;
        });
    }

    _onAltClick(which) {
        const s = this._service;
        if (which === Clutter.BUTTON_SECONDARY) {
            if (s.inCall)
                s.toggleMute();
            else if (s.incoming)
                s.answer();
            else
                this.menu.toggle();
        } else if (s.inCall) {
            s.toggleShare();
        } else {
            s.refresh(true);
        }
    }

    _onOpen(open) {
        if (open) {
            this._service.refresh();
            this._peopleScroll.vadjustment.value = 0;
            this._sync();
        } else {
            this._pairEntry.text = '';
            this._searchEntry.text = '';
            this._authEntry.text = '';
            this._prefilled = '';
            this._showDevices('');
        }
    }

    // ── Layout ────────────────────────────────────────────────────────────
    _build() {
        const s = this._service;
        const menu = this.menu;

        // Hero: the mark, where you are, and the on/off switch.
        const hero = hbox({style_class: 'tuple-hero'});
        this._heroMark = new TupleMark('tuple-hero-mark');
        hero.add_child(this._heroMark);
        const titles = vbox({x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        titles.add_child(label('Tuple', {style: 'tuple-title'}));
        this._statusLabel = label('', {style: 'tuple-status', dim: true});
        titles.add_child(this._statusLabel);
        hero.add_child(titles);
        this._powerButton = switchButton('Tuple on or off', () => s.daemonTarget, on => {
            if (on)
                s.turnOn();
            else
                s.turnOff();
        });
        this._power = this._powerButton._switch;
        hero.add_child(this._powerButton);
        menu.addMenuItem(menuItem(hero, 'tuple-hero-item'));

        this._message = label('', {style: 'tuple-message', wrap: true});
        this._messageItem = menuItem(this._message);
        menu.addMenuItem(this._messageItem);

        this._notInstalled = menuItem(label(
            "The tuple CLI isn't on your PATH or in ~/.local/bin. Install it from tuple.app/linux.",
            {dim: true, wrap: true}));
        menu.addMenuItem(this._notInstalled);

        this._buildLogin();
        this._buildIncoming();
        this._buildCall();
        this._buildPair();
        this._buildPeople();

        // Tuple's own settings (`tuple settings`), cycled in place.
        this._settingsMenu = new PopupMenu.PopupSubMenuMenuItem('Tuple settings', true);
        this._settingsMenu.icon.icon_name = 'emblem-system-symbolic';
        menu.addMenuItem(this._settingsMenu);

        // Footer: quiet, secondary. You, with Log out; then the rest.
        this._footerSep = new PopupMenu.PopupSeparatorMenuItem();
        menu.addMenuItem(this._footerSep);
        const footerBox = vbox({style_class: 'tuple-section'});
        this._meRow = hbox({style_class: 'tuple-person tuple-me'});
        this._meAvatar = new St.Bin({y_align: Clutter.ActorAlign.CENTER});
        this._meRow.add_child(this._meAvatar);
        this._meName = label('', {expand: true});
        this._meRow.add_child(this._meName);
        this._logoutButton = button({text: 'Log out', style: 'button tuple-flat', onClick: () => s.logout()});
        this._meRow.add_child(this._logoutButton);
        footerBox.add_child(this._meRow);
        const footer = hbox({style_class: 'tuple-footer'});
        this._uiButton = button({text: 'Tuple window', style: 'button tuple-flat', onClick: () => {
            this.menu.close();
            s.openDebugUi();
        }});
        footer.add_child(this._uiButton);
        footer.add_child(new St.Widget({x_expand: true}));
        footer.add_child(button({text: 'Preferences', style: 'button tuple-flat', onClick: () => {
            this.menu.close();
            this._ext.openPreferences();
        }}));
        footerBox.add_child(footer);
        menu.addMenuItem(menuItem(footerBox));
    }

    _buildLogin() {
        const s = this._service;
        const box = vbox({style_class: 'tuple-section'});

        const login = hbox({style_class: 'tuple-row-box'});
        login.add_child(new St.Icon({icon_name: 'avatar-default-symbolic', style_class: 'popup-menu-icon'}));
        const loginText = vbox({x_expand: true});
        this._loginTitle = label('Log in');
        loginText.add_child(this._loginTitle);
        loginText.add_child(label('Continues in your browser', {style: 'tuple-caption', dim: true}));
        login.add_child(loginText);
        this._loginRow = rowButton(login, () => s.login());
        box.add_child(this._loginRow);

        this._loginUrlRow = hbox({style_class: 'tuple-row-box'});
        const urlBox = hbox({style_class: 'tuple-row-box'});
        urlBox.add_child(new St.Icon({icon_name: 'web-browser-symbolic', style_class: 'popup-menu-icon'}));
        const urlText = vbox({x_expand: true});
        urlText.add_child(label('Open the login page again'));
        this._loginUrlLabel = label('', {style: 'tuple-caption', dim: true});
        urlText.add_child(this._loginUrlLabel);
        urlBox.add_child(urlText);
        this._loginUrlRow.add_child(rowButton(urlBox, () => s.openUrl(s.loginUrl)));
        this._loginUrlRow.add_child(iconButton('edit-copy-symbolic', 'Copy the login link', () => s.copy(s.loginUrl, 'Login link')));
        box.add_child(this._loginUrlRow);

        this._authRow = hbox({style_class: 'tuple-field-row'});
        this._authEntry = new St.Entry({hint_text: 'Authorization code', can_focus: true, x_expand: true, style_class: 'tuple-entry'});
        this._authEntry.clutter_text.connect('activate', () => this._submitAuth());
        this._authEntry.clutter_text.connect('text-changed', () => this._sync());
        this._authRow.add_child(this._authEntry);
        this._authButton = button({text: 'Log in', onClick: () => this._submitAuth()});
        this._authRow.add_child(this._authButton);
        box.add_child(this._authRow);

        this._loginSep = new PopupMenu.PopupSeparatorMenuItem();
        this.menu.addMenuItem(this._loginSep);
        this._loginItem = menuItem(box);
        this.menu.addMenuItem(this._loginItem);
    }

    _submitAuth() {
        this._service.submitAuth(this._authEntry.text);
        this._authEntry.text = '';
    }

    _buildIncoming() {
        const s = this._service;
        const box = vbox({style_class: 'tuple-section'});
        this._callerBox = vbox();
        box.add_child(this._callerBox);
        const row = hbox({style_class: 'tuple-tiles'});
        row.add_child(button({text: 'Answer', icon: 'call-start-symbolic', style: 'button default tuple-big', expand: true, onClick: () => s.answer()}));
        row.add_child(button({text: 'Decline', icon: 'call-stop-symbolic', style: 'button tuple-big tuple-alert', expand: true, onClick: () => s.decline()}));
        box.add_child(row);
        this._incomingItem = menuItem(box);
        this.menu.addMenuItem(this._incomingItem);
    }

    _buildCall() {
        const s = this._service;
        const box = vbox({style_class: 'tuple-section'});

        this._peersBox = vbox({style_class: 'tuple-peers'});
        box.add_child(this._peersBox);

        // Their screen: bring it forward, and choose draw or drive.
        this._theirScreen = hbox({style_class: 'tuple-their-screen'});
        this._theirScreen.add_child(label('Their screen', {expand: true}));
        this._controlLabel = label('Control', {style: 'tuple-caption'});
        this._theirScreen.add_child(this._controlLabel);
        this._controlButton = switchButton('Control their screen', () => s.guestMode === 'control',
            on => s.setGuestMode(on ? 'control' : 'annotation'));
        this._control = this._controlButton._switch;
        this._theirScreen.add_child(this._controlButton);
        this._theirScreen.add_child(button({text: 'View', onClick: () => {
            this.menu.close();
            s.viewScreen();
        }}));
        box.add_child(this._theirScreen);

        // The call controls. Mic and Camera are split: the face toggles,
        // the caret picks a device.
        const tiles = hbox({style_class: 'tuple-tiles'});
        this._micTile = this._tile('Mic on', 'audio-input-microphone-symbolic', () => s.toggleMute(), () => this._showDevices('mic'));
        this._shareTile = this._tile('Share', 'screen-shared-symbolic', () => s.toggleShare());
        this._cameraTile = this._tile('Camera', 'camera-web-symbolic', () => s.toggleCamera(), () => this._showDevices('camera'));
        this._linkTile = this._tile('Link', 'insert-link-symbolic', () => s.copy(s.personalUrl, 'Call link'));
        this._endTile = this._tile('End', 'call-stop-symbolic', () => s.endCall());
        this._endTile.face.add_style_class_name('tuple-alert');
        for (const t of [this._micTile, this._shareTile, this._cameraTile, this._linkTile, this._endTile])
            tiles.add_child(t);
        box.add_child(tiles);

        this._devices = vbox({style_class: 'tuple-devices'});
        this._devicesHeading = label('', {style: 'tuple-heading', dim: true});
        this._devices.add_child(this._devicesHeading);
        this._deviceList = vbox();
        this._devices.add_child(this._deviceList);
        box.add_child(this._devices);

        this._cameraHint = label(
            "Only you can see your camera. Tuple for Linux can't send video yet, so they'll see it when you share your screen.",
            {style: 'tuple-caption', dim: true, wrap: true});
        box.add_child(this._cameraHint);

        this._callSep = new PopupMenu.PopupSeparatorMenuItem();
        this.menu.addMenuItem(this._callSep);
        this._callItem = menuItem(box);
        this.menu.addMenuItem(this._callItem);
    }

    // A call control: icon over label, latched when on.
    _tile(text, iconName, onClick, onCaret = null) {
        const tile = hbox({style_class: 'tuple-tile-group', x_expand: true});
        const face = new St.Button({style_class: 'button tuple-tile', can_focus: true, x_expand: true, accessible_name: text});
        const inner = vbox({x_align: Clutter.ActorAlign.CENTER});
        tile.icon = new St.Icon({icon_name: iconName, style_class: 'tuple-tile-icon', x_align: Clutter.ActorAlign.CENTER});
        tile.label = label(text, {style: 'tuple-tile-label'});
        tile.label.x_align = Clutter.ActorAlign.CENTER;
        inner.add_child(tile.icon);
        inner.add_child(tile.label);
        face.set_child(inner);
        face.connect('clicked', () => onClick());
        tile.face = face;
        tile.add_child(face);
        if (onCaret) {
            tile.caret = new St.Button({
                style_class: 'button tuple-caret',
                can_focus: true,
                child: new St.Icon({icon_name: 'pan-down-symbolic', style_class: 'popup-menu-icon'}),
                accessible_name: `Choose ${text === 'Camera' ? 'a camera' : 'a microphone'}`,
            });
            tile.caret.connect('clicked', () => onCaret());
            tile.add_child(tile.caret);
            tile.add_style_class_name('split');
        }
        return tile;
    }

    _setTile(tile, {text, iconName, checked = false, busy = false, visible = true}) {
        tile.visible = visible;
        if (text !== undefined) {
            tile.label.text = text;
            tile.face.accessible_name = text;
        }
        if (iconName)
            tile.icon.icon_name = iconName;
        tile.face.checked = checked;
        if (tile.caret)
            tile.caret.checked = checked;
        if (busy !== !!tile._busy) {
            tile._busy = busy;
            setPulse(tile.icon, busy);
        }
    }

    _buildPair() {
        const row = hbox({style_class: 'tuple-field-row'});
        this._pairEntry = new St.Entry({hint_text: 'Paste a call link to join', can_focus: true, x_expand: true, style_class: 'tuple-entry'});
        this._pairEntry.clutter_text.connect('activate', () => this._pair());
        this._pairEntry.clutter_text.connect('text-changed', () => this._sync());
        row.add_child(this._pairEntry);
        this._pairButton = button({text: 'New call', style: 'button tuple-pair-button', onClick: () => this._pair()});
        row.add_child(this._pairButton);
        this._pairSep = new PopupMenu.PopupSeparatorMenuItem();
        this.menu.addMenuItem(this._pairSep);
        this._pairItem = menuItem(row);
        this.menu.addMenuItem(this._pairItem);
    }

    _pair() {
        const s = this._service;
        const text = this._pairEntry.text;
        if (Model.extractCallUrl(text) !== '') {
            s.join(text);
            this._pairEntry.text = '';
        } else if (text.trim() !== '') {
            s.join(text);       // surfaces the "not a call link" error
        } else {
            s.newCall();
        }
    }

    _buildPeople() {
        const box = vbox({style_class: 'tuple-section'});
        const header = hbox({style_class: 'tuple-people-header'});
        header.add_child(label('PEOPLE', {style: 'tuple-heading', dim: true, expand: true}));
        this._availableLabel = label('', {style: 'tuple-caption', dim: true});
        header.add_child(this._availableLabel);
        box.add_child(header);

        this._searchEntry = new St.Entry({hint_text: 'Search people', can_focus: true, x_expand: true, style_class: 'tuple-entry'});
        this._searchEntry.clutter_text.connect('text-changed', () => {
            this._query = this._searchEntry.text;
            this._peopleScroll.vadjustment.value = 0;
            this._searchSoon();
            this._sync();
        });
        box.add_child(this._searchEntry);

        this._peopleList = vbox({style_class: 'tuple-people'});
        this._peopleScroll = new St.ScrollView({
            style_class: 'tuple-people-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            child: this._peopleList,
        });
        box.add_child(this._peopleScroll);

        this._peopleHint = label('', {style: 'tuple-hint', dim: true, wrap: true});
        box.add_child(this._peopleHint);

        this._peopleSep = new PopupMenu.PopupSeparatorMenuItem();
        this.menu.addMenuItem(this._peopleSep);
        this._peopleItem = menuItem(box);
        this.menu.addMenuItem(this._peopleItem);
    }

    // ── Rows ──────────────────────────────────────────────────────────────
    // Redraw rows that show people (a picture arrived, or pictures were
    // turned on or off).
    refreshPeople() {
        this._keys = {};
        this._sync();
    }

    // A person ({name, email}): their profile picture once it's here, their
    // initials until then (or if they have none). The presence dot sits on
    // either.
    _avatar(person, {online = true, dot = online} = {}) {
        const avatar = new St.Widget({
            style_class: `tuple-avatar${online ? ' online' : ''}`,
            layout_manager: new Clutter.BinLayout(),
            y_align: Clutter.ActorAlign.CENTER,
        });
        const picture = this._ext.picture(person.email);
        if (picture) {
            const photo = new St.Bin({
                style_class: 'tuple-avatar-photo',
                x_expand: true,
                y_expand: true,
                style: `background-image: url("${picture}"); background-size: cover;`,
            });
            photo.opacity = online ? 255 : DIM;
            avatar.add_child(photo);
        } else {
            const initials = label(Model.initials(person.name), {style: 'tuple-initials'});
            initials.x_align = Clutter.ActorAlign.CENTER;
            initials.opacity = online ? 255 : DIM;
            avatar.add_child(initials);
        }
        if (dot) {
            avatar.add_child(new St.Widget({
                style_class: 'tuple-presence',
                x_align: Clutter.ActorAlign.END,
                y_align: Clutter.ActorAlign.END,
                x_expand: true,
                y_expand: true,
            }));
        }
        return avatar;
    }

    _personRow(person, caption) {
        const row = hbox({style_class: 'tuple-person'});
        row.add_child(this._avatar(person));
        row.add_child(label(person.name, {expand: true}));
        if (caption)
            row.add_child(label(caption, {style: 'tuple-caption', dim: true}));
        return row;
    }

    _contactRow(contact) {
        const s = this._service;
        const row = hbox({style_class: 'popup-menu-item tuple-contact', reactive: true, track_hover: true});
        row._contact = contact;
        row.add_child(this._avatar(contact, {online: contact.online}));
        const name = label(contact.name, {expand: true});
        if (!contact.online)
            name.opacity = DIM;
        row.add_child(name);

        // At rest: what's worth knowing. On hover or focus: what you can do.
        const presence = Model.contactPresence(contact);
        const star = contact.favorite && this._query !== '' ? '★' : '';
        const rest = label([presence, star].filter(x => x).join('  '), {style: 'tuple-caption', dim: true});
        row.add_child(rest);

        const actions = hbox({style_class: 'tuple-row-actions'});
        const fav = iconButton(contact.favorite ? 'starred-symbolic' : 'non-starred-symbolic',
            contact.favorite ? 'Remove from favorites' : 'Add to favorites', () => s.toggleFavorite(contact));
        const callable = contact.online && !s.inCall && !s.incoming;
        const call = iconButton('call-start-symbolic', callable ? `Call ${contact.name}` : 'Not available', () => s.callContact(contact));
        call.reactive = callable && !s.isPending('call');
        if (!callable)
            call.opacity = DIM;
        actions.add_child(fav);
        actions.add_child(call);
        row.add_child(actions);

        const reveal = () => {
            const on = row.hover || fav.has_key_focus() || call.has_key_focus();
            actions.opacity = on ? 255 : 0;
            rest.visible = !on;
        };
        row.connect('notify::hover', reveal);
        for (const b of [fav, call]) {
            b.connect('key-focus-in', () => {
                reveal();
                ensureActorVisibleInScrollView(this._peopleScroll, row);
            });
            b.connect('key-focus-out', reveal);
        }
        reveal();
        return row;
    }

    _settingRow(setting) {
        const s = this._service;
        const item = new PopupMenu.PopupBaseMenuItem({
            reactive: setting.type !== 'text',
            can_focus: setting.type !== 'text',
            style_class: 'tuple-setting',
        });
        const text = vbox({x_expand: true});
        text.add_child(label(Model.settingLabel(setting.name)));
        const hint = setting.type === 'text' ? ` — set with: tuple set ${setting.name} <value>` : '';
        text.add_child(label(setting.description + hint, {style: 'tuple-caption', dim: true, wrap: true}));
        item.add_child(text);
        // A click (or Enter) on the row cycles the value; not emitting
        // 'activate' keeps the menu open. A bool's switch can also be flipped
        // by its knob, which the row never hears about (see switchButton).
        if (setting.type === 'bool') {
            const on = setting.value === '1';
            const sw = new PopupMenu.Switch(on);
            sw.connect('notify::state', () => {
                if (sw.state !== on)
                    s.setTupleSetting(setting.name, sw.state ? '1' : '0');
            });
            item.add_child(sw);
            item.activate = () => sw.toggle();
        } else {
            const value = label(setting.value !== '' ? setting.value : '—', {style: 'tuple-caption'});
            if (setting.type !== 'choice')
                value.opacity = DIM;
            item.add_child(value);
            item.activate = () => s.cycleSetting(setting);
        }
        return item;
    }

    _showDevices(kind) {
        const s = this._service;
        this._deviceKind = this._deviceKind === kind ? '' : kind;
        if (this._deviceKind === 'mic')
            s.refreshMics();
        else if (this._deviceKind === 'camera')
            s.refreshCameras();
        this._sync();
    }

    _syncDevices() {
        const s = this._service;
        const kind = this._deviceKind;
        this._devices.visible = kind !== '' && s.inCall;
        this._micTile.caret.checked = kind === 'mic';
        this._cameraTile.caret.checked = kind === 'camera';
        if (!this._devices.visible)
            return;
        let options, value;
        if (kind === 'mic') {
            const def = Model.findMic(s.mics, s.defaultMic);
            options = [{value: '', label: 'System default', detail: def ? def.label : ''}]
                .concat(s.mics.map(m => ({value: m.name, label: m.label, detail: ''})));
            value = s.micIsDefault ? '' : s.micDevice;
        } else {
            options = [{value: '', label: 'System default', detail: s.cameras.length > 0 ? s.cameras[0].name : ''}]
                .concat(s.cameras.map(c => ({value: c.name, label: c.name, detail: ''})));
            value = s.cameraIsDefault ? '' : (s.camera ? s.camera.name : '');
        }
        this._devicesHeading.text = kind === 'mic' ? 'MICROPHONE' : 'CAMERA';
        const key = JSON.stringify([kind, options, value]);
        if (key === this._keys.devices)
            return;
        this._keys.devices = key;
        this._deviceList.destroy_all_children();
        for (const opt of options) {
            const box = hbox({style_class: 'tuple-row-box'});
            const check = new St.Icon({icon_name: 'object-select-symbolic', style_class: 'popup-menu-icon'});
            check.opacity = opt.value === value ? 255 : 0;
            box.add_child(check);
            box.add_child(label(opt.label, {expand: true}));
            if (opt.detail)
                box.add_child(label(opt.detail, {style: 'tuple-caption', dim: true}));
            this._deviceList.add_child(rowButton(box, () => {
                if (kind === 'mic')
                    s.chooseMic(opt.value);
                else
                    s.chooseCameraName(opt.value);
                this._showDevices('');
            }));
        }
    }

    // ── Sync ──────────────────────────────────────────────────────────────
    _sync() {
        const s = this._service;
        const loggedIn = s.loggedIn;

        // Bar mark.
        const mark = this._mark;
        const markClass = s.incoming ? 'ringing' : (s.inCall ? (s.muted ? 'muted' : 'live') : '');
        if (markClass !== this._markClass) {
            if (this._markClass)
                mark.remove_style_class_name(this._markClass);
            if (markClass)
                mark.add_style_class_name(markClass);
            this._markClass = markClass;
            mark.queue_repaint();
        }
        const dim = !s.installed || !s.daemon || !loggedIn;
        const rest = dim ? DIM : 255;
        if (s.incoming !== !!this._ringing || (!s.incoming && mark.opacity !== rest)) {
            this._ringing = s.incoming;
            setPulse(mark, s.incoming, rest);
        }
        mark.setState({
            crossed: s.installed && !s.daemon,
            badge: s.sharing ? 'sharing' : (s.daemon && s.auth === 0 ? 'warning' : ''),
        });
        let a11y = `Tuple: ${s.statusText}`;
        if (s.inCall)
            a11y += (s.muted ? ', muted' : '') + (s.sharing ? ', sharing' : '');
        this.accessible_name = a11y;

        if (!this.menu.isOpen)
            return;

        // Hero.
        this._statusLabel.text = s.statusText;
        this._heroMark.setState({crossed: !s.daemon, badge: s.inCall && !s.muted ? 'live' : ''});
        this._heroMark.opacity = s.daemon ? 255 : 128;
        if (s.incoming !== !!this._heroRinging) {
            this._heroRinging = s.incoming;
            setPulse(this._heroMark, s.incoming);
        }
        this._powerButton.visible = s.installed;
        this._power.state = s.daemonTarget;
        this._powerButton.opacity = s.isPending('start') || s.isPending('stop') ? DIM : 255;

        const message = s.lastError !== '' ? s.lastError : s.actionStatus;
        this._message.text = message;
        this._messageItem.visible = message !== '';
        if (s.lastError !== '')
            this._message.add_style_class_name('tuple-error');
        else
            this._message.remove_style_class_name('tuple-error');
        this._notInstalled.visible = !s.installed;

        // Login.
        const login = s.daemon && s.auth === 0;
        this._loginSep.visible = this._loginItem.visible = login;
        this._loginTitle.text = s.loginUrl !== '' ? 'Restart login' : 'Log in';
        this._loginRow.opacity = s.isPending('login') ? DIM : 255;
        this._loginUrlRow.visible = s.loginUrl !== '';
        this._loginUrlLabel.text = s.loginUrl;
        this._authRow.visible = s.loginPending || s.loginUrl !== '';
        this._authButton.reactive = this._authEntry.text.trim() !== '' && !s.isPending('auth');

        // Incoming: who, then Answer / Decline.
        this._incomingItem.visible = loggedIn && s.incoming;
        if (this._incomingItem.visible) {
            const caller = s.incomingPerson;
            const key = JSON.stringify([caller, this._ext.picture(caller.email)]);
            if (key !== this._keys.caller) {
                this._keys.caller = key;
                this._callerBox.destroy_all_children();
                this._callerBox.add_child(this._personRow(caller, 'Calling…'));
            }
        }

        // In a call.
        const inCall = loggedIn && s.inCall;
        this._callSep.visible = this._callItem.visible = inCall;
        if (inCall)
            this._syncCall();

        // Start or join.
        const showPair = loggedIn && !s.inCall && !s.incoming;
        this._pairSep.visible = this._pairItem.visible = showPair;
        // A call link on the clipboard is almost certainly the one you're
        // about to join: put it in the field so the button reads "Join".
        if (showPair && this._pairEntry.text === '' && s.clipboardCallUrl !== '' && this._prefilled !== s.clipboardCallUrl) {
            this._prefilled = s.clipboardCallUrl;
            this._pairEntry.text = s.clipboardCallUrl;
        }
        const joinable = Model.extractCallUrl(this._pairEntry.text) !== '';
        const working = s.isPending('new') || s.isPending('join');
        this._pairButton._label.text = s.isPending('join') ? 'Joining…'
            : s.isPending('new') ? 'Starting…'
                : joinable ? 'Join' : 'New call';
        if (joinable && !working)
            this._pairButton.add_style_class_name('default');
        else
            this._pairButton.remove_style_class_name('default');
        this._pairButton.reactive = !working;

        // People.
        this._peopleSep.visible = this._peopleItem.visible = loggedIn;
        if (loggedIn)
            this._syncPeople();

        // Settings and footer.
        this._settingsMenu.visible = loggedIn && s.tupleSettings.length > 0;
        if (this._settingsMenu.visible)
            this._syncSettings();
        this._footerSep.visible = true;
        this._uiButton.visible = s.daemon;
        this._meRow.visible = loggedIn && s.me !== null;
        if (this._meRow.visible) {
            const key = JSON.stringify([s.me, this._ext.picture(s.me.email)]);
            if (key !== this._keys.me) {
                this._keys.me = key;
                this._meAvatar.set_child(this._avatar(s.me, {dot: false}));
                this._meName.text = s.me.name;
            }
        }

        this._syncDevices();
    }

    _syncCall() {
        const s = this._service;
        const peers = s.peers;
        const captions = peers.map(p => {
            if (s.calling)
                return 'Ringing…';
            if (s.peerSharing && peers.length === 1)
                return 'Sharing';
            if (p.muted)
                return 'Muted';
            return s.peerWebcam && peers.length === 1 ? 'Camera on' : '';
        });
        const shown = peers.length === 0 && s.calling ? [s.calling] : peers;
        const key = JSON.stringify([shown.map(p => [p.name, this._ext.picture(p.email)]), captions]);
        if (key !== this._keys.peers) {
            this._keys.peers = key;
            this._peersBox.destroy_all_children();
            if (peers.length === 0 && s.calling)
                this._peersBox.add_child(this._personRow(s.calling, 'Ringing…'));
            peers.forEach((p, i) => this._peersBox.add_child(this._personRow(p, captions[i])));
        }
        this._peersBox.visible = this._peersBox.get_n_children() > 0;

        this._theirScreen.visible = s.peerSharing;
        this._control.state = s.guestMode === 'control';
        this._controlLabel.opacity = s.guestMode === 'control' ? 255 : DIM;

        const micName = s.mic ? s.mic.label : 'System default';
        this._setTile(this._micTile, {
            text: s.muted ? 'Muted' : 'Mic on',
            iconName: s.muted ? 'microphone-disabled-symbolic' : 'audio-input-microphone-symbolic',
            checked: s.muted,
            busy: s.isPending('mute') || s.isPending('unmute'),
        });
        this._micTile.face.accessible_name = `${s.muted ? 'Unmute' : 'Mute'} · ${micName}`;
        this._setTile(this._shareTile, {
            text: s.sharing ? 'Sharing' : 'Share',
            checked: s.sharing,
            busy: s.isPending('share') || s.isPending('unshare'),
        });
        this._setTile(this._cameraTile, {
            iconName: s.cameraOn ? 'camera-web-symbolic' : 'camera-disabled-symbolic',
            checked: s.cameraOn,
        });
        this._cameraTile.caret.visible = s.cameras.length > 0;
        this._setTile(this._linkTile, {visible: s.personalUrl !== ''});
        this._setTile(this._endTile, {busy: s.isPending('end')});
        this._cameraHint.visible = s.cameraOn && !s.sharing;
    }

    _syncPeople() {
        const s = this._service;
        const counts = s.contactCounts;
        this._availableLabel.text = counts.online > 0 ? `${counts.online} available` : '';
        const shown = s.shownContacts(this._query);
        const featured = s.shownContacts('');
        // Only worth showing when the list can't show everyone.
        this._searchEntry.visible = Math.max(counts.total, s.contacts.length) > featured.length || this._query !== '';

        const key = JSON.stringify([this._query, s.inCall, s.incoming, s.isPending('call'),
            shown.map(c => [c.id, c.status, c.favorite, c.inCall, this._ext.picture(c.email)])]);
        if (key !== this._keys.people) {
            this._keys.people = key;
            this._peopleList.destroy_all_children();
            for (const c of shown)
                this._peopleList.add_child(this._contactRow(c));
        }
        this._peopleScroll.visible = shown.length > 0;

        let hint = '';
        if (shown.length === 0) {
            if (!s.contactsLoaded)
                hint = 'Loading people…';
            else if (this._query !== '' && s.searching)
                hint = 'Searching…';
            else if (this._query !== '')
                hint = `No one matches “${this._query}”.`;
            else if (counts.total === 0)
                hint = 'No one here yet.';
            else
                hint = "No one's available. Search for someone and star them to call them from here.";
        } else if (this._query !== '' && shown.length >= s.contactLimit) {
            hint = 'Keep typing to narrow it down.';
        }
        this._peopleHint.text = hint;
        this._peopleHint.visible = hint !== '';
    }

    _syncSettings() {
        const s = this._service;
        const key = JSON.stringify(s.tupleSettings);
        if (key === this._keys.settings)
            return;
        this._keys.settings = key;
        this._settingsMenu.menu.removeAll();
        for (const setting of s.tupleSettings)
            this._settingsMenu.menu.addMenuItem(this._settingRow(setting));
    }

    // ── Keys ──────────────────────────────────────────────────────────────
    // Single-letter shortcuts while the menu has focus (not while typing in
    // a field): m mute, s share, v camera, e end/decline, a answer, n new
    // call, c copy link, i join field, / search, f favorite the focused
    // person, o on/off, r refresh. Shift+M / Shift+V pick a mic / camera.
    _onKey() {
        if (global.stage.key_focus instanceof Clutter.Text)
            return Clutter.EVENT_PROPAGATE;
        const [, , state, unichar] = this._keyController.get_key();
        if (state & (Clutter.ModifierType.CONTROL_MASK | Clutter.ModifierType.MOD1_MASK | Clutter.ModifierType.SUPER_MASK))
            return Clutter.EVENT_PROPAGATE;
        const ch = typeof unichar === 'number' ? (unichar > 0 ? String.fromCodePoint(unichar) : '') : String(unichar ?? '');
        const s = this._service;
        const showPair = s.loggedIn && !s.inCall && !s.incoming;
        const focusIn = entry => {
            if (entry.visible)
                entry.grab_key_focus();
        };
        switch (ch) {
        case 'M': if (s.inCall) this._showDevices('mic'); else return Clutter.EVENT_PROPAGATE; break;
        case 'V': if (s.inCall) this._showDevices('camera'); else return Clutter.EVENT_PROPAGATE; break;
        case 'm': if (s.inCall) s.toggleMute(); break;
        case 's': if (s.inCall) s.toggleShare(); break;
        case 'v': if (s.inCall) s.toggleCamera(); break;
        case 'e': if (s.incoming) s.decline(); else if (s.inCall) s.endCall(); break;
        case 'a': if (s.incoming) s.answer(); break;
        case 'n': if (showPair) s.newCall(); break;
        case 'c': if (s.personalUrl !== '') s.copy(s.personalUrl, 'Call link'); break;
        case 'i': if (showPair) focusIn(this._pairEntry); break;
        case '/': focusIn(this._searchEntry); break;
        case 'f': {
            const contact = this._focusedContact();
            if (contact)
                s.toggleFavorite(contact);
            break;
        }
        case 'o': s.toggleDaemon(); break;
        case 'r': s.refresh(true); break;
        default: return Clutter.EVENT_PROPAGATE;
        }
        return Clutter.EVENT_STOP;
    }

    _focusedContact() {
        for (let a = global.stage.key_focus; a; a = a.get_parent()) {
            if (a._contact)
                return a._contact;
        }
        return null;
    }

    // ── IPC (bin/tuple-shell) ────────────────────────────────────────────
    ipc(name, arg) {
        const s = this._service;
        switch (name) {
        case 'open': case 'show': this.menu.open(); return 'ok';
        case 'close': case 'hide': this.menu.close(); return 'ok';
        case 'toggle': this.menu.toggle(); return 'ok';
        case 'refresh': s.refresh(true); return 'ok';
        case 'on': s.turnOn(); return 'ok';
        case 'off': s.turnOff(); return 'ok';
        case 'newCall': s.newCall(); return 'ok';
        case 'join': s.join(arg); return 'ok';
        case 'joinClipboard': s.joinClipboard(); return 'ok';
        case 'mute': s.setMuted(true); return 'ok';
        case 'unmute': s.setMuted(false); return 'ok';
        case 'toggleMute': s.toggleMute(); return 'ok';
        case 'share': s.setSharing(true); return 'ok';
        case 'unshare': s.setSharing(false); return 'ok';
        case 'toggleShare': s.toggleShare(); return 'ok';
        case 'toggleCamera': {
            const on = !s.cameraOn;
            s.toggleCamera();
            return on ? 'on' : 'off';
        }
        case 'end': s.endCall(); return 'ok';
        case 'answer': s.answer(); return 'ok';
        case 'decline': s.decline(); return 'ok';
        case 'copyLink': s.copy(s.personalUrl, 'Call link'); return s.personalUrl;
        case 'cameras':
            s.refreshCameras();
            return s.cameras.map((c, i) => `${i + 1}) ${c.name}  ${c.dev}${s.camera && s.camera.dev === c.dev ? '  (selected)' : ''}`).join('\n');
        case 'camera': s.selectCamera(arg); return s.camera ? s.camera.name : '';
        case 'cycleCamera': s.cycleCamera(); return s.camera ? s.camera.name : '';
        case 'mics':
            s.refreshMics();
            return s.mics.map((m, i) => `${i + 1}) ${m.label}  ${m.name}${m.name === s.defaultMic ? '  (system default)' : ''}${!s.micIsDefault && s.mic && s.mic.name === m.name ? '  (selected)' : ''}`).join('\n');
        case 'mic': s.selectMic(arg); return s.micIsDefault ? 'default' : (s.mic ? s.mic.label : '');
        case 'deviceMenu':
            if (!s.inCall)
                return 'not in a call';
            this.menu.open();
            this._deviceKind = '';
            this._showDevices(arg === 'camera' ? 'camera' : 'mic');
            return 'ok';
        case 'demo': {
            const result = s.setDemo(arg);
            this._keys = {};
            this._sync();
            return result;
        }
        case 'status': return s.statusJson();
        default: return `unknown command “${name}”`;
        }
    }
});

// ── The extension ────────────────────────────────────────────────────────

export default class TupleExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._stage = new WindowStage(this._settings);
        this._icon = new Gio.ThemedIcon({names: ['tuple', 'call-start-symbolic']});
        this._avatars = new Avatars(() => this._indicator?.refreshPeople());
        this._settings.connectObject('changed::show-avatars', () => this._indicator?.refreshPeople(), this);
        this.service = new Service({settings: this._settings, dir: this.path, host: this._host()});
        this._indicator = new TupleIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);

        this._dbus = Gio.DBusExportedObject.wrapJSObject(DBUS_IFACE, this);
        this._dbus.export(Gio.DBus.session, DBUS_PATH);
    }

    disable() {
        this._dbus?.unexport();
        this._dbus = null;
        this.service?.destroy();
        this.service = null;
        this._indicator?.destroy();
        this._indicator = null;
        this._stage?.destroy();
        this._stage = null;
        this._source?.destroy();
        this._source = null;
        this._avatars?.destroy();
        this._avatars = null;
        this._settings?.disconnectObject(this);
        this._settings = null;
        this._icon = null;
    }

    // Someone's profile picture (a file path), when pictures are on and it's
    // been fetched; null otherwise (and then it's on its way).
    picture(email) {
        if (!email || !this._settings?.get_boolean('show-avatars'))
            return null;
        return this._avatars?.path(email) ?? null;
    }

    // D-Bus: org.gnome.Shell.Extensions.Tuple.Call(name, argument) → result
    Call(name, argument) {
        try {
            return String(this._indicator.ipc(name, argument) ?? '');
        } catch (e) {
            return `error: ${e.message}`;
        }
    }

    _host() {
        const clipboard = St.Clipboard.get_default();
        return {
            copy: text => clipboard.set_text(St.ClipboardType.CLIPBOARD, text),
            readClipboard: cb => clipboard.get_text(St.ClipboardType.CLIPBOARD, (_c, text) => cb(text ?? '')),
            openUrl: url => {
                try {
                    Gio.AppInfo.launch_default_for_uri(url, global.create_app_launch_context(0, -1));
                } catch (e) {
                    this.service?.say(e.message, true);
                }
            },
            notify: opts => this._notify(opts),
            arrangeWindows: () => this._stage?.arrange(),
            focusWindow: role => this._stage?.focus(role) ?? false,
            windowSizes: () => this._stage?.sizes() ?? '',
        };
    }

    // With `email`, the notification shows that person's picture.
    _notify({title, body = '', urgency = 'normal', transient = false, actions = [], email = ''}) {
        const picture = this.picture(email);
        if (!this._source) {
            this._source = new MessageTray.Source({title: 'Tuple', icon: this._icon});
            this._source.connect('destroy', () => {
                this._source = null;
            });
            Main.messageTray.add(this._source);
        }
        const notification = new MessageTray.Notification({
            source: this._source,
            title,
            body,
            gicon: picture ? new Gio.FileIcon({file: Gio.File.new_for_path(picture)}) : this._icon,
            urgency: {
                low: MessageTray.Urgency.LOW,
                normal: MessageTray.Urgency.NORMAL,
                critical: MessageTray.Urgency.CRITICAL,
            }[urgency] ?? MessageTray.Urgency.NORMAL,
            isTransient: transient,
        });
        for (const action of actions)
            notification.addAction(action.label, action.callback);
        let alive = true;
        notification.connect('destroy', () => {
            alive = false;
        });
        this._source.addNotification(notification);
        return {
            destroy: () => {
                if (alive)
                    notification.destroy();
            },
        };
    }
}
