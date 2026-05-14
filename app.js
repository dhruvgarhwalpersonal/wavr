/* =========================================================
   WAVR — app.js  (FIXED: global track playback, all languages)
   Deezer (no key) · iTunes · YouTube IFrame
   Own Vercel proxy — no rate limits, full control
   ========================================================= */

// ── STATE ──────────────────────────────────────────────────
const state = {
  currentTrack: null,
  queue: [],
  queueIndex: -1,
  ytPlayer: null,
  ytReady: false,
  isPlaying: false,
  progressInterval: null,
  searchTimeout: null,
};

// ── YOUR OWN PROXY (Vercel) ─────────────────────────────────
const PROXY = '/api/proxy?url=';

function proxyUrl(rawUrl) {
  return `${PROXY}${encodeURIComponent(rawUrl)}`;
}

// ── DEEZER ─────────────────────────────────────────────────
async function deezerFetch(endpoint) {
  const res = await fetch(proxyUrl(`https://api.deezer.com${endpoint}`));
  if (!res.ok) throw new Error(`Deezer error: ${res.status}`);
  return res.json();
}

async function searchDeezer(query, limit = 8) {
  const q = encodeURIComponent(query);
  return deezerFetch(`/search?q=${q}&limit=${limit}`);
}

async function getDeezerNewReleases() {
  return deezerFetch('/chart/0/albums?limit=12');
}

async function getDeezerArtist(artistId) {
  return deezerFetch(`/artist/${artistId}`);
}

async function getDeezerArtistTopTracks(artistId) {
  return deezerFetch(`/artist/${artistId}/top?limit=10`);
}

async function getDeezerAlbumTracks(albumId) {
  return deezerFetch(`/album/${albumId}/tracks?limit=1`);
}

// ── iTunes Search API (free, no key) ───────────────────────
async function itunesFetch(params) {
  const qs = new URLSearchParams({ ...params, media: 'music', entity: 'song', limit: 20 }).toString();
  const res = await fetch(`https://itunes.apple.com/search?${qs}`);
  if (!res.ok) throw new Error('iTunes error');
  return res.json();
}

async function itunesTopTracks(artistName) {
  const data = await itunesFetch({ term: artistName });
  return (data.results || []).map(normaliseItunes);
}

async function itunesSearch(query, limit = 12) {
  const data = await itunesFetch({ term: query, limit });
  return (data.results || []).map(normaliseItunes);
}

function normaliseItunes(t) {
  return {
    id: `itunes-${t.trackId || t.collectionId}`,
    name: t.trackName || t.collectionName || 'Unknown',
    artist: t.artistName || 'Unknown',
    cover: (t.artworkUrl100 || '').replace('100x100', '300x300'),
    duration: Math.floor((t.trackTimeMillis || 0) / 1000),
    source: 'itunes',
  };
}

// ── DEEZER CHART / MOOD / SIMILAR ──────────────────────────
async function getTrendingIndia() {
  const data = await deezerFetch('/chart/0/tracks?limit=20');
  return (data.data || []).map(normaliseDeezer);
}

async function getDeezerSimilarTracks(trackId) {
  const data = await deezerFetch(`/track/${trackId}/radio?limit=20`);
  return (data.data || []).map(normaliseDeezer);
}

const MOOD_DEEZER_QUERIES = {
  happy:  'feel good happy hits',
  sad:    'sad heartbreak songs',
  party:  'party dance hits',
  chill:  'chill lofi relax',
  focus:  'focus study instrumental',
  energy: 'workout energy power',
};

async function getDeezerMoodTracks(mood) {
  const q = MOOD_DEEZER_QUERIES[mood] || mood;
  const data = await deezerFetch(`/search?q=${encodeURIComponent(q)}&limit=20`);
  return (data.data || []).map(normaliseDeezer);
}

async function searchLastfm(query, limit = 10) {
  const data = await searchDeezer(query, limit);
  return (data.data || []).map(t => ({
    ...normaliseDeezer(t),
    _score: searchRelevance(query, t.title || t.name || ''),
  }));
}

// ══════════════════════════════════════════════════════════
//  YOUTUBE — BULLETPROOF GLOBAL SEARCH ENGINE
//  Handles: Hindi, Punjabi, Tamil, Telugu, Korean, Japanese,
//  Arabic, Spanish, French, Persian, Turkish, every dialect.
// ══════════════════════════════════════════════════════════

window.onYouTubeIframeAPIReady = () => {
  state.ytPlayer = new YT.Player('yt-frame', {
    height: '1',
    width: '1',
    videoId: '',
    playerVars: { autoplay: 1, controls: 0, playsinline: 1 },
    events: {
      onReady: () => { state.ytReady = true; },
      onStateChange: onYTStateChange,
      onError: (e) => {
        // YT error codes: 2=bad param, 5=HTML5 error, 100=not found, 101/150=embed not allowed
        console.warn('YouTube player error code:', e.data);
        const msg = e.data === 100 ? 'Video not found on YouTube'
                  : e.data === 101 || e.data === 150 ? 'This video cannot be embedded'
                  : 'YouTube playback error';
        // Fall back to Deezer preview if available
        const track = state.currentTrack;
        if (track?.preview) {
          showToast(`${msg} — switching to preview`);
          playDeezerPreview(track);
        } else if (track) {
          // Try fetching preview from Deezer
          deezerFetch(`/track/${track.id}`).then(data => {
            if (data?.preview) {
              track.preview = data.preview;
              playDeezerPreview(track);
            } else {
              showToast(msg + ' — try another track');
            }
          }).catch(() => showToast(msg + ' — try another track'));
        }
      },
    },
  });
};

