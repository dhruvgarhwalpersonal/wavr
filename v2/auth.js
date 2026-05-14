/* =========================================================
   WAVR — auth.js
   Handles Google Sign-In / Sign-Out.
   Creates the user's Firestore profile on first login.
   Fires a global "wavr:authReady" event so app.js can boot.
   ========================================================= */

import { auth, db } from "./firebase.js";
import {
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  doc,
  getDoc,
  setDoc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ── EXPORTED CURRENT USER (set once auth resolves) ─────────
export let currentUser = null;

// ── GOOGLE SIGN-IN ─────────────────────────────────────────
const provider = new GoogleAuthProvider();
provider.setCustomParameters({ prompt: "select_account" });

export async function signInWithGoogle() {
  try {
    await signInWithPopup(auth, provider);
    // onAuthStateChanged below handles the rest
  } catch (err) {
    if (err.code !== "auth/popup-closed-by-user") {
      console.error("Sign-in error:", err);
      showAuthToast("Sign-in failed. Try again.");
    }
  }
}

export async function signOutUser() {
  try {
    await signOut(auth);
  } catch (err) {
    console.error("Sign-out error:", err);
  }
}

// ── AUTH STATE LISTENER ────────────────────────────────────
onAuthStateChanged(auth, async (user) => {
  currentUser = user;

  if (user) {
    await ensureUserProfile(user);
    renderAuthUI(user);
  } else {
    renderAuthUI(null);
  }

  // Tell app.js auth is ready (fires once on page load, then on every change)
  window.dispatchEvent(new CustomEvent("wavr:authReady", { detail: { user } }));
});

// ── CREATE USER PROFILE (first login only) ─────────────────
//
// Firestore schema — one doc per concern, never > 1 MB:
//
//  users/{uid}/profile          ← name, email, photo, joinedAt
//  users/{uid}/prefs            ← theme, defaultMood, language
//  users/{uid}/stats            ← totalPlays, totalListenSec, streakDays
//  users/{uid}/events/{docId}   ← sub-collection, one doc per ~50 events
//                                  (see tracker.js for the rolling-doc logic)
//  users/{uid}/liked/{docId}    ← sub-collection, one doc per ~200 liked songs
//  users/{uid}/history/{docId}  ← sub-collection, rolling recently-played

async function ensureUserProfile(user) {
  const profileRef = doc(db, "users", user.uid, "profile", "main");
  const snap = await getDoc(profileRef);

  if (!snap.exists()) {
    // First time — create all root documents
    const batch = [
      setDoc(doc(db, "users", user.uid, "profile", "main"), {
        uid:       user.uid,
        name:      user.displayName || "WAVR User",
        email:     user.email,
        photo:     user.photoURL || "",
        joinedAt:  serverTimestamp(),
      }),

      setDoc(doc(db, "users", user.uid, "prefs", "main"), {
        theme:       "dark",
        defaultMood: null,
        language:    "en",
        updatedAt:   serverTimestamp(),
      }),

      setDoc(doc(db, "users", user.uid, "stats", "main"), {
        totalPlays:       0,
        totalListenSec:   0,
        streakDays:       0,
        lastActiveDate:   serverTimestamp(),
      }),
    ];

    await Promise.all(batch);
    console.log("WAVR: new user profile created for", user.displayName);
  }
}

// ── RENDER AUTH BUTTON IN TOPBAR ───────────────────────────
function renderAuthUI(user) {
  let btn = document.getElementById("wavr-auth-btn");
  if (!btn) return; // topbar not mounted yet (shouldn't happen)

  if (user) {
    btn.innerHTML = `
      <img
        src="${user.photoURL || ""}"
        alt="${user.displayName || "You"}"
        class="auth-avatar"
        title="${user.displayName || user.email}"
      />
      <span class="auth-name">${(user.displayName || "You").split(" ")[0]}</span>
    `;
    btn.onclick = signOutUser;
    btn.title   = "Click to sign out";
  } else {
    btn.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 48 48" style="flex-shrink:0">
        <path fill="#4285F4" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.08 17.74 9.5 24 9.5z"/>
        <path fill="#34A853" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
        <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
        <path fill="#EA4335" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.18 1.48-4.97 2.31-8.16 2.31-6.26 0-11.57-3.59-13.46-8.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
        <path fill="none" d="M0 0h48v48H0z"/>
      </svg>
      Sign in
    `;
    btn.onclick = signInWithGoogle;
    btn.title   = "Sign in with Google";
  }
}

// ── SMALL TOAST FOR AUTH ERRORS ────────────────────────────
function showAuthToast(msg) {
  // Reuse app.js showToast if available, else fallback
  if (typeof window.showToast === "function") {
    window.showToast(msg);
  } else {
    console.warn("Auth:", msg);
  }
}
