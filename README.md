# Tuple for GNOME

A top-bar indicator and menu for [Tuple's Linux client](https://tuple.app/linux/)
on GNOME Shell 51. Tuple for Linux is a command-line tool; this gives it a
home in your top bar.

It's a fork and port of Benjamin Sehl's
[omarchy-tuple](https://github.com/benjaminsehl/omarchy-tuple), a plugin for
Omarchy's Quickshell bar on Hyprland. The port keeps its log parser, design
rules and helper scripts, and replaces the Omarchy/Hyprland side with GNOME
Shell's own. It also targets the newer **v2026_10_23.0** client, whose CLI
changed a lot (see below).

<table>
  <tr>
    <td><img src="docs/screenshots/idle.png" width="270" alt="Ready to pair: one field to start or join a call, then your people"></td>
    <td><img src="docs/screenshots/call.png" width="270" alt="In a call: mute, share, camera, copy link and end"></td>
    <td><img src="docs/screenshots/incoming.png" width="270" alt="An incoming call with Answer and Decline"></td>
  </tr>
  <tr>
    <td align="center"><sub><b>Ready to pair.</b> One field starts or joins a call.</sub></td>
    <td align="center"><sub><b>In a call.</b> The controls show their state.</sub></td>
    <td align="center"><sub><b>Ringing.</b> Who's calling, and Answer.</sub></td>
  </tr>
</table>

<sub>Screenshots use the built-in demo data (`tuple-shell demo <state>`).</sub>

## What you get

- **Top-bar mark:** Tuple's two squares in the panel colour. It's dimmed with a
  slash when Tuple is off, gets a red dot when you're logged out, turns red
  during a call (darker red when muted), gets a dot while you share, and
  pulses while a call rings.
  - Left click opens the menu.
  - Right click mutes or unmutes in a call, or answers a ringing call.
  - Middle click shares or unshares in a call, or refreshes otherwise.
- **Menu:**
  - an on/off switch for the daemon
  - browser login with an authorization-code field
  - one field that starts a new call (and copies its link) or joins a pasted
    link; a link on the clipboard is filled in for you
  - in-call controls: mute, share, camera, copy link, end. The Mic and Camera
    tiles have a ▾ that picks the device.
  - who's in the call, and a "Their screen" row (View, and a Control switch
    for draw vs. drive)
  - people: favourites, then recent, then available, with search across the
    whole directory, a ★ toggle, and one-click calling for anyone online
  - all of `tuple settings`
  - you (picture and name) with Log out; Tuple's own window and Preferences
- **Profile pictures** for people in the list, in your call, ringing you,
  and in their notifications, with initials for anyone without one. They come
  from Gravatar, which is where Tuple's own `avatar_url` fields point: the
  address is the MD5 of the email, so Gravatar sees those hashes, as it does
  with Tuple's own apps. Only people the menu shows are fetched, a few at a
  time, in the background. They're cached in `~/.cache/tuple-gnome/avatars`
  for a week (a "no picture" answer for a day). Turn them off in Preferences.
- **Notifications** (GNOME's own, with buttons): incoming call
  (Answer/Decline), join request (Show), someone joined, "everyone left"
  (End call), and no answer.
- **Window placement** (Mutter instead of `hyprctl`): Tuple's prompts are
  centred, and incoming-call and join-request prompts stay on top. Their webcam
  and your camera tile sit as equal squares in the bottom-right corner, on
  every workspace, without taking focus.
- **Keys in the menu:** arrows and Tab move between controls. The letter
  shortcuts work when you're not typing in a field:
  - `m` mute, `s` share, `v` camera
  - `e` end or decline, `a` answer
  - `n` new call, `c` copy link, `i` join field, `/` search
  - `f` favourite the focused person
  - `o` on/off, `r` refresh
  - `M` / `V` choose a mic / camera
- **`tuple-shell`** drives it from a terminal or a GNOME custom shortcut:

  ```bash
  tuple-shell toggle | toggleMute | toggleShare | toggleCamera | end | answer | newCall | joinClipboard | copyLink | on | off
  tuple-shell join https://tuple.app/c/xyz
  tuple-shell cameras | camera <name|number|default> | mics | mic <...> | deviceMenu mic|camera
  tuple-shell status          # JSON: daemon, loggedIn, call, peers, muted, sharing, …
  tuple-shell demo call       # canned states: call | idle | viewing | incoming | login | stopped | off
  ```

  For a shortcut, go to Settings → Keyboard → Custom Shortcuts and add, e.g.,
  `tuple-shell toggleMute` on Super+Ctrl+M.

## Requirements

- GNOME Shell 51 (Wayland or X11). Other versions aren't tested, and
  `metadata.json` says so.
- The Tuple CLI from [tuple.app/linux](https://tuple.app/linux/) (tested
  with v2026_10_23.0), in `~/.local/bin` or `~/bin` or on `PATH` (or set its
  path in Preferences), and a Tuple account
- `jq`: the people list is filtered with it, outside the shell
- Optional:
  - `pactl` (PipeWire/PulseAudio) for choosing a mic
  - `v4l2-ctl` (v4l-utils) for the camera list
  - `mpv` for your camera tile

  Everything else works without them.

## Install

```bash
git clone https://github.com/ericflo/gnome-tuple.git ~/Projects/gnome-tuple
cd ~/Projects/gnome-tuple
./install.sh      # links tuple@ericflo into ~/.local/share/gnome-shell/extensions,
                  # compiles the schema, links tuple-shell into ~/.local/bin, enables it
./uninstall.sh    # undoes all of that
```

GNOME Shell on Wayland only discovers new extensions when it starts. After the
first install, or after changing the code, log out and back in. Then click
the Tuple mark, switch Tuple on, and choose **Log in**.

## How the v2026_10_23.0 client differs from what omarchy-tuple targeted

Tuple replaced the original Linux commands with its cross-platform CLI.

- **Live state:** `tuple state follow --format json` streams a summary
  whenever it changes. It covers whether you're signed in, whether you're in a
  call and with whom, mute, and connection health. It's the main feed now, so
  mute is no longer guessed from replies.
- **Renamed commands:**

  | Before | Now |
  | --- | --- |
  | `on` / `off` | `start` / `stop` |
  | `ls` | `contacts list --format json` |
  | `call` (interactive prompt) | `call start <person>` (any contact, not just favourites; exits 0 when answered, 2 when not) |
  | `join` / `end` | `call join` / `call leave` |
  | `mute` | `call mute` / `call unmute` |
  | — | `call accept` (answers without Tuple's window) |

  `new`, `share`, `unshare`, `ui`, `settings` and `set` still work but are
  deprecated.
- **Socket:** the daemon listens on `$XDG_RUNTIME_DIR/tuple-0` instead of
  `@tuple-daemon`, and still starts itself for almost any command. So the
  extension checks `/proc/net/unix` and only follows state while the daemon is
  up. Otherwise "off" wouldn't stay off.
- **Daemon log:** `~/.local/share/tuple/0/log.txt` keeps its format. The
  original's log reducer (`model.js`) still supplies what the summary lacks: a
  call ringing in, your screen share, their screen and webcam, and join
  requests.

- **Big directories:** `tuple contacts list --format json` prints the whole
  company directory (~1.7MB for 8k people), and most of it reports presence as
  "unknown". The extension never parses that in the shell, because doing so
  stalled the desktop. `bin/tuple-contacts` filters it to favourites, recents
  and whoever's online, and search uses Tuple's own `contacts list -q`.

## Known gaps

- **Not yet seen live:** these work against a real account and directory:
  - signing in
  - on/off
  - the people list and search
  - profile pictures

  These are built from the CLI's published output schemas (`tuple mcp` →
  `tools/list`) and the original's call logs, but haven't been seen in a real
  call:
  - a ringing incoming call
  - screen sharing and their webcam
  - where Tuple's windows land
  - mic routing

  `tuple-shell status` shows what the extension currently believes.
- **Their screen on GNOME:** guests can watch but not drive your screen.
  That's Tuple's limitation on GNOME/KDE Wayland, not this extension's.
- **No webcam sending or input selection yet:** Tuple for Linux can't send
  your webcam or choose a mic. As in the original, your camera is a local tile
  they see through your screen share, and a chosen mic is applied by moving
  Tuple's recording stream (`bin/tuple-mic-route`).
- **Decline:** Tuple has no decline command, so Decline runs `call leave`.

## Develop

```bash
node --test tests/*.test.mjs               # model.js: parsers + log reducer
gjs -m tests/live.js status|watch|on|off|contacts   # service.js against the real daemon, no shell needed
gjs -m tests/lag.js [query|--idle 60]      # main-thread cost of a refresh, a search, or idling
gjs -m tests/shell-lag.js 150              # stalls in the running GNOME Shell
gjs -m tests/avatars.js                    # fetch your people's pictures into a throwaway cache
tests/headless.sh /tmp/shots [dark|light]  # a throwaway headless GNOME Shell: screenshots of every demo state
tests/headless.sh --clicks                 # …and real pointer clicks on its switches
```

The headless runs have their own D-Bus session, dconf, XDG directories and
runtime directory, so they don't touch your desktop.

Files in `tuple@ericflo/`:

- `model.js`: pure parsing and the state reducer; no GNOME APIs. Adapted
  from the original's `Model.js`.
- `service.js`: the daemon probe, state and log followers, and command
  runner. Gio/GLib only.
- `extension.js`: the indicator, menu, notifications, clipboard and D-Bus
  interface.
- `windows.js`: placement of Tuple's windows and the camera stage.
- `avatars.js`: profile pictures (Gravatar, async fetch and disk cache).
- `prefs.js`, `schemas/`: preferences.
- `bin/`:
  - `tuple-selfcam`: your camera tile
  - `tuple-cameras`: the webcam list
  - `tuple-mic-route`: mic routing
  - `tuple-perf`: call performance samples
  - `tuple-archive`: rolling copies of the daemon log in
    `~/.local/state/tuple-gnome/`
  - `tuple-shell`: the IPC client

## Credits

The original, [omarchy-tuple](https://github.com/benjaminsehl/omarchy-tuple),
is by Benjamin Sehl. Its reverse-engineering of the Linux client, the log
parser (`model.js`), the call-log fixtures in `tests/`, and the design rules
all carry over. This project isn't affiliated with Tuple.

MIT, like the original. See LICENSE.
