/* =========================================================
   NETHER — tracker.js
   Instagram-level user intelligence engine
   Every event → Firestore in real time
   ========================================================= */

import { db, auth } from "./firebase.js";
import {
  doc,
  setDoc,
  updateDoc,
  arrayUnion,
  increment,
  serverTimestamp,
  getDoc,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ── INTERNAL STATE ──────────────────────────────────────────
const _T = {
  uid: null,
  sessionId: null,
  sessionStart: null,
  currentTrack: null,
  trackStart: null,       // timestamp when current track started
  lastSeekPct: null,      // last known progress % before seek
  pauseStart: null,       // timestamp when paused
  totalPauseMs: 0,        // total paused time in current track
  searchBuffer: [],       // accumulate keystrokes before final pick
  scrollObserver: null,
  sectionVisibility: {},  // { sectionId: firstSeenTimestamp }
  sessionDepth: 0,        // how many tracks played this session
  hourlyBucket: null,     // e.g. "14" for 2pm
  dayBucket: null,        // e.g. "Mon"
  replayCount: 0,         // times current track rewound to near start
};

// ── HELPERS ─────────────────────────────────────────────────

function uid() {
  return _T.uid;
}

function nowMs() {
  return Date.now();
}

function hourBucket() {
  return String(new Date().getHours()); // "0"–"23"
}

function dayBucket() {
  return ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][new Date().getDay()];
}

function makeSessionId() {
  return `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// Safe Firestore write — never crashes the app
async function fsSet(path, data, merge = true) {
  if (!uid()) return;
  try {
    await setDoc(doc(db, path), data, { merge });
  } catch (e) {
    console.warn("[NETHER tracker] fsSet failed:", path, e.message);
  }
}

async function fsUpdate(path, data) {
  if (!uid()) return;
  try {
    await updateDoc(doc(db, path), data);
  } catch (e) {
    // doc may not exist yet — fall back to merge set
    await fsSet(path, data, true);
  }
}

// ── SESSION LIFECYCLE ───────────────────────────────────────

async function startSession() {
  if (!uid()) return;

  _T.sessionId    = makeSessionId();
  _T.sessionStart = nowMs();
  _T.sessionDepth = 0;
  _T.hourlyBucket = hourBucket();
  _T.dayBucket    = dayBucket();

  // Write session open doc
  await fsSet(`users/${uid()}/sessions/${_T.sessionId}`, {
    startedAt: serverTimestamp(),
    hour: _T.hourlyBucket,
    day: _T.dayBucket,
    tracksPlayed: 0,
    totalListenMs: 0,
    moods: [],
    searches: [],
    skips: 0,
    completes: 0,
    deviceWidth: window.innerWidth,
    referrer: document.referrer || "direct",
  });

  // Increment total session count on profile
  await fsUpdate(`users/${uid()}/profile/stats`, {
    totalSessions: increment(1),
    lastActiveAt: serverTimestamp(),
  });

  // Start scroll + session-depth tracking
  _attachScrollObserver();
  _attachSessionHeartbeat();

  console.log("[NETHER tracker] Session started:", _T.sessionId);
}

async function endSession() {
  if (!uid() || !_T.sessionId) return;
  const durationMs = nowMs() - _T.sessionStart;

  await fsUpdate(`users/${uid()}/sessions/${_T.sessionId}`, {
    endedAt: serverTimestamp(),
    durationMs,
    tracksPlayed: _T.sessionDepth,
  });

  await fsUpdate(`users/${uid()}/profile/stats`, {
    totalListenMs: increment(durationMs),
  });
}

// Heartbeat — writes every 30s so we can detect abandoned sessions
function _attachSessionHeartbeat() {
  setInterval(async () => {
    if (!_T.sessionId) return;
    await fsUpdate(`users/${uid()}/sessions/${_T.sessionId}`, {
      lastHeartbeat: serverTimestamp(),
      tracksPlayed: _T.sessionDepth,
    });
  }, 30_000);
}

// ── SCROLL / SECTION VISIBILITY ─────────────────────────────

function _attachScrollObserver() {
  if (!("IntersectionObserver" in window)) return;

  _T.scrollObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const sectionTitle =
          entry.target.querySelector(".section-title")?.textContent?.trim() ||
          entry.target.id ||
          "unknown";

        if (_T.sectionVisibility[sectionTitle]) return; // already logged
        _T.sectionVisibility[sectionTitle] = nowMs();

        _logEvent("section_view", { section: sectionTitle });
      });
    },
    { threshold: 0.4 }
  );

  document.querySelectorAll(".section").forEach((sec) => {
    _T.scrollObserver?.observe(sec);
  });
}

// ── CORE EVENT LOGGER ───────────────────────────────────────

async function _logEvent(type, payload = {}) {
  if (!uid()) return;

  const event = {
    type,
    ts: serverTimestamp(),
    hour: hourBucket(),
    day: dayBucket(),
    sessionId: _T.sessionId,
    ...payload,
  };

  // Write to users/{uid}/events subcollection
  const eventId = `${type}_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
  await fsSet(`users/${uid()}/events/${eventId}`, event, false);

  // Also push a lightweight summary to session doc
  if (_T.sessionId) {
    await fsUpdate(`users/${uid()}/sessions/${_T.sessionId}`, {
      lastEventAt: serverTimestamp(),
    });
  }
}

