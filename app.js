/* =========================================================
   WAVR — app.js
   Deezer (no key) · Last.fm · YouTube IFrame
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
// Relative path — works automatically on any Vercel deployment
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

async function itunesSearchArtist(artistName) {
  const qs = new URLSearchParams({ term: artistName, media: 'music', entity: 'musicArtist', limit: 1 }).toString();
  const res = await fetch(`https://itunes.apple.com/search?${qs}`);
  if (!res.ok) throw new Error('iTunes artist error');
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

// ── DEEZER REPLACEMENTS FOR LAST.FM ───────────────────────

// Trending in India — Deezer India chart (genre 519 = Bollywood/Indian)
async function getTrendingIndia() {
  // Deezer chart for India: top tracks
  const data = await deezerFetch('/chart/0/tracks?limit=20');
  return (data.data || []).map(normaliseDeezer);
}

// Similar tracks via Deezer radio (seed track)
async function getDeezerSimilarTracks(trackId) {
  const data = await deezerFetch(`/track/${trackId}/radio?limit=20`);
  return (data.data || []).map(normaliseDeezer);
}

// Mood/tag tracks via Deezer genre search
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

// Search — Deezer only now (no Last.fm fallback needed)
async function searchLastfm(query, limit = 10) {
  // Replaced with extra Deezer search for more results
  const data = await searchDeezer(query, limit);
  return (data.data || []).map(t => ({
    ...normaliseDeezer(t),
    _score: searchRelevance(query, t.title || t.name || ''),
  }));
}

// ── YOUTUBE ────────────────────────────────────────────────
// NOTE: #yt-frame must NOT be display:none — that breaks the IFrame API.
window.onYouTubeIframeAPIReady = () => {
  state.ytPlayer = new YT.Player('yt-frame', {
    height: '1',
    width: '1',
    videoId: '',
    playerVars: { autoplay: 1, controls: 0, playsinline: 1 },
    events: {
      onReady: () => { state.ytReady = true; },
      onStateChange: onYTStateChange,
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

async function searchYouTube(query) {
  const q = encodeURIComponent(query);
  const res = await fetch(
    `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${q}&type=video&maxResults=1&key=${CONFIG.YOUTUBE_API_KEY}`
  );
  if (!res.ok) throw new Error('YouTube search failed');
  const data = await res.json();
  return data.items?.[0]?.id?.videoId || null;
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
// Stops "Parki Na" from matching "Parei Na Contramão" etc.
// Returns 0.0–1.0: fraction of query words found in track name.
function searchRelevance(query, trackName) {
  const clean = s => s.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
  const qWords = clean(query).split(/\s+/).filter(w => w.length >= 2);
  const target = clean(trackName);
  if (!qWords.length) return 0;

  let matched = 0;
  for (const word of qWords) {
    if (new RegExp(`\\b${word}\\b`).test(target)) {
      matched += 1;        // exact word match
    } else if (target.includes(word)) {
      matched += 0.5;      // partial match
    }
  }
  return matched / qWords.length;
}

// ── PASSTHROUGH (Deezer tracks already normalised) ─────────
async function enrichLastfmWithDeezer(tracks) {
  // Tracks are already Deezer-normalised, just return them
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

// ── PLAY TRACK ─────────────────────────────────────────────
async function playTrack(track) {
  if (!track) return;
  state.currentTrack = track;

  const fallbackSrc = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="52" height="52"><rect fill="%23141826" width="52" height="52"/><text x="50%25" y="55%25" font-size="22" text-anchor="middle" dominant-baseline="middle" fill="%234a5070">♪</text></svg>';
  document.getElementById('player-cover').src = track.cover || fallbackSrc;
  document.getElementById('player-title').textContent = track.name;
  document.getElementById('player-artist').textContent = track.artist;
  document.querySelectorAll('.now-playing').forEach(el => el.classList.remove('now-playing'));

  showToast(`Loading "${track.name}"…`);

  try {
    const queries = [
      `${track.name} ${track.artist} official audio`,
      `${track.name} ${track.artist}`,
      `${track.name} official audio`,
    ];
    let videoId = null;
    for (const q of queries) {
      videoId = await searchYouTube(q);
      if (videoId) break;
    }
    if (!videoId) { showToast('Could not find audio on YouTube'); return; }

    if (state.ytReady && state.ytPlayer) {
      state.ytPlayer.loadVideoById(videoId);
    } else {
      const check = setInterval(() => {
        if (state.ytReady && state.ytPlayer) {
          clearInterval(check);
          state.ytPlayer.loadVideoById(videoId);
        }
      }, 200);
    }

    const vol = parseInt(document.getElementById('volume-bar').value, 10);
    if (state.ytPlayer?.setVolume) state.ytPlayer.setVolume(vol);

    showToast(`▶ ${track.name}`);
    updateRecommendations(track.artist, track.name);

  } catch (err) {
    console.error('Playback error:', err);
    showToast('Playback error — try another track');
  }
}

// ── PROGRESS TRACKING ──────────────────────────────────────
function startProgressTracking() {
  clearInterval(state.progressInterval);
  state.progressInterval = setInterval(() => {
    if (!state.ytPlayer || !state.ytReady) return;
    const cur = state.ytPlayer.getCurrentTime?.() || 0;
    const dur = state.ytPlayer.getDuration?.() || 0;
    if (dur > 0) {
      document.getElementById('progress-bar').value = (cur / dur) * 100;
      document.getElementById('time-current').textContent = fmtTime(cur);
      document.getElementById('time-total').textContent = fmtTime(dur);
    }
  }, 500);
}

function fmtTime(s) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60).toString().padStart(2, '0');
  return `${m}:${sec}`;
}

// ── CONTROLS ───────────────────────────────────────────────
function updatePlayBtn(playing) {
  document.getElementById('play-btn').innerHTML = playing ? '⏸' : '▶';
}

function togglePlay() {
  if (!state.ytPlayer || !state.ytReady) return;
  state.isPlaying ? state.ytPlayer.pauseVideo() : state.ytPlayer.playVideo();
}

function playNext() {
  if (!state.queue.length) return;
  state.queueIndex = (state.queueIndex + 1) % state.queue.length;
  playTrack(state.queue[state.queueIndex]);
}

function playPrev() {
  if (!state.queue.length) return;
  state.queueIndex = (state.queueIndex - 1 + state.queue.length) % state.queue.length;
  playTrack(state.queue[state.queueIndex]);
}

function setQueue(tracks, startIndex = 0) {
  state.queue = tracks;
  state.queueIndex = startIndex;
}

// ── SEARCH ─────────────────────────────────────────────────
// 1. Deezer results scored by word-overlap with query
// 2. If good Deezer matches < 3, pull Last.fm results too
// 3. Final list sorted best-match first
// This prevents "Parki Na" being hijacked by "Parei Na Contramão"
async function handleSearch(query) {
  const dropdown = document.getElementById('search-results-dropdown');
  if (!query.trim()) { dropdown.classList.remove('open'); return; }

  dropdown.innerHTML = '<div style="padding:14px 16px;color:var(--text3);font-size:.85rem">Searching…</div>';
  dropdown.classList.add('open');

  try {
    // 1. Deezer
    let scoredTracks = [];
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
    // Find the track on Deezer to get its ID for radio
    const data = await searchDeezer(`${trackName} ${artistName}`, 1);
    const first = data.data?.[0];
    if (first) {
      const similar = await getDeezerSimilarTracks(first.id);
      if (similar.length >= 4) return similar;
    }
  } catch {}

  // Fallback: search by artist
  try {
    const data = await searchDeezer(artistName, 10);
    const tracks = (data.data || []).map(normaliseDeezer);
    if (tracks.length >= 4) return tracks;
  } catch {}

  // Last fallback: Deezer global chart
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
    // Use Deezer chart with a random genre flavour for variety
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

async function loadArtists() {
  const container = document.getElementById('artists-row');
  const results = await Promise.allSettled(
    FEATURED_ARTISTS.map(name => itunesSearchArtist(name))
  );
  container.innerHTML = results.map((res, i) => {
    const name = FEATURED_ARTISTS[i];
    let img = '';
    if (res.status === 'fulfilled') {
      const artist = res.value.results?.[0];
      // iTunes returns artworkUrl100 on song results; for artists use their artworkUrl60 or artworkUrl100
      img = artist?.artworkUrl100 || artist?.artworkUrl60 || '';
      if (img) img = img.replace('100x100bb', '300x300bb').replace('60x60bb', '300x300bb');
    }
    return `
      <div class="artist-card" onclick="playArtistByName('${escHtml(name)}')">
        ${img
          ? `<img class="artist-avatar" src="${img}" alt="${escHtml(name)}" loading="lazy" onerror="this.style.display='none'">`
          : '<div class="artist-avatar skeleton"></div>'}
        <div class="artist-name">${escHtml(name)}</div>
      </div>
    `;
  }).join('');
}

async function playArtistByName(name) {
  showToast(`Loading ${name} top tracks…`);
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
    if (!state.ytPlayer || !state.ytReady) return;
    const dur = state.ytPlayer.getDuration?.() || 0;
    state.ytPlayer.seekTo((e.target.value / 100) * dur, true);
  });

  document.getElementById('volume-bar').addEventListener('input', e => {
    if (state.ytPlayer?.setVolume) state.ytPlayer.setVolume(parseInt(e.target.value, 10));
  });

  await Promise.allSettled([
    loadTrendingIndia(),
    loadNewReleases(),
    loadRecommendations(),
    loadArtists(),
  ]);
}

document.addEventListener('DOMContentLoaded', init);