function onYTStateChange(event) {
  if (event.data === YT.PlayerState.PLAYING) {
    state.isPlaying = true;
    updatePlayBtn(true);
    startProgressTracking();
  } else if (
    event.data === YT.PlayerState.PAUSED ||
    event.data === YT.PlayerState.ENDED
  ) {
    state.isPlaying = false;
    updatePlayBtn(false);
    if (event.data === YT.PlayerState.ENDED) playNext();
  }
}

// ── ARTIST NAME NORMALISER ─────────────────────────────────
// Maps known alternate spellings / transliterations so YouTube
// finds the right video even when Deezer has a different spelling.
const ARTIST_ALIASES = {
  // Indian
  'anuv jain':        ['Anuv Jain', 'Anull Jain', 'Anuj Jain'],
  'arijit singh':     ['Arijit Singh'],
  'ap dhillon':       ['AP Dhillon', 'A.P. Dhillon'],
  'diljit dosanjh':   ['Diljit Dosanjh'],
  'pritam':           ['Pritam Chakraborty', 'Pritam'],
  'vishal mishra':    ['Vishal Mishra'],
  'b praak':          ['B Praak', 'B. Praak'],
  'jubin nautiyal':   ['Jubin Nautiyal'],
  'shreya ghoshal':   ['Shreya Ghoshal'],
  'atif aslam':       ['Atif Aslam'],
  'nucleya':          ['Nucleya'],
  'king':             ['King'],
  'karan aujla':      ['Karan Aujla'],
  'imran khan':       ['Imran Khan'],
  // Korean
  'bts':              ['BTS', 'Bangtan Boys'],
  'blackpink':        ['BLACKPINK', 'Black Pink'],
  'bigbang':          ['BIGBANG', 'Big Bang'],
  // Latin
  'bad bunny':        ['Bad Bunny'],
  'j balvin':         ['J Balvin', 'J. Balvin'],
  'maluma':           ['Maluma'],
  // Global
  'the weeknd':       ['The Weeknd', 'Weeknd'],
  'drake':            ['Drake'],
  'post malone':      ['Post Malone'],
};

// Returns the best canonical form of an artist name
function canonicalArtist(name) {
  const lower = name.toLowerCase().trim();
  for (const [key, variants] of Object.entries(ARTIST_ALIASES)) {
    if (lower === key || variants.some(v => v.toLowerCase() === lower)) {
      return variants[0]; // best known form
    }
  }
  return name; // unchanged if not in map
}

// ── CLEAN TRACK NAME for YouTube query ─────────────────────
// Strips things like "(feat. X)", "[Official]", "- Remastered" etc.
// that confuse YouTube's search engine
function cleanTrackName(name) {
  return name
    .replace(/\s*[\(\[]feat\.?.*?[\)\]]/gi, '')
    .replace(/\s*[\(\[](official|audio|video|lyric|hd|hq|remaster.*?)[\)\]]/gi, '')
    .replace(/\s*-\s*(remaster|remix|version|edit|radio edit).*/gi, '')
    .trim();
}

// ── BUILD QUERY WATERFALL ──────────────────────────────────
// Generates 8 progressively looser queries.
// Tries exact → with suffixes → artist-name-only → fallbacks.
// Works for any language because we keep the native script intact.
function buildYouTubeQueries(track) {
  const rawName   = track.name   || '';
  const rawArtist = track.artist || '';
  const cleanName = cleanTrackName(rawName);
  const bestArtist = canonicalArtist(rawArtist);

  // Detect if likely Indian (Hindi / Punjabi / Tamil etc.)
  const isIndian = /singh|dosanjh|arijit|kumar|mishra|sharma|verma|khan|jain|ghoshal|nautiyal|aujla|dhillon|praak|nucleya|rahman|pritam/i
    .test(rawArtist);

  // Detect if Korean / Japanese / Chinese (has CJK chars or known artists)
  const hasCJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff66-\uff9f\uac00-\ud7af]/.test(rawName + rawArtist);

  const queries = [];

  // Tier 1 — Most precise: exact name + canonical artist + genre hint
  queries.push(`${cleanName} ${bestArtist} official audio`);
  queries.push(`${cleanName} ${bestArtist} full song`);

  // Tier 2 — With raw (original spelling) artist name if different
  if (bestArtist !== rawArtist) {
    queries.push(`${cleanName} ${rawArtist} official audio`);
    queries.push(`${cleanName} ${rawArtist} full song`);
  }

  // Tier 3 — Indian suffix variants (most Indian music on YouTube has these)
  if (isIndian) {
    queries.push(`${cleanName} ${bestArtist} lyrical video`);
    queries.push(`${cleanName} ${bestArtist} lyrics`);
    queries.push(`${rawName} ${rawArtist}`);
  }

  // Tier 4 — CJK: use original script, no suffix (YouTube handles natively)
  if (hasCJK) {
    queries.push(`${rawName} ${rawArtist}`);
    queries.push(`${rawName} MV`);
    queries.push(`${rawName} official MV`);
  }

  // Tier 5 — Universal fallbacks
  queries.push(`${cleanName} ${bestArtist}`);
  queries.push(`${rawName} ${rawArtist}`);
  queries.push(`${cleanName} official audio`);
  queries.push(`${cleanName} song`);

  // Deduplicate while preserving order
  return [...new Map(queries.map(q => [q.trim().toLowerCase(), q.trim()])).values()];
}