// ── PLAY ────────────────────────────────────────────────────

async function onPlay(payload) {
  const { title, artist } = payload;

  _T.trackStart    = nowMs();
  _T.pauseStart    = null;
  _T.totalPauseMs  = 0;
  _T.replayCount   = 0;
  _T.sessionDepth += 1;

  _T.currentTrack = { title, artist };

  await _logEvent("play", {
    title,
    artist,
    sessionDepth: _T.sessionDepth,
    hour: hourBucket(),
  });

  // Increment per-track play count
  const trackKey = _makeTrackKey(title, artist);
  await fsUpdate(`users/${uid()}/trackStats/${trackKey}`, {
    playCount: increment(1),
    lastPlayedAt: serverTimestamp(),
    title,
    artist,
  });

  // Increment per-artist affinity score (+1 raw play)
  const artistKey = _makeKey(artist);
  await fsUpdate(`users/${uid()}/artistAffinity/${artistKey}`, {
    rawPlays: increment(1),
    artist,
    lastPlayedAt: serverTimestamp(),
  });

  // Update session track count
  await fsUpdate(`users/${uid()}/sessions/${_T.sessionId}`, {
    tracksPlayed: increment(1),
    [`trackIds.${trackKey}`]: true,
  });

  // Recently played (array capped in Firestore update)
  await fsUpdate(`users/${uid()}/profile/recentlyPlayed`, {
    tracks: arrayUnion({ title, artist, playedAt: new Date().toISOString() }),
  });
}

// ── PAUSE ───────────────────────────────────────────────────

async function onPause() {
  _T.pauseStart = nowMs();

  const secondsPlayed = _T.trackStart
    ? Math.floor((nowMs() - _T.trackStart - _T.totalPauseMs) / 1000)
    : 0;

  await _logEvent("pause", {
    title: _T.currentTrack?.title,
    artist: _T.currentTrack?.artist,
    secondsPlayed,
  });
}

// ── RESUME ──────────────────────────────────────────────────

async function onResume() {
  if (_T.pauseStart) {
    _T.totalPauseMs += nowMs() - _T.pauseStart;
    _T.pauseStart = null;
  }

  await _logEvent("resume", {
    title: _T.currentTrack?.title,
    pauseDurationMs: _T.totalPauseMs,
  });
}

// ── COMPLETE ────────────────────────────────────────────────

