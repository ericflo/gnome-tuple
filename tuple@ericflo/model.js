// Pure parsing + state helpers for the Tuple Linux client.
//
// Adapted from Model.js in benjaminsehl/omarchy-tuple (MIT), which was
// written against the v2026_09_16.1 client. Tuple has since replaced the
// Linux command set with its cross-platform CLI (v2026_10_23.0 here):
//
//   * `tuple state --format json` prints a bounded summary (in a call? who's
//     in it, mute, who you are, connection health), and `tuple state follow`
//     streams one summary per line whenever it changes. That's the main feed.
//   * `tuple contacts list --format json`, `tuple call start|join|leave|
//     accept|mute|unmute`, and `tuple start|stop` replace ls/call/join/end/
//     mute/on/off. `new`, `share`, `unshare`, `ui`, `settings` and `set` still
//     work but are deprecated.
//   * The daemon now listens on $XDG_RUNTIME_DIR/tuple-0, and still starts
//     itself for almost any command, so the UI must never run one "just to
//     look" while it's off.
//   * The daemon log (~/.local/share/tuple/0/log.txt, truncated on every
//     start, `HH:MM:SS.mmm|pid|tid|level|message`, UTC) keeps the same
//     format. The summary has no ringing call, screen share or webcam, so
//     reduceLog() below still folds the log for those.
//
// Keep this file free of GNOME Shell APIs so it can be unit tested with
// plain node (see tests/model.test.mjs).

var CALL_URL_PREFIXES = ["https://tuple.app/c/", "https://production.tuple.app/c/"]

// ── Command replies ──────────────────────────────────────────────────────