// ── SCORE: does this YouTube result match our track? ───────
// Prevents "Gul" (Anuv Jain) from playing some random "Gul" video.
function ytResultScore(track, snippet) {
  if (!snippet) return 0;
  const title   = (snippet.title       || '').toLowerCase();
  const channel = (snippet.channelTitle|| '').toLowerCase();

  const trackName  = cleanTrackName(track.name   || '').toLowerCase();
  const artistName = canonicalArtist(track.artist || '').toLowerCase();
  const rawArtist  = (track.artist || '').toLowerCase();

  let score = 0;

  // Track name present in title
  if (title.includes(trackName))   score += 40;
  else {
    // partial word match
    const words = trackName.split(/\s+/).filter(w => w.length > 2);
    const matched = words.filter(w => title.includes(w)).length;
    score += (matched / Math.max(words.length, 1)) * 20;
  }

  // Artist present in title or channel name
  if (title.includes(artistName) || channel.includes(artistName)) score += 30;
  else if (title.includes(rawArtist) || channel.includes(rawArtist)) score += 20;

  // Official signals
  if (/official/.test(title))         score += 10;
  if (/audio|lyric|lyrics/.test(title)) score += 5;
  if (/full song/.test(title))          score += 5;
  if (/mv|music video/.test(title))     score += 5;

  // Penalise covers, remixes, reaction videos, karaoke
  if (/cover|karaoke|reaction|tribute|instrumental only/.test(title)) score -= 25;

  return score;
}

// ── CORE YOUTUBE SEARCH — returns best videoId ─────────────
// maxResults=5 so we can score and pick the best match
async function searchYouTube(query, maxResults = 5) {
  const q = encodeURIComponent(query);
  const res = await fetch(
    `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${q}&type=video&maxResults=${maxResults}&key=${CONFIG.YOUTUBE_API_KEY}&videoCategoryId=10`
    // videoCategoryId=10 = Music — filters out non-music results globally
  );
  if (!res.ok) throw new Error(`YouTube search failed: ${res.status}`);
  const data = await res.json();
  return data.items || [];
}

// ── FIND BEST VIDEO for a track ────────────────────────────
// Runs through the query waterfall, scores all results,
// returns the videoId with the highest confidence score.
async function findBestYouTubeVideo(track) {
  const queries = buildYouTubeQueries(track);
  const SCORE_THRESHOLD = 35; // confident enough to stop searching

  let bestVideoId = null;
  let bestScore   = -1;
  let lastError   = null;

  for (const query of queries) {
    let items = [];
    try {
      items = await searchYouTube(query, 5);
    } catch (err) {
      lastError = err;
      // If it's a quota/auth error, no point trying more queries
      if (err.message?.includes('403') || err.message?.includes('400') || err.message?.includes('quota')) {
        console.warn('YouTube API error:', err.message);
        state._ytApiError = err.message;
        break;
      }
      continue; // network glitch — try next query
    }

    for (const item of items) {
      const score = ytResultScore(track, item.snippet);
      if (score > bestScore) {
        bestScore   = score;
        bestVideoId = item.id?.videoId;
      }
    }

    // Good enough — stop burning API quota
    if (bestScore >= SCORE_THRESHOLD && bestVideoId) break;
  }

  if (!bestVideoId && lastError) {
    console.warn('findBestYouTubeVideo failed:', lastError.message);
  }

  // Last resort: if we got any video at all, use it
  return bestVideoId;
}

// ── TRACK NORMALISATION ────────────────────────────────────
function normaliseDeezer(t) {
  return {
    id: String(t.id),
    name: t.title || t.name || 'Unknown',
    artist: t.artist?.name || 'Unknown',
    artistId: t.artist?.id,
    cover: t.album?.cover_medium || t.album?.cover || t.cover_medium || '',
    duration: t.duration || 0,
    preview: t.preview || '',   // ← Deezer 30s preview URL, free fallback
    source: 'deezer',
  };
}

