# WAVR — Personal Music Streaming App

A beautiful, fully client-side music streaming app using **Spotify + Last.fm + YouTube**.

## File Structure
```
music-app/
├── index.html     ← main UI
├── app.js         ← all API logic & playback
├── style.css      ← dark glassmorphic UI
├── config.js      ← YOUR API KEYS go here
└── README.md
```

## Setup — Get Your API Keys

### 1. Spotify
1. Go to https://developer.spotify.com/dashboard
2. Create an app (any name, any redirect URI e.g. `http://localhost`)
3. Copy **Client ID** and **Client Secret**

### 2. Last.fm
1. Go to https://www.last.fm/api/account/create
2. Create an API account (free)
3. Copy your **API Key**

### 3. YouTube Data API v3
1. Go to https://console.cloud.google.com
2. Create a project → Enable **YouTube Data API v3**
3. Credentials → Create API Key
4. (Optional) Restrict to YouTube Data API

### 4. Fill config.js
```js
const CONFIG = {
  SPOTIFY_CLIENT_ID: "paste_here",
  SPOTIFY_CLIENT_SECRET: "paste_here",
  LASTFM_API_KEY: "paste_here",
  YOUTUBE_API_KEY: "paste_here",
};
```

## Deploy (Free)

### Netlify (Easiest)
1. Go to https://netlify.com
2. Drag & drop the `music-app/` folder onto the deploy area
3. Done! You get a free `*.netlify.app` URL

### Vercel
1. Go to https://vercel.com
2. Import the folder or connect GitHub repo
3. No build settings needed — it's pure static HTML

## How It Works

```
User clicks song
  → Spotify API returns metadata (name, artist, cover image)
  → YouTube search: "[song name] [artist] official audio"
  → YouTube IFrame loads video silently (hidden)
  → Custom player UI shows Spotify artwork + controls
  → User hears the song!
```

## Features
- 🔍 Real-time search (Spotify)
- 🔥 Trending in India (Last.fm)  
- 🆕 New Releases (Spotify)
- 🎭 Mood-based playlists (Happy / Sad / Party / Chill / Focus / Energy)
- 🎤 Featured artist top tracks
- ⏯ Full player: play/pause, next/prev, progress bar, volume
- 📱 Mobile responsive

## Notes
- YouTube IFrame API requires the page to be served over HTTP/HTTPS (not `file://`). Use a local server or deploy.
- For local testing: `npx serve .` inside the `music-app/` folder
