# Sending your webcam

Short version: **Tuple for Linux can't send your webcam yet, and nothing
outside Tuple's binary can make it.** This document records exactly why, what
the one working channel is today, and how we're staged so the day Tuple adds
it, turning it on is trivial.

## What's in the binary (v2026_10_23.0)

The `tuple` binary is a single statically-linked Go+C++ executable. From its
strings and a real call's daemon log:

- `WebcamVideoTrackSource.cpp` — the WebRTC **track source** is compiled in.
  The machinery that would carry a webcam track to the other side exists; it's
  shared with the macOS/Windows clients.
- `SetWebcamCapturerAdapter` — the engine takes a per-platform **capture
  adapter**. On macOS it's real. On Linux it's three stubs:
  - `WebcamCapturerAdapter: TODO: implement Start`
  - `WebcamCapturerAdapter: TODO: implement Stop`
  - `WebcamCapturerAdapter: TODO: implement OnOutputChanged`

  There is no code that grabs camera frames.
- `rejecting ShareWebcamRequest (not supported)` — a second guard. Even if the
  adapter worked, the daemon refuses the request before it reaches the pipeline.

So there are two blockers, both **inside the closed binary**:

1. the Linux capture adapter isn't implemented, and
2. the share request is rejected.

## Why we can't do it from outside

The only way to put a *second, independent* video track on the call (a real
webcam tile on the other person's screen, separate from any screen share) is
for Tuple's own process to add it to its mediasoup producer. We can't:

- `SetWebcamCapturerAdapter` is an internal C++ call, not exposed on the
  socket, the CLI, or MCP (checked: no webcam/camera command or tool).
- The mediasoup transport lives inside the binary; we can't add a track to it.
- There is no feature flag for it — this account's flags are all receive/quality
  side (`webcams_playout_delay` is playout buffering, not sending).
- A flag or a preloaded library can't add code that isn't compiled in, and
  patching a static binary to force a rejected request through to a stub that
  does nothing is neither workable nor the right tool.

This is an **architectural ceiling, not a lock**: the feature genuinely isn't
built on Linux. It's an alpha; it's reasonable to expect Tuple to fill it in.

## The one channel that works today

The only outbound video track Tuple exposes is the **screen share**. So the
only way the other person sees your camera today is *inside* your shared
screen. That's what the self-view tile does (`bin/tuple-selfcam`): an mpv
window on your screen, which they see while you share. It occupies the
screen-share channel — one track, not two — and it's on your screen, not a
separate webcam tile for them. That's the honest limit, and it's as good as
it gets until Tuple implements sending.

## How we're staged for the day it works

`bin/tuple-virtualcam` + v4l2loopback present **one stable, well-labelled
capture device**, "Tuple Camera" (a fixed `/dev/video` node), carrying your
real camera — un-mirrored, at webcam resolution. Today, other apps (browsers,
OBS) can use it. The day Tuple ships camera capture *and* device selection,
you point Tuple at "Tuple Camera" and you're live, already framed.

One-time setup (root):

```bash
sudo modprobe v4l2loopback video_nr=42 card_label="Tuple Camera" exclusive_caps=1
echo 'options v4l2loopback video_nr=42 card_label="Tuple Camera" exclusive_caps=1' | sudo tee /etc/modprobe.d/tuple-camera.conf
echo v4l2loopback | sudo tee /etc/modules-load.d/tuple-camera.conf
```

Then, while you want the virtual camera live:

```bash
tuple-virtualcam        # films the first real camera into "Tuple Camera"
```

`bin/tuple-cameras` deliberately omits the "Tuple Camera" node, so the
self-view picker only offers real cameras and nothing feeds back into itself.

## The exact signal for "now it's possible"

Watch the daemon log (`~/.local/share/tuple/0/log.txt`) during a call where
you try to turn your webcam on. Sending has arrived when **either**:

- `rejecting ShareWebcamRequest (not supported)` stops appearing (the reject
  guard is gone), **or**
- a `user_webcam_started` line names **your own** user id (not just a peer's),

and `WebcamCapturerAdapter: TODO: implement Start` no longer precedes it. At
that point the capture adapter is real. Wiring it up in the extension is then
a small change:

1. add a real "Share webcam" control (distinct from the share-embedded tile),
2. let it pick a device — default "Tuple Camera" (or a real camera directly),
3. drive whatever command/flag Tuple exposes to start the webcam track.

Until one of those two signals shows up, that control stays absent on purpose —
no dead UI for a capability the client doesn't have.

## If you want it sooner

This is a resourcing gap on Tuple's side, not a protocol limit. The fastest
real unblock is telling them: the track source is already there, only the
Linux capture adapter and the reject guard are missing. Their Linux Slack
channel (tuple.app/linux/slack) is where that gets prioritised.