function normaliseLastfm(t) {
  return {
    id: t.mbid || `lfm-${t.name}-${t.artist?.name || t.artist}`,
    name: t.name,
    artist: typeof t.artist === 'string' ? t.artist : t.artist?.name || 'Unknown',
    cover: t.image?.find(i => i.size === 'large')?.['#text'] || '',
    duration: parseInt(t.duration, 10) || 0,
    source: 'lastfm',
  };
}

// ── SEARCH RELEVANCE SCORING ───────────────────────────────
function searchRelevance(query, trackName) {
  const clean = s => s.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
  const qWords = clean(query).split(/\s+/).filter(w => w.length >= 2);
  const target = clean(trackName);
  if (!qWords.length) return 0;

  let matched = 0;
  for (const word of qWords) {
    if (new RegExp(`\\b${word}\\b`).test(target)) {
      matched += 1;
    } else if (target.includes(word)) {
      matched += 0.5;
    }
  }
  return matched / qWords.length;
}

async function enrichLastfmWithDeezer(tracks) {
  return tracks.filter(Boolean);
}

// ── RENDER HELPERS ─────────────────────────────────────────
function renderSkeletonCards(n = 8) {
  return Array.from({ length: n }, () => `
    <div class="track-card">
      <div class="skeleton sk-cover"></div>
      <div class="skeleton sk-text-l"></div>
      <div class="skeleton sk-text-s"></div>
    </div>
  `).join('');
}

function renderListTrack(track, index) {
  const cover = track.cover || '';
  const dur = track.duration ? fmtTime(track.duration) : '';
  return `
    <div class="list-track" onclick="handleListPlay(${index})">
      <span class="lt-num">${index + 1}</span>
      ${cover
        ? `<img class="lt-cover" src="${cover}" alt="${escHtml(track.name)}" loading="lazy" onerror="this.style.display='none'">`
        : '<div class="lt-cover skeleton"></div>'}
      <div class="lt-info">
        <div class="lt-name">${escHtml(track.name)}</div>
        <div class="lt-artist">${escHtml(track.artist)}</div>
      </div>
      ${dur ? `<span class="lt-duration">${dur}</span>` : ''}
    </div>
  `;
}

function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── QUEUE HANDLERS ─────────────────────────────────────────
let currentCardQueue = [];
let currentListQueue = [];

function handleCardPlay(idx) {
  playTrack(currentCardQueue[idx]);
  setQueue(currentCardQueue, idx);
}

function handleListPlay(idx) {
  playTrack(currentListQueue[idx]);
  setQueue(currentListQueue, idx);
}

// ══════════════════════════════════════════════════════════
//  PLAY TRACK — Full rewrite with global fallback chain:
//  1. Find best YouTube video via scored waterfall
//  2. If YouTube finds nothing → play Deezer 30s preview
//  3. If no preview → fetch it from Deezer by track ID
//  4. If all else fails → helpful error toast
// ══════════════════════════════════════════════════════════
async function playTrack(track) {
  if (!track) return;
  state.currentTrack = track;
  state._ytApiError  = null;

  const fallbackSrc = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="52" height="52"><rect fill="%23141826" width="52" height="52"/><text x="50%25" y="55%25" font-size="22" text-anchor="middle" dominant-baseline="middle" fill="%234a5070">♪</text></svg>';
  document.getElementById('player-cover').src = track.cover || fallbackSrc;
  document.getElementById('player-title').textContent  = track.name;
  document.getElementById('player-artist').textContent = track.artist;
  document.querySelectorAll('.now-playing').forEach(el => el.classList.remove('now-playing'));

  showToast(`Loading "${track.name}"…`);

  // Stop any existing preview audio
  if (previewAudio) { previewAudio.pause(); previewAudio = null; }

  try {
    // ── STEP 1: Find best YouTube video ──────────────────
    let videoId = null;
    try {
      videoId = await findBestYouTubeVideo(track);
    } catch (err) {
      console.warn('YouTube search threw:', err);
    }

    if (videoId) {
      // Wait for YT player to be ready (with 8s timeout)
      await waitForYTReady(8000);

      if (state.ytReady && state.ytPlayer) {
        state.ytPlayer.loadVideoById(videoId);
        const vol = parseInt(document.getElementById('volume-bar').value, 10);
        state.ytPlayer.setVolume(vol);
        showToast(`▶ ${track.name}`);
        updateRecommendations(track.artist, track.name);
        return;
      }
      // YT player failed to initialise — fall through to preview
      console.warn('YT player not ready after timeout, falling back to preview');
    }

    // ── STEP 2: Deezer 30s preview (already on the object) ──
    if (track.preview) {
      playDeezerPreview(track);
      return;
    }

    // ── STEP 3: Fetch preview URL from Deezer by track ID ──
    if (track.id && !track.id.startsWith('itunes-')) {
      try {
        const data = await deezerFetch(`/track/${track.id}`);
        if (data?.preview) {
          track.preview = data.preview;
          playDeezerPreview(track);
          return;
        }
      } catch {}
    }

    // ── STEP 4: Search Deezer to find track with preview ───
    try {
      const q = `${track.name} ${track.artist}`;
      const data = await searchDeezer(q, 3);
      const match = (data.data || []).find(t => t.preview);
      if (match) {
        track.preview = match.preview;
        playDeezerPreview(track);
        return;
      }
    } catch {}

    // ── STEP 5: Nothing worked ────────────────────────────
    const reason = state._ytApiError?.includes('403') || state._ytApiError?.includes('quota')
      ? 'YouTube quota exceeded — check your API key'
      : `"${track.name}" not available right now`;
    showToast(reason);

  } catch (err) {
    console.error('Playback error:', err);
    if (track.preview) {
      showToast('Switching to preview mode');
      playDeezerPreview(track);
      return;
    }
    showToast('Playback error — try another track');
  }
}