async function onComplete(payload) {
  const { title } = payload;
  const listenMs = _T.trackStart
    ? nowMs() - _T.trackStart - _T.totalPauseMs
    : 0;

  await _logEvent("complete", {
    title,
    artist: _T.currentTrack?.artist,
    listenMs,
    replayCount: _T.replayCount,
  });

  // High-value signal: full completion → strong affinity boost
  const artistKey = _makeKey(_T.currentTrack?.artist || "");
  const trackKey  = _makeTrackKey(title, _T.currentTrack?.artist || "");

  await fsUpdate(`users/${uid()}/artistAffinity/${artistKey}`, {
    completes: increment(1),
    totalListenMs: increment(listenMs),
  });

  await fsUpdate(`users/${uid()}/trackStats/${trackKey}`, {
    completes: increment(1),
    totalListenMs: increment(listenMs),
  });

  await fsUpdate(`users/${uid()}/sessions/${_T.sessionId}`, {
    completes: increment(1),
    totalListenMs: increment(listenMs),
  });

  // Update Taste DNA with completion signal
  await _updateTasteDNA("complete", { artist: _T.currentTrack?.artist, listenMs });
}

// ── SKIP ────────────────────────────────────────────────────

async function onSkip(payload) {
  const { dir } = payload;

  const secondsPlayed = _T.trackStart
    ? Math.floor((nowMs() - _T.trackStart - _T.totalPauseMs) / 1000)
    : 0;

  // Skip velocity: how quickly they bailed
  const skipVelocity = secondsPlayed < 5 ? "instant" :
                       secondsPlayed < 15 ? "quick" :
                       secondsPlayed < 30 ? "mid" : "late";

  await _logEvent("skip", {
    title: _T.currentTrack?.title,
    artist: _T.currentTrack?.artist,
    dir,
    secondsPlayed,
    skipVelocity,
  });

  // Instant skip is a strong negative signal
  if (skipVelocity === "instant") {
    const artistKey = _makeKey(_T.currentTrack?.artist || "");
    await fsUpdate(`users/${uid()}/artistAffinity/${artistKey}`, {
      instantSkips: increment(1),
    });
  }

  const trackKey = _makeTrackKey(
    _T.currentTrack?.title || "",
    _T.currentTrack?.artist || ""
  );
  await fsUpdate(`users/${uid()}/trackStats/${trackKey}`, {
    skips: increment(1),
    lastSkipAt: secondsPlayed,
  });

  await fsUpdate(`users/${uid()}/sessions/${_T.sessionId}`, {
    skips: increment(1),
  });
}

// ── SEEK ────────────────────────────────────────────────────

async function onSeek(payload) {
  const { pct } = payload;
  const prevPct = _T.lastSeekPct ?? 0;
  _T.lastSeekPct = Number(pct);

  // Replay = seeked back to near start
  if (Number(pct) < 5 && prevPct > 50) {
    _T.replayCount += 1;
    await _logEvent("replay", {
      title: _T.currentTrack?.title,
      fromPct: prevPct,
      replayCount: _T.replayCount,
    });
    // Replay is a love signal → boost affinity
    const artistKey = _makeKey(_T.currentTrack?.artist || "");
    await fsUpdate(`users/${uid()}/artistAffinity/${artistKey}`, {
      replays: increment(1),
    });
    return;
  }

  // Forward seek = skipping a section
  // Backward seek = rewinding to rehear something
  const seekType = Number(pct) > prevPct ? "forward" : "rewind";

  await _logEvent("seek", {
    title: _T.currentTrack?.title,
    fromPct: prevPct,
    toPct: Number(pct),
    seekType,
  });
}

// ── MOOD PICK ───────────────────────────────────────────────

async function onMoodPick(payload) {
  const { mood } = payload;

  await _logEvent("mood_pick", {
    mood,
    hour: hourBucket(),
    day: dayBucket(),
  });

  // Mood × time of day matrix — the Instagram-level signal
  const hourKey = `h${hourBucket()}`;
  await fsUpdate(`users/${uid()}/moodMatrix/${mood}`, {
    total: increment(1),
    [hourKey]: increment(1),
    lastPickedAt: serverTimestamp(),
  });

  await fsUpdate(`users/${uid()}/sessions/${_T.sessionId}`, {
    moods: arrayUnion(mood),
  });

  await _updateTasteDNA("mood", { mood, hour: hourBucket() });
}

