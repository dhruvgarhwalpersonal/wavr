/* =========================================================
   WAVR — tracker.js
   Instagram-level event tracking. Every interaction → Firestore.

   FIRESTORE STRUCTURE (never exceeds 1 MB per document):
   --------------------------------------------------------
   users/{uid}/events/{YYYY-MM-DD_batch-N}
     events: [ ...up to EVENTS_PER_DOC event objects ]
     createdAt: timestamp
     updatedAt: timestamp

   One document holds EVENTS_PER_DOC events (~50).
   When it fills up we auto-create the next doc.
   A single event is ~200–400 bytes → 50 events ≈ 20 KB.
   Stays miles under the 1 MB Firestore cap even with
   generous metadata padding.

   EVENT TYPES tracked:
     play          — user started a track
     pause         — user paused
     resume        — user resumed
     skip          — user manually skipped
     seek          — user scrubbed the progress bar
     complete      — track played to end
     search_type   — user typed in search
     search_pick   — user chose a result
     mood_pick     — user tapped a mood card
     session_start — page loaded / became visible
     session_end   — page hidden / unloaded
   ========================================================= */

import { db }          from "./firebase.js";
import { currentUser } from "./auth.js";
import {
  doc,
  collection,
  addDoc,
  updateDoc,
  arrayUnion,
  serverTimestamp,
  getDoc,
  setDoc,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ── CONSTANTS ───────────────────────────────────────────────
const EVENTS_PER_DOC = 50;   // max events before new doc

// ── IN-MEMORY BATCH (flush to Firestore in one write) ──────
let eventBatch   = [];
const FLUSH_MS   = 10_000;   // flush every 10 s or on page hide

// ── ACTIVE DOC REFERENCE (set by resolveActiveDoc) ─────────
let activeDocRef = null;
let activeDocCount = 0;

// ── PUBLIC API ─────────────────────────────────────────────

/**
 * Call this before any track event. Enriches ctx automatically.
 * @param {string} type  — event type (see header)
 * @param {object} data  — arbitrary payload, kept small
 */
export function track(type, data = {}) {
  if (!currentUser) return;  // not signed in — no tracking

  const event = {
    t:    type,
    ts:   Date.now(),
    hr:   new Date().getHours(),            // hour of day (0–23)
    dow:  new Date().getDay(),              // day of week (0=Sun)
    ...sanitise(data),
  };

  eventBatch.push(event);

  // Flush immediately for high-signal events
  const IMMEDIATE = ["play", "complete", "skip", "mood_pick", "session_end"];
  if (IMMEDIATE.includes(type)) flush();
}

/**
 * Start session tracking (call once on init).
 */
export function startSession() {
  track("session_start", { ref: document.referrer || "direct" });

  // Flush on page hide / close
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      track("session_end", { dur: Math.round(performance.now() / 1000) });
      flush();
    }
  });

  // Safety flush every FLUSH_MS
  setInterval(flush, FLUSH_MS);
}

// ── FLUSH BATCH TO FIRESTORE ────────────────────────────────
async function flush() {
  if (!currentUser || eventBatch.length === 0) return;

  const toWrite = [...eventBatch];
  eventBatch    = [];

  try {
    await writeEvents(toWrite);
  } catch (err) {
    // Put them back — will retry next flush
    eventBatch = [...toWrite, ...eventBatch];
    console.warn("WAVR tracker: flush failed, will retry", err);
  }
}

// ── WRITE EVENTS → ROLLING FIRESTORE DOCS ──────────────────
//
// Strategy:
//   1. Find the current active doc for today
//   2. If it has room → arrayUnion the new events
//   3. If it's full   → create a new doc for today
//   4. New doc naming: YYYY-MM-DD_N  (N = 0, 1, 2, …)
//
async function writeEvents(events) {
  if (!activeDocRef || activeDocCount >= EVENTS_PER_DOC) {
    await resolveActiveDoc();
  }

  // Split events if they'd overflow the current doc
  while (events.length > 0) {
    const room      = EVENTS_PER_DOC - activeDocCount;
    const chunk     = events.splice(0, room);
    activeDocCount += chunk.length;

    await updateDoc(activeDocRef, {
      events:    arrayUnion(...chunk),
      updatedAt: serverTimestamp(),
    });

    if (events.length > 0) {
      // This doc is full → open next
      await resolveActiveDoc(true);
    }
  }
}

// ── RESOLVE ACTIVE DOC ─────────────────────────────────────
async function resolveActiveDoc(forceNew = false) {
  const uid     = currentUser.uid;
  const dateStr = todayStr();
  const colRef  = collection(db, "users", uid, "events");

  if (!forceNew && activeDocRef) return; // already have one

  // Find the highest existing batch index for today
  // We store docId as YYYY-MM-DD_N so we can query by prefix pattern.
  // Since Firestore has no "startsWith" query we track the index in
  // a tiny "meta" document: users/{uid}/meta/eventCursor
  const cursorRef  = doc(db, "users", uid, "meta", "eventCursor");
  const cursorSnap = await getDoc(cursorRef);

  let batchIndex = 0;
  if (cursorSnap.exists()) {
    const data = cursorSnap.data();
    if (data.date === dateStr && !forceNew) {
      batchIndex      = data.batchIndex || 0;
      activeDocCount  = data.count      || 0;
      activeDocRef    = doc(colRef, `${dateStr}_${batchIndex}`);
      return;
    }
    if (forceNew && data.date === dateStr) {
      batchIndex = (data.batchIndex || 0) + 1;
    }
  }

  // Create the new doc
  const newDocId  = `${dateStr}_${batchIndex}`;
  activeDocRef    = doc(colRef, newDocId);
  activeDocCount  = 0;

  await setDoc(activeDocRef, {
    events:    [],
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  // Update cursor
  await setDoc(cursorRef, {
    date:       dateStr,
    batchIndex: batchIndex,
    count:      0,
  });
}

// ── HELPERS ─────────────────────────────────────────────────
function todayStr() {
  return new Date().toISOString().slice(0, 10); // "2025-05-14"
}

function sanitise(obj) {
  // Keep payload small — truncate strings, drop nulls
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) continue;
    if (typeof v === "string") out[k] = v.slice(0, 120);
    else out[k] = v;
  }
  return out;
}