// ── Wait for YouTube IFrame player to be ready ─────────────
function waitForYTReady(timeoutMs = 8000) {
  return new Promise(resolve => {
    if (state.ytReady && state.ytPlayer) { resolve(); return; }
    const start = Date.now();
    const check = setInterval(() => {
      if (state.ytReady && state.ytPlayer) {
        clearInterval(check);
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(check);
        resolve(); // resolve anyway — caller checks state.ytReady
      }
    }, 100);
  });
}

// ── DEEZER PREVIEW PLAYER (30s fallback) ───────────────────
// Uses an <audio> element, NOT YouTube, so it's always the
// exact correct track. Shows a "preview only" badge.
let previewAudio = null;

function playDeezerPreview(track) {
  // Stop any existing preview
  if (previewAudio) {
    previewAudio.pause();
    previewAudio = null;
  }
  // Stop YouTube
  if (state.ytReady && state.ytPlayer) {
    try { state.ytPlayer.stopVideo(); } catch {}
  }

  previewAudio = new Audio(track.preview);
  previewAudio.volume = parseInt(document.getElementById('volume-bar').value, 10) / 100;
  previewAudio.play().catch(() => showToast('Preview unavailable'));

  state.isPlaying = true;
  updatePlayBtn(true);
  startPreviewTracking(previewAudio);

  previewAudio.onended = () => {
    state.isPlaying = false;
    updatePlayBtn(false);
    clearInterval(state.progressInterval);
    playNext();
  };

  showToast(`▶ ${track.name} (30s preview)`);
  updateRecommendations(track.artist, track.name);
}

function startPreviewTracking(audio) {
  clearInterval(state.progressInterval);
  state.progressInterval = setInterval(() => {
    if (!audio || audio.paused) return;
    const cur = audio.currentTime || 0;
    const dur = audio.duration   || 30;
    document.getElementById('progress-bar').value    = (cur / dur) * 100;
    document.getElementById('time-current').textContent = fmtTime(cur);
    document.getElementById('time-total').textContent   = fmtTime(dur);
  }, 500);
}

// ── OVERRIDE togglePlay to handle preview audio too ────────
function togglePlay() {
  if (previewAudio) {
    if (previewAudio.paused) {
      previewAudio.play();
      state.isPlaying = true;
      updatePlayBtn(true);
    } else {
      previewAudio.pause();
      state.isPlaying = false;
      updatePlayBtn(false);
    }
    return;
  }
  if (!state.ytPlayer || !state.ytReady) return;
  state.isPlaying ? state.ytPlayer.pauseVideo() : state.ytPlayer.playVideo();
}

// ── PROGRESS TRACKING ──────────────────────────────────────
function startProgressTracking() {
  clearInterval(state.progressInterval);
  state.progressInterval = setInterval(() => {
    if (!state.ytPlayer || !state.ytReady) return;
    const cur = state.ytPlayer.getCurrentTime?.() || 0;
    const dur = state.ytPlayer.getDuration?.()    || 0;
    if (dur > 0) {
      document.getElementById('progress-bar').value       = (cur / dur) * 100;
      document.getElementById('time-current').textContent = fmtTime(cur);
      document.getElementById('time-total').textContent   = fmtTime(dur);
    }
  }, 500);
}

function fmtTime(s) {
  const m   = Math.floor(s / 60);
  const sec = Math.floor(s % 60).toString().padStart(2, '0');
  return `${m}:${sec}`;
}

// ── CONTROLS ───────────────────────────────────────────────
function updatePlayBtn(playing) {
  document.getElementById('play-btn').innerHTML = playing ? '⏸' : '▶';
}

function playNext() {
  // Stop preview if playing
  if (previewAudio) { previewAudio.pause(); previewAudio = null; }
  if (!state.queue.length) return;
  state.queueIndex = (state.queueIndex + 1) % state.queue.length;
  playTrack(state.queue[state.queueIndex]);
}

function playPrev() {
  if (previewAudio) { previewAudio.pause(); previewAudio = null; }
  if (!state.queue.length) return;
  state.queueIndex = (state.queueIndex - 1 + state.queue.length) % state.queue.length;
  playTrack(state.queue[state.queueIndex]);
}

function setQueue(tracks, startIndex = 0) {
  state.queue      = tracks;
  state.queueIndex = startIndex;
}

