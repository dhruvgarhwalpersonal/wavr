// api/proxy.js
// Your own CORS proxy — runs on Vercel's edge, zero rate limits
// Only proxies whitelisted APIs (Deezer + Last.fm) for security

export default async function handler(req, res) {
  // Allow all origins (your frontend calling your own proxy)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing url parameter' });

  // ── SECURITY: only allow these two APIs ──────────────────
  const ALLOWED = ['api.deezer.com', 'ws.audioscrobbler.com', 'itunes.apple.com', 'webservice.fanart.tv', 'musicbrainz.org'];

  let target;
  try {
    target = new URL(decodeURIComponent(url));
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  if (!ALLOWED.includes(target.hostname)) {
    return res.status(403).json({ error: `Host not allowed: ${target.hostname}` });
  }

  // ── PROXY ────────────────────────────────────────────────
  try {
    const upstream = await fetch(target.toString(), {
      headers: {
        'User-Agent': 'WAVR-Proxy/1.0',
        'Accept': 'application/json',
      },
    });

    const data = await upstream.json();

    // Cache for 60 s at edge, serve stale for 2 min while revalidating
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
    return res.status(upstream.status).json(data);

  } catch (err) {
    return res.status(500).json({ error: 'Proxy error', detail: err.message });
  }
}