// ── SEARCH ──────────────────────────────────────────────────

async function onSearchType(payload) {
  // Buffer keystrokes — we only write when they stop typing
  _T.searchBuffer.push(payload.q);
}

async function onSearchPick(payload) {
  const { title, artist } = payload;
  const query = _T.searchBuffer[_T.searchBuffer.length - 1] || "";
  _T.searchBuffer = [];

  await _logEvent("search_pick", {
    query,
    chosenTitle: title,
    chosenArtist: artist,
    queryLength: query.length,
  });

  await fsUpdate(`users/${uid()}/sessions/${_T.sessionId}`, {
    searches: arrayUnion(query),
  });

  // Log search intent → chosen track mapping
  if (query) {
    const searchKey = `${_makeKey(query)}_${Date.now()}`;
    await fsSet(`users/${uid()}/searchHistory/${searchKey}`, {
      query,
      chosenTitle: title,
      chosenArtist: artist,
      ts: serverTimestamp(),
    }, false);
  }
}

// ── TASTE DNA ENGINE ────────────────────────────────────────
// Living profile — updates on every meaningful signal

async function _updateTasteDNA(signalType, data = {}) {
  if (!uid()) return;

  const dnaRef = `users/${uid()}/profile/tasteDNA`;

  if (signalType === "complete" && data.artist) {
    const artistKey = _makeKey(data.artist);
    await fsUpdate(dnaRef, {
      [`topArtists.${artistKey}.completes`]: increment(1),
      [`topArtists.${artistKey}.totalListenMs`]: increment(data.listenMs || 0),
      [`topArtists.${artistKey}.artist`]: data.artist,
      updatedAt: serverTimestamp(),
    });
  }

  if (signalType === "mood" && data.mood) {
    await fsUpdate(dnaRef, {
      [`moodFreq.${data.mood}`]: increment(1),
      [`hourlyMood.h${data.hour}.${data.mood}`]: increment(1),
      updatedAt: serverTimestamp(),
    });
  }
}

// ── SECTION VIEW ────────────────────────────────────────────
// Already handled by scroll observer → _logEvent("section_view", ...)

// ── INIT — called by app.js after auth ──────────────────────

async function _init(user) {
  _T.uid = user.uid;

  // Ensure profile doc exists
  await fsSet(`users/${uid()}/profile/meta`, {
    displayName: user.displayName || "Anonymous",
    email: user.email || "",
    photoURL: user.photoURL || "",
    createdAt: serverTimestamp(),
    appVersion: "2.0",
  });

  await startSession();
}

// ── PUBLIC API ──────────────────────────────────────────────

export function track(eventType, payload = {}) {
  switch (eventType) {
    case "play":          onPlay(payload);          break;
    case "pause":         onPause();                break;
    case "resume":        onResume();               break;
    case "complete":      onComplete(payload);      break;
    case "skip":          onSkip(payload);          break;
    case "seek":          onSeek(payload);          break;
    case "mood_pick":     onMoodPick(payload);      break;
    case "search_type":   onSearchType(payload);    break;
    case "search_pick":   onSearchPick(payload);    break;
    case "section_view":  _logEvent("section_view", payload); break;
    default:              _logEvent(eventType, payload);      break;
  }
}

// ── WIRE INTO app.js ─────────────────────────────────────────
// app.js checks: window.netherTrack?.('event', payload)
// and:           window._netherStartSession?.()

window._netherTrackFn = track;

window._netherStartSession = async () => {
  const user = auth.currentUser;
  if (user) await _init(user);
};

// End session on tab close
window.addEventListener("beforeunload", endSession);

// ── KEY HELPERS ─────────────────────────────────────────────

function _makeKey(str) {
  return (str || "unknown")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "_")
    .slice(0, 60);
}

function _makeTrackKey(title, artist) {
  return `${_makeKey(title)}__${_makeKey(artist)}`;
}