// ── SEARCH ─────────────────────────────────────────────────
async function handleSearch(query) {
  const dropdown = document.getElementById('search-results-dropdown');
  if (!query.trim()) { dropdown.classList.remove('open'); return; }

  dropdown.innerHTML = '<div style="padding:14px 16px;color:var(--text3);font-size:.85rem">Searching…</div>';
  dropdown.classList.add('open');

  try {
    let scoredTracks = [];

    // 1. Deezer
    try {
      const data = await searchDeezer(query, 12);
      scoredTracks = (data.data || []).map(t => {
        const norm = normaliseDeezer(t);
        return { ...norm, _score: searchRelevance(query, norm.name) };
      });
    } catch {}

    // 2. iTunes fallback if Deezer has fewer than 3 good matches
    const goodDeezer = scoredTracks.filter(t => t._score >= 0.4);
    if (goodDeezer.length < 3) {
      try {
        const itunesTracks = await itunesSearch(query, 10);
        const seen = new Set(scoredTracks.map(t => t.name.toLowerCase()));
        for (const t of itunesTracks) {
          if (!seen.has(t.name.toLowerCase())) {
            scoredTracks.push({ ...t, _score: searchRelevance(query, t.name) });
            seen.add(t.name.toLowerCase());
          }
        }
      } catch {}
    }

    // 3. Sort by relevance
    scoredTracks.sort((a, b) => b._score - a._score);

    if (!scoredTracks.length) {
      dropdown.innerHTML = '<div style="padding:14px 16px;color:var(--text3);font-size:.85rem">No results found</div>';
      return;
    }

    dropdown.innerHTML = scoredTracks.map(t => `
      <div class="search-result-item" onclick="playFromSearch('${escHtml(t.id)}')">
        ${t.cover
          ? `<img class="sri-cover" src="${t.cover}" alt="${escHtml(t.name)}" loading="lazy">`
          : '<div class="sri-cover skeleton"></div>'}
        <div class="sri-info">
          <div class="sri-name">${escHtml(t.name)}</div>
          <div class="sri-artist">${escHtml(t.artist)}</div>
        </div>
      </div>
    `).join('');

    window._searchTracks = scoredTracks;

  } catch {
    dropdown.innerHTML = '<div style="padding:14px 16px;color:var(--accent2);font-size:.85rem">Search error — try again</div>';
  }
}

function playFromSearch(id) {
  const track = (window._searchTracks || []).find(t => t.id === id);
  if (track) {
    setQueue(window._searchTracks, (window._searchTracks || []).indexOf(track));
    playTrack(track);
  }
  document.getElementById('search-results-dropdown').classList.remove('open');
  document.getElementById('search-input').value = '';
}

// ── TRENDING IN INDIA ───────────────────────────────────────
async function loadTrendingIndia() {
  const container = document.getElementById('trending-list');
  try {
    const tracks = await getTrendingIndia();
    currentListQueue = tracks;
    container.innerHTML = tracks.map((t, i) => renderListTrack(t, i)).join('');
  } catch {
    container.innerHTML = '<p style="padding:12px;color:var(--text3);font-size:.85rem">Could not load trending</p>';
  }
}

// ── NEW RELEASES ────────────────────────────────────────────
async function loadNewReleases() {
  const container = document.getElementById('new-releases-row');
  try {
    const data = await getDeezerNewReleases();
    const albums = data.data || [];

    const tracks = await Promise.all(
      albums.slice(0, 12).map(async a => {
        try {
          const albumData = await getDeezerAlbumTracks(a.id);
          const firstTrack = albumData.data?.[0];
          if (firstTrack) {
            return {
              id: String(firstTrack.id),
              name: a.title,
              artist: a.artist?.name || 'Unknown',
              cover: a.cover_medium || a.cover || '',
              duration: firstTrack.duration || 0,
              trackTitle: firstTrack.title,
              preview: firstTrack.preview || '',
              source: 'deezer',
            };
          }
        } catch {}
        return {
          id: String(a.id),
          name: a.title,
          artist: a.artist?.name || 'Unknown',
          cover: a.cover_medium || a.cover || '',
          duration: 0,
          source: 'deezer',
        };
      })
    );

    window._newRelTracks = tracks;
    container.innerHTML = tracks.map((t, i) => `
      <div class="track-card" onclick="handleNewRelPlay(${i})">
        <div class="track-card-cover-wrap">
          ${t.cover ? `<img src="${t.cover}" alt="${escHtml(t.name)}" loading="lazy">` : ''}
        </div>
        <div class="track-card-name">${escHtml(t.name)}</div>
        <div class="track-card-artist">${escHtml(t.artist)}</div>
      </div>
    `).join('');
  } catch {
    container.innerHTML = '<p style="padding:12px;color:var(--text3);font-size:.85rem">Could not load new releases</p>';
  }
}

window.handleNewRelPlay = async (idx) => {
  const track = window._newRelTracks?.[idx];
  if (!track) return;
  try {
    const data = await searchDeezer(`${track.trackTitle || track.name} ${track.artist}`, 1);
    const first = data.data?.[0];
    if (first) {
      playTrack({ ...normaliseDeezer(first), cover: track.cover || normaliseDeezer(first).cover });
      return;
    }
  } catch {}
  playTrack(track);
};

