/* =========================================================
   WAVR — firebase.js
   Central Firebase init. Import this everywhere — never
   import firebase twice or you'll get duplicate-app errors.
   ========================================================= */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth }       from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore }  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ── PASTE YOUR FIREBASE CONFIG HERE ────────────────────────
// Get it from: Firebase Console → Project Settings → Your apps → SDK setup
const firebaseConfig = {
  apiKey: "AIzaSyDVImJOY2siL0hfSjhyAy1e3JtHNVsEKVI",
  authDomain: "nether-music.firebaseapp.com",
  projectId: "nether-music",
  storageBucket: "nether-music.firebasestorage.app",
  messagingSenderId: "1098456163426",
  appId: "1:1098456163426:web:a4858ef2ce484d9d415d3b"
};
// ───────────────────────────────────────────────────────────

const app  = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db   = getFirestore(app);