var ERROR_PATTERNS = [
  /^error:/i,
  /^can't /i,
  /^cannot /i,
  /^not logged in/i,
  /^not signed in/i,
  /^already (logged out|not in a call)/i,
  /failed$/i,
  /^denied$/i,
  /^unknown token/i,
  /^usage:/i,
  /^\{"error"/
]

function lines(text) {
  return String(text || "").split(/\r?\n/)
}

function nonEmptyLines(text) {
  return lines(text).map(function(l) { return l.replace(/\s+$/, "") }).filter(function(l) { return l.trim() !== "" })
}

function isErrorLine(line) {
  var t = String(line || "").trim()
  for (var i = 0; i < ERROR_PATTERNS.length; i++) if (ERROR_PATTERNS[i].test(t)) return true
  return false
}

// `--format json` errors are `{"error": "...", "error_code": 401, "kind": "unauthorized"}`.
function jsonError(text) {
  var all = nonEmptyLines(text)
  for (var i = 0; i < all.length; i++) {
    var t = all[i].trim()
    if (t.charAt(0) !== "{") continue
    try {
      var j = JSON.parse(t)
      if (j && typeof j.error === "string") return { message: j.error, code: j.error_code || 0, kind: j.kind || "" }
    } catch (e) {}
  }
  return null
}

// Daemon log lines leak into some replies ("18:30:25.524|129749|…|info|msg");
// show just the message.
function cleanLine(line) {
  var entry = parseLogLine(line)
  return entry ? entry.msg : String(line || "").trim()
}

// Summarize a finished command: { ok, message, lines }.
// `message` is the most useful single line to surface in the panel.
function parseReply(text, exitCode) {
  var all = nonEmptyLines(text).map(cleanLine).filter(function(l) { return l !== "" })
  var errorLine = ""
  var je = jsonError(text)
  if (je) errorLine = je.message.charAt(0).toUpperCase() + je.message.slice(1)
  for (var i = 0; i < all.length && errorLine === ""; i++) if (isErrorLine(all[i])) errorLine = all[i].trim().replace(/^error:\s*/i, "")
  var last = all.length > 0 ? all[all.length - 1].trim() : ""
  var failed = errorLine !== "" || (typeof exitCode === "number" && exitCode !== 0)
  return { ok: !failed, message: errorLine || last, lines: all, exitCode: typeof exitCode === "number" ? exitCode : 0 }
}

function firstUrl(text) {
  var m = String(text || "").match(/https?:\/\/[^\s"'<>]+/)
  return m ? m[0] : ""
}

// `tuple new` prints "personal url: https://tuple.app/c/<slug>".
function parsePersonalUrl(text) {
  var m = String(text || "").match(/personal url:\s*(\S+)/i)
  return m ? m[1] : ""
}

// `tuple login` prints a https://production.tuple.app/start?... URL.
function parseLoginUrl(text) {
  var m = String(text || "").match(/https?:\/\/\S*tuple\.app\/start\?\S+/)
  return m ? m[0] : firstUrl(text)
}

function isCallUrl(value) {
  var s = String(value || "").trim()
  for (var i = 0; i < CALL_URL_PREFIXES.length; i++) {
    var p = CALL_URL_PREFIXES[i]
    if (s.indexOf(p) === 0 && s.length > p.length && !/\s/.test(s)) return true
  }
  return false
}

// Pull a call URL out of arbitrary pasted text (e.g. a Slack message).
function extractCallUrl(value) {
  var m = String(value || "").match(/https:\/\/(?:production\.)?tuple\.app\/c\/[^\s"'<>)\]]+/)
  return m ? m[0] : ""
}

// ── State summary ────────────────────────────────────────────────────────

// One `tuple state --format json` / `tuple state follow --format json` line.
// Shape (the `get_state` output schema of `tuple mcp`):
//   { in_call, call: null | { call_id, muted, transcribing, active_room_slug,
//       participants: [{ id, name, email, session_id, muted, connection_state }] },
//     user: { id, email, short_name }, contacts: { total, online, busy,
//     favorites: { total, online, online_names } }, rooms, invites,
//     connection: { websocket_state, is_internet_connected }, platform,
//     app_version, available_update_version }
// Returns null for anything that isn't a summary (errors, blank lines).
function parseSummary(text) {
  var j = text
  if (typeof text === "string") {
    try { j = JSON.parse(text) } catch (e) { return null }
  }
  if (!j || typeof j !== "object" || !("in_call" in j)) return null
  var user = j.user || {}
  var call = j.call || null
  var conn = j.connection || {}
  var contacts = j.contacts || {}
  var favorites = contacts.favorites || {}
  var userId = user.id ? String(user.id) : ""
  var participants = []
  var list = (call && call.participants) || []
  for (var i = 0; i < list.length; i++) {
    var p = list[i] || {}
    var id = p.id !== undefined && p.id !== null ? String(p.id) : ""
    if (userId !== "" && id === userId) continue      // yourself
    participants.push({
      id: id,
      name: String(p.name || p.email || "Someone"),
      email: String(p.email || ""),
      muted: p.muted === true,
      connectionState: String(p.connection_state || "")
    })
  }
  return {
    signedIn: userId !== "" || String(user.email || "") !== "",
    userId: userId,
    email: String(user.email || ""),
    shortName: String(user.short_name || ""),
    inCall: j.in_call === true || call !== null,
    callId: call ? String(call.call_id || "") : "",
    muted: !!(call && call.muted === true),
    room: call ? String(call.active_room_slug || "") : "",
    participants: participants,
    websocket: String(conn.websocket_state || ""),
    internet: conn.is_internet_connected !== false,
    version: String(j.app_version || ""),
    update: String(j.available_update_version || ""),
    counts: {
      total: contacts.total || 0,
      online: contacts.online || 0,
      busy: contacts.busy || 0,
      favorites: favorites.total || 0,
      onlineFavorites: favorites.online || 0
    }
  }
}

// ── Contacts ─────────────────────────────────────────────────────────────

// `tuple contacts list --format json`: { contacts: [{ id, email, full_name,
// short_name, kind, favorited, recent, status, call }] } (or a bare array).
// Returns null when the text isn't a contact list (e.g. a JSON error).
function parseContactsJson(text) {
  var j
  try { j = typeof text === "string" ? JSON.parse(text) : text } catch (e) { return null }
  var list = Array.isArray(j) ? j : (j && Array.isArray(j.contacts) ? j.contacts : (j && j.contacts === null ? [] : null))
  if (!list) return null
  var out = []
  for (var i = 0; i < list.length; i++) {
    var c = list[i] || {}
    if (c.id === undefined || c.id === null) continue
    var status = String(c.status || "").trim()
    var email = String(c.email || "").trim()
    out.push({
      id: String(c.id),
      name: String(c.full_name || c.short_name || email).trim() || email,
      email: email,
      status: status,
      online: isOnlineStatus(status),
      inCall: !!c.call,
      favorite: c.favorited === true,
      recent: c.recent === true,
      kind: String(c.kind || "")
    })
  }
  return sortContacts(out)
}

// Reachable people first, then favorites, then alphabetical.
function sortContacts(list) {
  return list.sort(function(a, b) {
    if (a.online !== b.online) return a.online ? -1 : 1
    if (a.favorite !== b.favorite) return a.favorite ? -1 : 1
    var an = a.name.toLowerCase(), bn = b.name.toLowerCase()
    return an < bn ? -1 : (an > bn ? 1 : 0)
  })
}

// Words only when they add information beyond the presence dot. Tuple only
// knows presence for some of a directory (favourites, mostly); the rest is
// "unknown", which says nothing worth printing on every row.
function presenceLabel(status) {
  var s = String(status || "").trim().toLowerCase()
  if (s === "" || s === "available" || s === "online" || s === "unknown") return ""
  if (s === "in call") return "In a call"
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function contactPresence(contact) {
  if (!contact) return ""
  if (contact.inCall) return "In a call"
  return presenceLabel(contact.status)
}

// Reachable: online, or busy (in a call). Everything else — offline, and the
// "unknown" most of a directory reports — isn't.
function isOnlineStatus(status) {
  return /^(online|available|busy|in call)$/.test(String(status || "").trim().toLowerCase())
}

// Org directories are big (thousands of rows), so the panel never renders the
// full list: by default it shows favorites, then people you've called
// recently, then anyone else available; a search box covers everyone else.
function featuredContacts(contacts, limit) {
  var max = limit || 30
  var tiers = [[], [], []]
  for (var i = 0; i < contacts.length; i++) {
    var c = contacts[i]
    if (c.favorite) tiers[0].push(c)
    else if (c.recent) tiers[1].push(c)
    else if (c.online) tiers[2].push(c)
  }
  return tiers[0].concat(tiers[1], tiers[2]).slice(0, max)
}

function searchContacts(contacts, query, limit) {
  var q = String(query || "").trim().toLowerCase()
  if (q === "") return featuredContacts(contacts, limit)
  var max = limit || 30
  var starts = []
  var contains = []
  for (var i = 0; i < contacts.length; i++) {
    var c = contacts[i]
    var name = c.name.toLowerCase()
    var email = c.email.toLowerCase()
    if (name.indexOf(q) === 0 || email.indexOf(q) === 0 || name.indexOf(" " + q) !== -1) starts.push(c)
    else if (name.indexOf(q) !== -1 || email.indexOf(q) !== -1) contains.push(c)
    if (starts.length >= max) break
  }
  return starts.concat(contains).slice(0, max)
}

// Tuple's own search results (`contacts list -q`), best first: names and
// emails that start with the query, then ones that contain it, then whatever
// else Tuple matched. Within each, Tuple's order (favourites, presence, name).
function rankContacts(contacts, query, limit) {
  var q = String(query || "").trim().toLowerCase()
  var score = function(c) {
    var name = c.name.toLowerCase(), email = c.email.toLowerCase()
    if (name.indexOf(q) === 0 || email.indexOf(q) === 0 || name.indexOf(" " + q) !== -1) return 0
    if (name.indexOf(q) !== -1 || email.indexOf(q) !== -1) return 1
    return 2
  }
  return contacts.map(function(c, i) { return [score(c), i, c] })
    .sort(function(a, b) { return a[0] - b[0] || a[1] - b[1] })
    .slice(0, limit || 30)
    .map(function(x) { return x[2] })
}

function contactCounts(contacts) {
  var favorites = 0, online = 0, onlineFavorites = 0
  for (var i = 0; i < contacts.length; i++) {
    var c = contacts[i]
    if (c.favorite) favorites++
    if (c.online) online++
    if (c.favorite && c.online) onlineFavorites++
  }
  return { total: contacts.length, favorites: favorites, online: online, onlineFavorites: onlineFavorites }
}

function initials(name) {
  var parts = String(name || "").trim().split(/[\s@._-]+/).filter(function(p) { return p !== "" })
  if (parts.length === 0) return "?"
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

// ── Settings ─────────────────────────────────────────────────────────────

// `tuple settings` rows: "name | value | Description (a|b|c)"
function parseSettings(text) {
  var out = []
  var all = nonEmptyLines(text)
  for (var i = 0; i < all.length; i++) {
    var parts = all[i].split(" | ")
    if (parts.length < 3) continue
    var name = parts[0].trim()
    if (!/^[a-z0-9][a-z0-9-]*$/i.test(name)) continue
    var value = parts[1].trim()
    var description = parts.slice(2).join(" | ").trim()
    var choices = []
    var cm = description.match(/\(([^()]*\|[^()]*)\)\s*$/)
    if (cm) {
      choices = cm[1].split("|").map(function(c) { return c.trim() }).filter(function(c) { return c !== "" })
      description = description.slice(0, cm.index).trim()
    }
    var type = "text"
    if (choices.length === 2 && choices.indexOf("0") !== -1 && choices.indexOf("1") !== -1) type = "bool"
    else if (choices.length > 0) type = "choice"
    out.push({ name: name, value: value, description: description, choices: choices, type: type })
  }
  return out
}

function settingLabel(name) {
  var s = String(name || "").replace(/-/g, " ")
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function nextChoice(setting) {
  if (!setting || !setting.choices || setting.choices.length === 0) return ""
  var i = setting.choices.indexOf(setting.value)
  return setting.choices[(i + 1) % setting.choices.length]
}

// ── Daemon log → state ───────────────────────────────────────────────────

function emptyState() {
  return {
    pid: "",
    version: "",
    tokenSaved: false,
    signaler: "",
    loggedOut: false,
    exited: false,
    call: "idle",          // idle | connecting | incoming | active | ending
    incomingFrom: "",
    incomingAt: "",        // log time of the latest `received incoming call`
    peers: [],             // display names (legacy "peer joined call: X") or contact ids
    sharing: false,
    peerSharing: "",
    peerWebcam: false,
    endingAt: -1,          // log time (s) of `cli: end`; "ending" resolves 3s later
    outgoing: false,       // `cli: call` is ringing someone; peers are callees until it connects
    unanswered: "",        // contact id of the last outgoing call that timed out
    windows: [],           // Tuple windows currently mapped: webcam, screen, join_request, …
    joinRequest: false,    // someone is asking to join your call
    everyoneLeft: false,   // a link call outlived its last peer (Tuple's "hang up?" moment)
    joined: "",            // "<peer>@<time>" of the latest participant-joined event
    lastEvent: "",
    lastEventAt: ""
  }
}

function cloneState(s) {
  return {
    pid: s.pid, version: s.version, tokenSaved: s.tokenSaved, signaler: s.signaler,
    loggedOut: s.loggedOut, exited: s.exited, call: s.call, incomingFrom: s.incomingFrom,
    incomingAt: s.incomingAt,
    peers: s.peers.slice(), sharing: s.sharing, peerSharing: s.peerSharing,
    peerWebcam: s.peerWebcam, endingAt: s.endingAt,
    outgoing: s.outgoing, unanswered: s.unanswered,
    windows: s.windows.slice(), joinRequest: s.joinRequest,
    everyoneLeft: s.everyoneLeft, joined: s.joined,
    lastEvent: s.lastEvent, lastEventAt: s.lastEventAt
  }
}

// "17:06:02.861|2340919|2340923|info|Signaler.cpp:366|bound signaler ..."
function parseLogLine(line) {
  var raw = String(line || "")
  var parts = raw.split("|")
  if (parts.length < 5 || !/^\d\d:\d\d:\d\d/.test(parts[0])) return null
  var msg = parts.slice(4).join("|")
  // Strip the optional "File.cpp:123|" source prefix.
  msg = msg.replace(/^[A-Za-z0-9_]+\.(?:cpp|cc|c|h|hpp|zig|mm):\d+\|/, "")
  return { time: parts[0], pid: parts[1], tid: parts[2], level: parts[3], msg: msg.trim() }
}

function addUnique(list, value) {
  var v = String(value || "").trim()
  if (v === "" || list.indexOf(v) !== -1) return list
  var next = list.slice(); next.push(v); return next
}

function removeValue(list, value) {
  var v = String(value || "").trim()
  return list.filter(function(x) { return x !== v })
}

function endCall(s) {
  s.call = "idle"; s.incomingFrom = ""; s.peers = []; s.sharing = false; s.peerSharing = ""
  s.peerWebcam = false; s.endingAt = -1; s.outgoing = false; s.everyoneLeft = false
}

// An outgoing call has been answered.
function connectOutgoing(s) {
  s.call = "active"; s.outgoing = false; s.unanswered = ""
}

// "HH:MM:SS.mmm" → seconds since midnight.
function logSeconds(time) {
  var m = String(time || "").match(/^(\d\d):(\d\d):(\d\d)(?:\.(\d+))?/)
  if (!m) return -1
  return parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10) + (m[4] ? parseFloat("0." + m[4]) : 0)
}

function secondsSince(from, time) {
  var now = logSeconds(time)
  if (from < 0 || now < 0) return 0
  var d = now - from
  return d < 0 ? d + 86400 : d
}

// Seconds after `cli: end` with no "call ended" before we call it ended.
// The daemon's own end is synchronous; this only covers ends issued by
// other clients and log replays (which never see the command's reply).
var ENDING_GRACE = 3

function isSignalerOnline(state) {
  return /^(connected|ready|online|authenticated)/i.test(String(state || ""))
}

// Fold one parsed log entry into the state. Returns a new object when
// something changed and the same object otherwise.
function reduceLog(state, entry) {
  if (!entry) return state
  var s = cloneState(state || emptyState())
  var msg = entry.msg
  var m

  if (s.pid !== "" && entry.pid !== s.pid && /^version v/.test(msg)) {
    s = emptyState()
  }
  if (s.pid === "") s.pid = entry.pid

  var resolved = false
  if (s.call === "ending" && secondsSince(s.endingAt, entry.time) > ENDING_GRACE) { endCall(s); resolved = true }

  if (/^cli: call\b/.test(msg)) {
    // `tuple call` rings a favourite. The engine adds them as a peer right
    // away (before they answer), so stay "connecting" until the call does.
    if (s.call !== "idle") return resolved ? finishEntry(s, entry) : state
    s.call = "connecting"; s.outgoing = true; s.unanswered = ""; s.peers = []
  } else if ((m = msg.match(/^EngineEvent: OnPeerAdded \(peer (\S+)/))) {
    if (s.outgoing && s.call === "connecting") {
      if (!resolved && s.peers.indexOf(m[1]) !== -1) return state
      s.peers = addUnique(s.peers, m[1])
      return finishEntry(s, entry)
    }
    // Logged many times per peer; don't churn state for repeats.
    if (!resolved && s.call === "active" && s.peers.indexOf(m[1]) !== -1) return state
    s.call = "active"; s.incomingFrom = ""; s.endingAt = -1; s.peers = addUnique(s.peers, m[1])
    s.everyoneLeft = false
  } else if ((m = msg.match(/^EngineEvent: OnPeerRemoved \(peer (\S+)(.*)$/))) {
    if (s.outgoing && s.call === "connecting") {
      // Nobody picked up: the engine gives up after ~25s (reason=timeout).
      endCall(s); s.peers = []
      if (/reason=timeout/.test(m[2])) s.unanswered = m[1]
      return finishEntry(s, entry)
    }
    if (!resolved && s.peers.indexOf(m[1]) === -1) return state
    s.peers = removeValue(s.peers, m[1])
    if (s.peerSharing === m[1]) s.peerSharing = ""
  } else if ((m = msg.match(/^(map|unmap) window: (\S+)/))) {
    // Tuple's own windows. "screen" is *their* shared screen (yours is
    // OnVideoCapturerDesktop); "join_request" asks you to let someone in.
    var role = m[2]
    var mapped = m[1] === "map"
    if (!resolved && mapped === (s.windows.indexOf(role) !== -1)) return state
    s.windows = mapped ? addUnique(s.windows, role) : removeValue(s.windows, role)
    if (role === "screen") s.peerSharing = mapped ? (s.peers.length === 1 ? s.peers[0] : "peer") : ""
    if (role === "join_request") s.joinRequest = mapped
  } else if (/^posting join request/.test(msg)) {
    s.joinRequest = true
  } else if (/^posting participant joined notification/.test(msg)) {
    // Tuple's own toast for this is a TODO on Linux; the panel posts one.
    s.joined = (s.peers.length > 0 ? s.peers[s.peers.length - 1] : "") + "@" + entry.time
  } else if (/^TODO: implement HangUpEveryoneLeft notification/.test(msg)) {
    if (s.call !== "active" || s.peers.length > 0) return resolved ? finishEntry(s, entry) : state
    s.everyoneLeft = true
  } else if (/^TODO: implement dismiss HangUpEveryoneLeft/.test(msg)) {
    if (!s.everyoneLeft) return resolved ? finishEntry(s, entry) : state
    s.everyoneLeft = false
  } else if (/^invalidating call/.test(msg) || (/^sfu closed/.test(msg) && s.call === "ending")) {
    // Logged straight after `cli: end` (ours or another client's): the call
    // is over, no need to wait out the ending grace period.
    if (s.call === "idle") return resolved ? finishEntry(s, entry) : state
    endCall(s); s.peers = []
  } else if (/^sfu closed/.test(msg) && s.outgoing) {
    endCall(s); s.peers = []
  } else if ((/^ContextState: READY/.test(msg) || /^peer connection state changed: \S+ -> kConnected/.test(msg)) && s.outgoing) {
    connectOutgoing(s)
  } else if (/^OnVideoCapturerDesktop Start/.test(msg)) {
    if (!resolved && s.sharing) return state
    s.sharing = true
  } else if (/^OnVideoCapturerDesktop Stop/.test(msg)) {
    if (!resolved && !s.sharing) return state
    s.sharing = false
  } else if (/^(webcam: added feed|WebcamReceivingChange: add)/.test(msg)) {
    if (!resolved && s.peerWebcam) return state
    s.peerWebcam = true
  } else if (/^(webcam: removed feed, now 0|WebcamReceivingChange: remove)/.test(msg)) {
    if (!resolved && !s.peerWebcam) return state
    s.peerWebcam = false
  } else if ((m = msg.match(/^version (v\S+)/))) {
    s = emptyState(); s.pid = entry.pid; s.version = m[1]
  } else if ((m = msg.match(/^saved auth token: (\w+)/))) {
    s.tokenSaved = /^(yes|true|1)$/i.test(m[1])
  } else if ((m = msg.match(/^signaler state changed: (\S+) -> (\S+)/))) {
    s.signaler = m[2]
  } else if (/^logout initiated|^auth token deleted|^logged out/i.test(msg)) {
    s.tokenSaved = false; s.loggedOut = true; endCall(s)
  } else if (/^(login succeeded|logged in|saved auth token$|stored auth token)/i.test(msg)) {
    s.tokenSaved = true; s.loggedOut = false
  } else if ((m = msg.match(/^received incoming call: (.*)$/))) {
    if (s.call === "idle") s.call = "incoming"
    s.incomingFrom = m[1].trim()
    s.incomingAt = entry.time
  } else if (/^(denying incoming call|incoming call already rejected)/.test(msg)) {
    if (s.call === "incoming") s.call = "idle"
    s.incomingFrom = ""
  } else if ((m = msg.match(/^peer joined call: (.*)$/))) {
    s.call = "active"; s.incomingFrom = ""; s.peers = addUnique(s.peers, m[1])
  } else if ((m = msg.match(/^peer left call: (.*)$/))) {
    s.peers = removeValue(s.peers, m[1])
    if (s.peerSharing === m[1].trim()) s.peerSharing = ""
  } else if (/^local user started sharing screen/.test(msg)) {
    s.sharing = true
  } else if (/^local user stopped sharing screen/.test(msg)) {
    s.sharing = false
  } else if ((m = msg.match(/^peer started sharing screen: (.*)$/))) {
    s.peerSharing = m[1].trim() || "peer"
  } else if (/^peer stopped sharing screen/.test(msg)) {
    s.peerSharing = ""
  } else if (/^(call connected|answering call with)/.test(msg)) {
    connectOutgoing(s); s.incomingFrom = ""
  } else if (/^(joining call|call connecting|calling |starting new call|connecting)/i.test(msg)) {
    if (s.call === "idle") s.call = "connecting"
  } else if (/^cli: (end|call leave)\b/.test(msg)) {
    if (s.call === "idle" || s.call === "ending") return resolved ? finishEntry(s, entry) : state
    s.call = "ending"; s.endingAt = logSeconds(entry.time)
  } else if (/^(call ended|call failed|pending call cancelled|pending 'new' call cancelled|cancelled pending join call|call was asked to hang up remotely|call was resolved remotely|received reversed hang up message|current user is no longer authorized; resetting call state|exiting from 'off' command after call ended)/.test(msg)
      || /^ContextState: (TERMINATED|FAILED)/.test(msg)) {
    // ContextState is the per-call PulseAudio context: created as the call
    // connects, torn down when it ends.
    if (s.call === "idle" && !resolved) return state
    endCall(s)
  } else if (/^(exiting|disconnect \(GracefulShutdown\)|tuple is no longer running)/.test(msg)) {
    endCall(s); s.exited = true; s.signaler = ""
  } else {
    return resolved ? finishEntry(s, entry) : state
  }

  return finishEntry(s, entry)
}

function finishEntry(s, entry) {
  s.lastEvent = entry.msg
  s.lastEventAt = entry.time
  return s
}

// Wall-clock fallback for a live "ending" that the log never resolves.
function resolveEnding(state) {
  if (!state || state.call !== "ending") return state
  var s = cloneState(state); endCall(s); return s
}

// Wall-clock fallback for an outgoing ring the log never resolves (e.g. the
// `call` prompt was abandoned before anyone was dialled).
function resolveStaleOutgoing(state) {
  if (!state || !state.outgoing || state.call !== "connecting" || state.peers.length > 0) return state
  var s = cloneState(state); endCall(s); return s
}

// Wall-clock fallback for a ring that stopped without a log line we know
// (the caller gave up): Tuple stops ringing after ~25s.
function resolveStaleIncoming(state) {
  if (!state || state.call !== "incoming") return state
  var s = cloneState(state); s.call = "idle"; s.incomingFrom = ""; return s
}

// The summary says the call is over: drop whatever the log still holds about
// it (share, their screen and webcam, a pending join request).
function clearCall(state) {
  if (!state) return state
  var s = cloneState(state); endCall(s); s.joinRequest = false; s.windows = []; return s
}

function reduceLogText(text, state) {
  var s = state || emptyState()
  var all = lines(text)
  for (var i = 0; i < all.length; i++) s = reduceLog(s, parseLogLine(all[i]))
  return s
}

// The command reply is the most reliable signal for our own actions; fold it
// into the state too so the UI doesn't wait for (or depend on) log lines.
// `command` is the action's short name: share, unshare, end, logout, auth, off.
function reduceReply(state, command, reply) {
  var s = cloneState(state || emptyState())
  var text = reply.lines.join("\n")
  if (/not in a call|already not in a call/i.test(text)) endCall(s)
  if (!reply.ok) return s
  if (command === "share") s.sharing = true
  else if (command === "unshare") s.sharing = false
  else if (command === "end") endCall(s)
  else if (command === "logout") { s.tokenSaved = false; s.loggedOut = true; endCall(s) }
  else if (command === "auth") { s.tokenSaved = true; s.loggedOut = false }
  else if (command === "off") { endCall(s); s.exited = true; s.signaler = "" }
  if (/call connected/i.test(text)) s.call = "active"
  if (/call ended/i.test(text)) endCall(s)
  return s
}

// ── Combined view ────────────────────────────────────────────────────────

// The one call state the UI shows. The summary is authoritative for being in
// a call; the log adds a call ringing in; our own pending commands add
// "Calling…", "Connecting…" and "Ending…" (so a failed join can't leave the
// UI stuck on "Connecting…" the way a log line would).
//   summary: parseSummary() result or null; log: reduceLog() state;
//   pending: { calling, joining, ending } booleans
function callState(summary, log, pending) {
  var p = pending || {}
  var inCall = !!(summary && summary.inCall)
  if (p.ending && inCall) return "ending"
  if (p.calling) return "connecting"
  if (inCall) return "active"
  if (log && log.call === "incoming") return "incoming"
  if (p.joining) return "connecting"
  return "idle"
}

function statusLabel(st) {
  if (!st.daemon) return "Tuple is off"
  if (!st.loggedIn) return "Not logged in"
  if (st.call === "incoming") return st.incomingFrom !== "" ? st.incomingFrom + " is calling" : "Incoming call"
  if (st.call === "connecting") {
    if (st.outgoing && st.calling) return "Calling " + st.calling + "…"
    return st.outgoing ? "Calling…" : "Connecting…"
  }
  if (st.call === "ending") return "Ending call…"
  if (st.call === "active") {
    if (st.peers.length === 0) return "Waiting for someone to join"
    if (st.peers.length === 1) return "Pairing with " + st.peers[0]
    return "Pairing with " + st.peers.length + " people"
  }
  if (st.internet === false) return "No internet connection"
  if (st.websocket && !isSignalerOnline(st.websocket)) return "Connecting to Tuple…"
  return "Ready to pair"
}

// ── Cameras ──────────────────────────────────────────────────────────────

// bin/tuple-cameras prints one capture device per line, the same way
// Omarchy's `omarchy-capture-webcam-list` does:
//   "/dev/video0  Logitech BRIO (usb-0000:00:0d.0-3):"
// The name drops v4l2's bus suffix and its "Model: Model" repetition.
function parseCameras(text) {
  var out = []
  var all = nonEmptyLines(text)
  for (var i = 0; i < all.length; i++) {
    var m = all[i].match(/^(\/dev\/\S+)\s+(.*)$/)
    if (!m) continue
    var name = m[2].replace(/:\s*$/, "").replace(/\s*\([^()]*\)\s*$/, "").trim()
    var halves = name.match(/^(.+?):\s*(.+)$/)
    if (halves && halves[1].trim() === halves[2].trim()) name = halves[1].trim()
    out.push({ dev: m[1], name: name || m[1] })
  }
  return out
}

// The saved preference is a camera name (stable across reboots and replugs,
// unlike /dev/videoN) or, for older settings, a device path. Falls back to
// the first camera when the preferred one isn't plugged in.
function resolveCamera(cameras, preference) {
  var list = cameras || []
  var found = findCamera(list, preference)
  if (found) return found
  return list.length > 0 ? list[0] : null
}

function nextCamera(cameras, current) {
  var list = cameras || []
  if (list.length === 0) return null
  var dev = current ? current.dev : ""
  for (var i = 0; i < list.length; i++) if (list[i].dev === dev) return list[(i + 1) % list.length]
  return list[0]
}

function findCamera(cameras, preference) {
  var list = cameras || []
  var pref = String(preference || "").trim()
  if (pref === "") return null
  for (var i = 0; i < list.length; i++) if (list[i].dev === pref) return list[i]
  var lower = pref.toLowerCase()
  for (var j = 0; j < list.length; j++) if (list[j].name.toLowerCase() === lower) return list[j]
  return null
}

// ── Microphones ──────────────────────────────────────────────────────────

// `pactl -f json list sources` → real inputs only (no sink monitors).
function parseMics(json) {
  var all
  try { all = JSON.parse(String(json || "").trim() || "[]") } catch (e) { return [] }
  var out = []
  for (var i = 0; i < all.length; i++) {
    var src = all[i] || {}
    var props = src.properties || {}
    var name = String(src.name || "")
    if (name === "" || /\.monitor$/.test(name) || props["device.class"] === "monitor") continue
    var label = String(src.description || props["device.description"] || name)
      .replace(/\s+(Analog Stereo|Mono|Stereo|Multichannel Input)$/i, "")
    // The laptop's own array reports as the audio chipset ("Core Ultra … HD
    // Audio Microphones"); call it what it is.
    if (/^alsa_input\.pci-/.test(name) && /microphone/i.test(label)) label = "Built-in microphone"
    out.push({ name: name, label: label })
  }
  return out
}

function findMic(mics, name) {
  var list = mics || []
  var n = String(name || "")
  if (n === "") return null
  for (var i = 0; i < list.length; i++) if (list[i].name === n) return list[i]
  return null
}

export {
  CALL_URL_PREFIXES, ENDING_GRACE,
  lines, nonEmptyLines, isErrorLine, jsonError, parseReply, firstUrl, parsePersonalUrl, parseLoginUrl,
  isCallUrl, extractCallUrl,
  parseSummary, parseContactsJson, sortContacts, presenceLabel, contactPresence, isOnlineStatus,
  featuredContacts, searchContacts, rankContacts, contactCounts, initials,
  parseSettings, settingLabel, nextChoice,
  emptyState, cloneState, parseLogLine, logSeconds, secondsSince, isSignalerOnline,
  reduceLog, resolveEnding, resolveStaleOutgoing, resolveStaleIncoming, clearCall, reduceLogText, reduceReply,
  callState, statusLabel,
  parseCameras, resolveCamera, nextCamera, findCamera, parseMics, findMic
}