// ── INTELLIGENT RECOMMENDATIONS ────────────────────────────
async function getSmartRecommendations(artistName, trackName) {
  try {
    const data = await searchDeezer(`${trackName} ${artistName}`, 1);
    const first = data.data?.[0];
    if (first) {
      const similar = await getDeezerSimilarTracks(first.id);
      if (similar.length >= 4) return similar;
    }
  } catch {}

  try {
    const data = await searchDeezer(artistName, 10);
    const tracks = (data.data || []).map(normaliseDeezer);
    if (tracks.length >= 4) return tracks;
  } catch {}

  try {
    const data = await deezerFetch('/chart/0/tracks?limit=12');
    return (data.data || []).map(normaliseDeezer);
  } catch {}

  return [];
}

function renderRecTracks(tracks) {
  window._recTracks = tracks;
  document.getElementById('recommended-row').innerHTML = tracks.map((t, i) => `
    <div class="track-card" onclick="handleRecPlay(${i})">
      <div class="track-card-cover-wrap">
        ${t.cover ? `<img src="${t.cover}" alt="${escHtml(t.name)}" loading="lazy">` : ''}
      </div>
      <div class="track-card-name">${escHtml(t.name)}</div>
      <div class="track-card-artist">${escHtml(t.artist)}</div>
    </div>
  `).join('');
}

async function loadRecommendations() {
  const container = document.getElementById('recommended-row');
  container.innerHTML = renderSkeletonCards(8);
  try {
    const queries = ['bollywood hits', 'punjabi pop', 'hindi romantic', 'indian pop', 'desi beats'];
    const q = queries[Math.floor(Math.random() * queries.length)];
    const data = await searchDeezer(q, 12);
    const tracks = (data.data || []).map(normaliseDeezer);
    if (!tracks.length) throw new Error('No tracks');
    renderRecTracks(tracks);
  } catch {
    document.getElementById('recommended-row').innerHTML =
      '<p style="padding:12px;color:var(--text3);font-size:.85rem">Could not load recommendations</p>';
  }
}

async function updateRecommendations(artistName, trackName) {
  const container = document.getElementById('recommended-row');
  const header = container.closest('.section')?.querySelector('.section-title');
  if (header) header.textContent = `Because you played "${trackName}"`;
  container.innerHTML = renderSkeletonCards(8);
  try {
    const tracks = await getSmartRecommendations(artistName, trackName);
    if (!tracks.length) throw new Error('no tracks');
    renderRecTracks(tracks);
  } catch {
    if (!window._recTracks?.length) {
      document.getElementById('recommended-row').innerHTML =
        '<p style="padding:12px;color:var(--text3);font-size:.85rem">Could not load recommendations</p>';
    }
  }
}

window.handleRecPlay = (idx) => {
  const tracks = window._recTracks || [];
  if (!tracks[idx]) return;
  playTrack(tracks[idx]);
  setQueue(tracks, idx);
};

// ── MOOD ───────────────────────────────────────────────────
async function playMood(mood) {
  showToast(`Loading ${mood} vibes…`);
  try {
    const tracks = await getDeezerMoodTracks(mood);
    if (!tracks.length) { showToast('No tracks for this mood'); return; }
    setQueue(tracks, 0);
    playTrack(tracks[0]);
  } catch {
    showToast('Could not load mood — try again');
  }
}

// ── FEATURED ARTISTS ───────────────────────────────────────
const FEATURED_ARTISTS = [
  'Arijit Singh',
  'A.R. Rahman',
  'Diljit Dosanjh',
  'Pritam',
  'Eminem',
  'Taylor Swift',
  'The Weeknd',
  'Coldplay',
];

const FANART_KEY = '3bccf3f4614b0b1a2f4ce1bd74f3d6c1';

async function getDeezerArtistImage(name) {
  const data = await deezerFetch(`/search/artist?q=${encodeURIComponent(name)}&limit=1`);
  const artist = data.data?.[0];
  if (artist?.picture_medium && !artist.picture_medium.includes('default_artist')) {
    return { img: artist.picture_medium, id: artist.id };
  }
  return null;
}

async function getFanartImage(name) {
  const mbRes = await fetch(
    `https://musicbrainz.org/ws/2/artist/?query=artist:${encodeURIComponent(name)}&limit=1&fmt=json`,
    { headers: { 'User-Agent': 'WAVR/1.0 (music app)' } }
  );
  if (!mbRes.ok) return null;
  const mbData = await mbRes.json();
  const mbid = mbData.artists?.[0]?.id;
  if (!mbid) return null;

  const ftRes = await fetch(`https://webservice.fanart.tv/v3/music/${mbid}?api_key=${FANART_KEY}`);
  if (!ftRes.ok) return null;
  const ftData = await ftRes.json();
  const img = ftData.artistthumb?.[0]?.url || ftData.hdmusiclogo?.[0]?.url || '';
  return img || null;
}

async function getItunesArtistImage(name) {
  const qs = new URLSearchParams({ term: name, media: 'music', entity: 'song', limit: 1, attribute: 'artistTerm' }).toString();
  const res = await fetch(`https://itunes.apple.com/search?${qs}`);
  if (!res.ok) return null;
  const data = await res.json();
  const song = data.results?.[0];
  return song?.artworkUrl100?.replace('100x100bb', '600x600bb') || null;
}

async function getArtistImage(name) {
  try {
    const deezer = await getDeezerArtistImage(name);
    if (deezer?.img) return { img: deezer.img, deezerId: deezer.id };
  } catch {}
  try {
    const fanart = await getFanartImage(name);
    if (fanart) return { img: fanart };
  } catch {}
  try {
    const itunes = await getItunesArtistImage(name);
    if (itunes) return { img: itunes };
  } catch {}
  return { img: '' };
}

async function loadArtists() {
  const container = document.getElementById('artists-row');
  container.innerHTML = FEATURED_ARTISTS.map(name => `
    <div class="artist-card" id="artist-card-${escHtml(name.replace(/\s/g,'-'))}" onclick="playArtistByName('${escHtml(name)}')">
      <div class="artist-avatar skeleton"></div>
      <div class="artist-name">${escHtml(name)}</div>
    </div>
  `).join('');

  FEATURED_ARTISTS.forEach(async name => {
    const cardId = `artist-card-${name.replace(/\s/g, '-')}`;
    const card = document.getElementById(cardId);
    if (!card) return;
    try {
      const { img, deezerId } = await getArtistImage(name);
      const avatarEl = card.querySelector('.artist-avatar');
      if (img && avatarEl) {
        const imgEl = document.createElement('img');
        imgEl.className = 'artist-avatar';
        imgEl.src = img;
        imgEl.alt = name;
        imgEl.loading = 'lazy';
        imgEl.onerror = () => {};
        avatarEl.replaceWith(imgEl);
      }
      if (deezerId) {
        card.setAttribute('onclick', `playArtist('${deezerId}')`);
      }
    } catch {}
  });
}

async function playArtistByName(name) {
  showToast(`Loading ${name} top tracks…`);
  try {
    const data = await deezerFetch(`/search/artist?q=${encodeURIComponent(name)}&limit=1`);
    const artist = data.data?.[0];
    if (artist?.id) {
      const tracks = await getDeezerArtistTopTracks(artist.id);
      const normalised = (tracks.data || []).map(normaliseDeezer);
      if (normalised.length) { setQueue(normalised, 0); playTrack(normalised[0]); return; }
    }
  } catch {}
  try {
    const tracks = await itunesTopTracks(name);
    if (!tracks.length) { showToast('No tracks found'); return; }
    setQueue(tracks, 0);
    playTrack(tracks[0]);
  } catch {
    showToast('Could not load artist — try again');
  }
}

async function playArtist(artistId) {
  showToast('Loading artist top tracks…');
  try {
    const data = await getDeezerArtistTopTracks(artistId);
    const tracks = (data.data || []).map(normaliseDeezer);
    if (!tracks.length) { showToast('No tracks found'); return; }
    setQueue(tracks, 0);
    playTrack(tracks[0]);
  } catch {
    showToast('Could not load artist — try again');
  }
}

// ── TOAST ──────────────────────────────────────────────────
let toastTimeout;
function showToast(msg) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => toast.classList.remove('show'), 2800);
}

// ── INIT ───────────────────────────────────────────────────
async function init() {
  const searchInput = document.getElementById('search-input');
  const dropdown    = document.getElementById('search-results-dropdown');

  searchInput.addEventListener('input', e => {
    clearTimeout(state.searchTimeout);
    state.searchTimeout = setTimeout(() => handleSearch(e.target.value.trim()), 350);
  });

  document.addEventListener('click', e => {
    if (!e.target.closest('#search-wrap')) dropdown.classList.remove('open');
  });

  document.getElementById('play-btn').addEventListener('click', togglePlay);
  document.getElementById('prev-btn').addEventListener('click', playPrev);
  document.getElementById('next-btn').addEventListener('click', playNext);

  document.getElementById('progress-bar').addEventListener('input', e => {
    // Handle both YouTube and preview audio seeking
    if (previewAudio) {
      const dur = previewAudio.duration || 30;
      previewAudio.currentTime = (e.target.value / 100) * dur;
      return;
    }
    if (!state.ytPlayer || !state.ytReady) return;
    const dur = state.ytPlayer.getDuration?.() || 0;
    state.ytPlayer.seekTo((e.target.value / 100) * dur, true);
  });

  document.getElementById('volume-bar').addEventListener('input', e => {
    const vol = parseInt(e.target.value, 10);
    if (previewAudio) previewAudio.volume = vol / 100;
    if (state.ytPlayer?.setVolume) state.ytPlayer.setVolume(vol);
  });

  await Promise.allSettled([
    loadTrendingIndia(),
    loadNewReleases(),
    loadRecommendations(),
    loadArtists(),
  ]);
}

document.addEventListener('DOMContentLoaded', init);
